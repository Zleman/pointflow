/**
 * CopcGpuPipeline — GPU buffer allocation and data-upload layer for M15.8.
 *
 * Owns every GPUBuffer needed by the COPC LOD pipeline:
 *
 *   nodeBuffer          — flat node table (NODE_STRIDE bytes per node)
 *   atlasPosBuffer      — vec4<f32> per point across all tier slots
 *   atlasColorBuffer    — u32 (packed RGBA) per point
 *   atlasAttrBuffer     — f32 scalar attribute per point (for colorBy)
 *   workQueueA/B        — ping-pong work queues (u32 nodeIds)
 *   queueCountBuffer    — atomic counters, one per wave depth
 *   indirectDispatchBuf — indirect dispatch args (3× u32 per wave)
 *   drawArgsBuf         — DrawIndirectArgs (4× u32 per atlas slot)
 *   selectedSlotsBuf    — bitfield (ceil(totalSlots/32) u32)
 *
 * This file does NOT create shader pipelines or bind groups — those are
 * Phase 2 (WebGPUCopcScene.tsx).  Everything here is pure buffer management.
 *
 * Node table layout (NODE_STRIDE = 80 bytes, all f32/u32, no vec3 padding):
 *
 *   offset  0: bboxMinX  f32
 *   offset  4: bboxMinY  f32
 *   offset  8: bboxMinZ  f32
 *   offset 12: bboxMaxX  f32
 *   offset 16: bboxMaxY  f32
 *   offset 20: bboxMaxZ  f32
 *   offset 24: error     f32  — COPC geometric error (spacing/2 at this depth)
 *   offset 28: atlasSlot u32  — 0xFFFFFFFF = not loaded
 *   offset 32: pointCount u32
 *   offset 36: parent    u32  — 0xFFFFFFFF = root
 *   offset 40: flags     u32  — bit 0: selected this frame
 *   offset 44: _pad      u32
 *   offset 48: children  u32[8]  — child nodeIds; 0xFFFFFFFF = absent
 *   total: 80 bytes
 */

import type { CopcIndex } from "./copc-types";
import type { VoxelKey } from "./copc-types";
import { voxelKeyString, parseVoxelKeyString } from "./copc-types";
import { voxelBounds } from "./copc-frustum";
import { AtlasManager, DEFAULT_ATLAS_TIERS } from "./copc-atlas-manager";
import type { AtlasTierConfig, AllocatedSlot } from "./copc-atlas-manager";
import type { TileData } from "./copc-source";

// ── Constants ──────────────────────────────────────────────────────────────

/** Bytes per node in the GPU node table. Must match WGSL CopcGpuNode struct. */
export const NODE_STRIDE = 80;

/** Sentinel value for "no atlas slot" / "no parent" / "no child". */
export const NO_SLOT = 0xFFFFFFFF;

/** Maximum number of COPC tree nodes supported. Covers trees up to depth 12. */
const MAX_NODES = 16_384;

/** Maximum traversal depth for work-queue ping-pong (waves). */
const MAX_DEPTH = 12;

/** Workgroup size expected by traverseWave.wgsl — must stay in sync. */
export const TRAVERSE_WORKGROUP_SIZE = 64;

// ── Types ──────────────────────────────────────────────────────────────────

export interface CopcGpuPipelineConfig {
  /**
   * Atlas tier configurations — three tiers of fixed-size point slots.
   * Defaults to DEFAULT_ATLAS_TIERS if omitted.
   */
  atlasTiers?: AtlasTierConfig[];
  /**
   * Maximum number of nodes in the node table.
   * Override only for exceptionally deep trees (> MAX_NODES nodes).
   */
  maxNodes?: number;
  /**
   * Maximum traversal depth for chained indirect dispatch.
   * Override only for files deeper than MAX_DEPTH.
   */
  maxDepth?: number;
}

/**
 * Resolved node entry used to initialise the GPU node table.
 * Built from CopcIndex by buildNodeMap().
 */
export interface CpuNodeEntry {
  nodeId: number;
  key: VoxelKey;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  /** Geometric error = spacing / 2^depth (approximated from CopcInfo). */
  error: number;
  pointCount: number;
  parentId: number;
  childIds: number[];  // length 0–8
}

export interface CopcGpuPipeline {
  // ── GPU buffers ──────────────────────────────────────────────────────────
  /** Flat node table — NODE_STRIDE × maxNodes. */
  nodeBuffer: GPUBuffer;
  /** Atlas point positions — vec4<f32> × totalPoints (16 bytes/pt). */
  atlasPosBuffer: GPUBuffer;
  /** Atlas point colors — u32 (packed RGBA) × totalPoints (4 bytes/pt). */
  atlasColorBuffer: GPUBuffer;
  /** Atlas scalar attribute — f32 × totalPoints (4 bytes/pt). */
  atlasAttrBuffer: GPUBuffer;
  /** Ping-pong work queue A — u32 × maxNodes. */
  workQueueA: GPUBuffer;
  /** Ping-pong work queue B — u32 × maxNodes. */
  workQueueB: GPUBuffer;
  /** Atomic wave counters — u32 × (maxDepth + 1). STORAGE | COPY_DST. */
  queueCountBuffer: GPUBuffer;
  /** Indirect dispatch args — u32[3] × maxDepth. INDIRECT | STORAGE | COPY_DST. */
  indirectDispatchBuffer: GPUBuffer;
  /** Draw indirect args — u32[4] × totalSlots. INDIRECT | STORAGE | COPY_DST. */
  drawArgsBuffer: GPUBuffer;
  /** Selected-slots bitfield — u32 × ceil(totalSlots / 32). STORAGE | COPY_DST. */
  selectedSlotsBuffer: GPUBuffer;
  /**
   * Per-slot descriptor for the compaction pass — u32[2] × totalSlots:
   *   [0]: firstPoint  — index of first point in atlas buffers
   *   [1]: pointCount  — actual number of valid points (≤ tier.pointsPerSlot)
   * Updated via writeBuffer on tile upload / eviction.
   */
  slotDescBuffer: GPUBuffer;
  /**
   * Packed draw list for multiDrawIndirect — DrawIndirectArgs × totalSlots.
   * Written by the pack pass (copc-pack-draw-list.wgsl); contains only the
   * non-zero entries from drawArgsBuffer in dense order.
   * INDIRECT | STORAGE | COPY_DST.
   */
  packListBuffer: GPUBuffer;
  /**
   * Draw count for multiDrawIndirect — single atomic u32.
   * Reset to 0 each frame before the pack dispatch; read by the render pass.
   * INDIRECT | STORAGE | COPY_DST.
   */
  drawCountBuffer: GPUBuffer;

  // ── CPU state ────────────────────────────────────────────────────────────
  /** Atlas free-list + LRU manager. */
  atlas: AtlasManager;
  /** VoxelKey string → integer nodeId. Built by buildNodeMap(). */
  keyToId: Map<string, number>;
  /** nodeId → CpuNodeEntry. */
  nodes: CpuNodeEntry[];
  /** Integer nodeIds of root nodes (depth 0). */
  rootNodeIds: number[];

  readonly maxNodes: number;
  readonly maxDepth: number;

  destroy(): void;
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createCopcGpuPipeline(
  device: GPUDevice,
  config: CopcGpuPipelineConfig = {},
): CopcGpuPipeline {
  const tiers    = config.atlasTiers ?? DEFAULT_ATLAS_TIERS;
  const maxNodes = config.maxNodes   ?? MAX_NODES;
  const maxDepth = config.maxDepth   ?? MAX_DEPTH;
  const atlas    = new AtlasManager(tiers);

  const STO = GPUBufferUsage.STORAGE;
  const DST = GPUBufferUsage.COPY_DST;
  const SRC = GPUBufferUsage.COPY_SRC;
  const IND = GPUBufferUsage.INDIRECT;

  // Node table.
  const nodeBuffer = device.createBuffer({
    size:  maxNodes * NODE_STRIDE,
    usage: STO | DST | SRC,
    label: "copc-node-table",
  });

  // Atlas position buffer: vec4<f32> = 16 bytes per point.
  const atlasPosBuffer = device.createBuffer({
    size:  atlas.totalPoints * 16,
    usage: STO | DST,
    label: "copc-atlas-pos",
  });

  // Atlas color buffer: u32 packed RGBA = 4 bytes per point.
  const atlasColorBuffer = device.createBuffer({
    size:  Math.max(atlas.totalPoints * 4, 4),
    usage: STO | DST,
    label: "copc-atlas-color",
  });

  // Atlas scalar attribute buffer: f32 = 4 bytes per point.
  const atlasAttrBuffer = device.createBuffer({
    size:  Math.max(atlas.totalPoints * 4, 4),
    usage: STO | DST,
    label: "copc-atlas-attr",
  });

  // Ping-pong work queues.
  const workQueueA = device.createBuffer({
    size:  maxNodes * 4,
    usage: STO | DST,
    label: "copc-work-queue-a",
  });
  const workQueueB = device.createBuffer({
    size:  maxNodes * 4,
    usage: STO | DST,
    label: "copc-work-queue-b",
  });

  // Wave counters: (maxDepth + 1) u32 atomics.
  // Padded to 16 bytes minimum (WebGPU buffer size must be ≥ 4).
  const queueCountBuffer = device.createBuffer({
    size:  Math.max((maxDepth + 1) * 4, 16),
    usage: STO | DST | SRC,
    label: "copc-queue-count",
  });

  // Indirect dispatch args: 3 u32 per wave × maxDepth.
  const indirectDispatchBuffer = device.createBuffer({
    size:  maxDepth * 12,   // 3 × u32 × maxDepth
    usage: IND | STO | DST,
    label: "copc-indirect-dispatch",
  });

  // Draw indirect args: 4 u32 per slot (vertexCount, instanceCount, firstVertex, firstInstance).
  const drawArgsBuffer = device.createBuffer({
    size:  atlas.totalSlots * 16,
    usage: IND | STO | DST | SRC,
    label: "copc-draw-args",
  });

  // Selected-slots bitfield: one bit per slot, rounded up to u32 boundaries.
  const bitfieldU32Count = Math.ceil(atlas.totalSlots / 32);
  const selectedSlotsBuffer = device.createBuffer({
    size:  Math.max(bitfieldU32Count * 4, 4),
    usage: STO | DST | SRC,
    label: "copc-selected-slots",
  });

  // Slot descriptor buffer: (firstPoint u32, pointCount u32) per slot.
  const slotDescBuffer = device.createBuffer({
    size:  Math.max(atlas.totalSlots * 8, 8),
    usage: STO | DST,
    label: "copc-slot-desc",
  });

  // Packed draw list: one DrawIndirectArgs per slot (worst case all selected).
  const packListBuffer = device.createBuffer({
    size:  Math.max(atlas.totalSlots * 16, 16),
    usage: IND | STO | DST,
    label: "copc-pack-list",
  });

  // Draw count: single atomic u32 written by pack pass, consumed by multiDrawIndirect.
  const drawCountBuffer = device.createBuffer({
    size:  4,
    usage: IND | STO | DST,
    label: "copc-draw-count",
  });

  return {
    nodeBuffer,
    atlasPosBuffer,
    atlasColorBuffer,
    atlasAttrBuffer,
    workQueueA,
    workQueueB,
    queueCountBuffer,
    indirectDispatchBuffer,
    drawArgsBuffer,
    selectedSlotsBuffer,
    slotDescBuffer,
    packListBuffer,
    drawCountBuffer,
    atlas,
    keyToId:     new Map(),
    nodes:       [],
    rootNodeIds: [],
    maxNodes,
    maxDepth,
    destroy() {
      nodeBuffer.destroy();
      atlasPosBuffer.destroy();
      atlasColorBuffer.destroy();
      atlasAttrBuffer.destroy();
      workQueueA.destroy();
      workQueueB.destroy();
      queueCountBuffer.destroy();
      indirectDispatchBuffer.destroy();
      drawArgsBuffer.destroy();
      selectedSlotsBuffer.destroy();
      slotDescBuffer.destroy();
      packListBuffer.destroy();
      drawCountBuffer.destroy();
    },
  };
}

// ── Slot descriptor updates ───────────────────────────────────────────────

/**
 * Update the per-slot descriptor (firstPoint, pointCount) in the GPU buffer.
 * Called after uploadTilePoints so the compaction shader knows the atlas layout.
 */
export function setSlotDesc(
  device: GPUDevice,
  pipeline: CopcGpuPipeline,
  globalSlotIndex: number,
  firstPoint: number,
  pointCount: number,
): void {
  const data = new Uint32Array([firstPoint, pointCount]);
  device.queue.writeBuffer(pipeline.slotDescBuffer, globalSlotIndex * 8, data);
}

/**
 * Clear the slot descriptor to (0, 0) — used when a tile is evicted.
 */
export function clearSlotDesc(
  device: GPUDevice,
  pipeline: CopcGpuPipeline,
  globalSlotIndex: number,
): void {
  const data = new Uint32Array([0, 0]);
  device.queue.writeBuffer(pipeline.slotDescBuffer, globalSlotIndex * 8, data);
}

// ── Node table initialisation ─────────────────────────────────────────────

/**
 * Build the CPU node map and upload the full node table to the GPU.
 *
 * Called once per COPC file load.  Iterates the CopcIndex, assigns a stable
 * integer nodeId to every node, computes world-space bboxes and geometric
 * errors, resolves parent/child links, and writes the node table to the GPU
 * via writeBuffer.
 *
 * The pipeline's keyToId, nodes, and rootNodeIds are populated in-place.
 */
export function uploadNodeTable(
  device: GPUDevice,
  pipeline: CopcGpuPipeline,
  index: CopcIndex,
  maxDepth = 12,
): void {
  const { info } = index;
  const keyToId = pipeline.keyToId;
  keyToId.clear();
  pipeline.nodes.length  = 0;
  pipeline.rootNodeIds.length = 0;

  // ── Pass 1: assign nodeIds in BFS order (root first = lower IDs) ──────
  const bfsQueue: VoxelKey[] = [{ depth: 0, x: 0, y: 0, z: 0 }];
  let head = 0;

  while (head < bfsQueue.length) {
    const key = bfsQueue[head++];
    const ks  = voxelKeyString(key);
    if (!index.nodes.has(ks)) continue;

    const node = index.nodes.get(ks)!;
    if (node.byteSize === 0n) continue;
    if (key.depth > maxDepth) continue;
    if (keyToId.has(ks)) continue;  // already assigned

    const nodeId = pipeline.nodes.length;
    if (nodeId >= pipeline.maxNodes) {
      console.warn("[CopcGpuPipeline] maxNodes exceeded — truncating tree at", nodeId);
      break;
    }

    keyToId.set(ks, nodeId);

    // Compute world-space AABB.
    const [minX, minY, minZ, maxX, maxY, maxZ] = voxelBounds(key, info);

    // Geometric error: COPC spacing divided by 2^depth gives the point spacing
    // at this level.  The rendering LOD metric compares this against screen pixels.
    const error = info.spacing / Math.pow(2, key.depth);

    const pointCount = node.pointCount === -1n ? 0 : Number(node.pointCount);

    pipeline.nodes.push({
      nodeId,
      key,
      bboxMin:    [minX, minY, minZ],
      bboxMax:    [maxX, maxY, maxZ],
      error,
      pointCount,
      parentId:   NO_SLOT,  // resolved in Pass 2
      childIds:   [],       // resolved in Pass 2
    });

    if (key.depth === 0) pipeline.rootNodeIds.push(nodeId);

    // Enqueue children.
    if (key.depth < maxDepth) {
      for (let cx = 0; cx <= 1; cx++) {
        for (let cy = 0; cy <= 1; cy++) {
          for (let cz = 0; cz <= 1; cz++) {
            bfsQueue.push({ depth: key.depth + 1, x: key.x * 2 + cx, y: key.y * 2 + cy, z: key.z * 2 + cz });
          }
        }
      }
    }
  }

  // ── Pass 2: resolve parent/child links ───────────────────────────────
  for (const entry of pipeline.nodes) {
    const { key } = entry;
    if (key.depth === 0) { entry.parentId = NO_SLOT; continue; }

    const parentKey: VoxelKey = {
      depth: key.depth - 1,
      x: Math.floor(key.x / 2),
      y: Math.floor(key.y / 2),
      z: Math.floor(key.z / 2),
    };
    const parentId = keyToId.get(voxelKeyString(parentKey));
    entry.parentId = parentId ?? NO_SLOT;

    if (parentId !== undefined) {
      pipeline.nodes[parentId].childIds.push(entry.nodeId);
    }
  }

  // ── Pass 3: write GPU node table ──────────────────────────────────────
  const buf = new ArrayBuffer(pipeline.nodes.length * NODE_STRIDE);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);

  for (const entry of pipeline.nodes) {
    const base32 = (entry.nodeId * NODE_STRIDE) / 4;  // f32/u32 index

    // bbox (6 f32)
    f32[base32 + 0] = entry.bboxMin[0];
    f32[base32 + 1] = entry.bboxMin[1];
    f32[base32 + 2] = entry.bboxMin[2];
    f32[base32 + 3] = entry.bboxMax[0];
    f32[base32 + 4] = entry.bboxMax[1];
    f32[base32 + 5] = entry.bboxMax[2];
    // error
    f32[base32 + 6] = entry.error;
    const preserved = pipeline.atlas.getSlot(entry.nodeId);
    u32[base32 + 7] = preserved >= 0 ? preserved >>> 0 : NO_SLOT;
    // pointCount
    u32[base32 + 8] = entry.pointCount;
    // parent
    u32[base32 + 9] = entry.parentId;
    // flags
    u32[base32 + 10] = 0;
    // _pad
    u32[base32 + 11] = 0;
    // children[0..7] — fill present children, rest NO_SLOT
    for (let c = 0; c < 8; c++) {
      u32[base32 + 12 + c] = entry.childIds[c] ?? NO_SLOT;
    }
  }

  device.queue.writeBuffer(pipeline.nodeBuffer, 0, buf, 0, pipeline.nodes.length * NODE_STRIDE);

  // Write root node IDs to workQueueA[0..n-1] and queueCount[0] = numRoots.
  // The traversal shader reads these each frame to kick off wave 0.
  const rootBuf = new Uint32Array(pipeline.rootNodeIds);
  device.queue.writeBuffer(pipeline.workQueueA, 0, rootBuf);
  const countBuf = new Uint32Array(pipeline.maxDepth + 1);
  countBuf[0] = pipeline.rootNodeIds.length;
  device.queue.writeBuffer(pipeline.queueCountBuffer, 0, countBuf);
}

// ── Per-tile uploads ──────────────────────────────────────────────────────

/**
 * Write decoded tile point data into an atlas slot's region of the GPU buffers.
 *
 * `slot.firstVertex` is the unified atlas point index from AtlasManager (tier base +
 * slotInTier * pointsPerSlot). Byte offsets use *16 / *4 for pos/color/attr respectively,
 * matching compact pass `firstPoint` in slotDesc and drawArgs `firstVertex = firstPoint * 6`.
 *
 * `tile.xyz` must be absolute LAS coordinates (scale*int+offset). This function subtracts
 * `worldOrigin` (CopcInfo.center) once so atlas matches traversal node AABBs in origin-relative space.
 *
 * Points are written as:
 *   atlasPosBuffer:   vec4<f32> = [x, y, z, 1.0]   (16 bytes/pt)
 *   atlasColorBuffer: u32 packed RGBA              (4 bytes/pt)
 *   atlasAttrBuffer:  f32 scalar (first attribute)  (4 bytes/pt)
 *
 * The caller is responsible for ensuring tile.count ≤ slot.pointCapacity.
 */
export function uploadTilePoints(
  device: GPUDevice,
  pipeline: CopcGpuPipeline,
  slot: AllocatedSlot,
  tile: TileData,
  colorByKey?: string,
  worldOrigin?: readonly [number, number, number],
): number {
  const count = Math.min(tile.count, slot.pointCapacity);
  if (count === 0) return 0;

  const posScratch  = new Float32Array(count * 4);
  const colorScratch = new Uint32Array(count);
  const attrScratch  = new Float32Array(count);

  const ox = worldOrigin?.[0] ?? 0;
  const oy = worldOrigin?.[1] ?? 0;
  const oz = worldOrigin?.[2] ?? 0;

  const isRgb = colorByKey === "rgb";
  const isClassification = colorByKey === "classification";
  const redCh   = isRgb ? tile.attributes.find(a => a.key === "red")   : null;
  const greenCh = isRgb ? tile.attributes.find(a => a.key === "green") : null;
  const blueCh  = isRgb ? tile.attributes.find(a => a.key === "blue")  : null;
  const classCh = isClassification ? tile.attributes.find(a => a.key === "classification") : null;
  const attrCh  = !isRgb && !isClassification
    ? (colorByKey
        ? tile.attributes.find(a => a.key === colorByKey)
        : tile.attributes[0])
    : null;

  for (let i = 0; i < count; i++) {
    posScratch[i * 4]     = tile.xyz[i * 3]     - ox;
    posScratch[i * 4 + 1] = tile.xyz[i * 3 + 1] - oy;
    posScratch[i * 4 + 2] = tile.xyz[i * 3 + 2] - oz;
    posScratch[i * 4 + 3] = 1.0;

    if (isRgb) {
      const r = redCh   ? Math.floor(redCh.values[i]   * 255) & 0xFF : 0;
      const g = greenCh ? Math.floor(greenCh.values[i] * 255) & 0xFF : 0;
      const b = blueCh  ? Math.floor(blueCh.values[i]  * 255) & 0xFF : 0;
      colorScratch[i] = (0xFF << 24) | (b << 16) | (g << 8) | r;
    } else if (isClassification) {
      const cls = classCh ? Math.floor(classCh.values[i]) & 0xFF : 0;
      colorScratch[i] = (0xFF << 24) | cls;
    } else {
      colorScratch[i] = 0xFFFFFFFF;
    }

    attrScratch[i] = attrCh ? attrCh.values[i] : 0.0;
  }

  const posOffset   = slot.firstVertex * 16;
  const colorOffset = slot.firstVertex * 4;
  const attrOffset  = slot.firstVertex * 4;

  device.queue.writeBuffer(pipeline.atlasPosBuffer,   posOffset,   posScratch);
  device.queue.writeBuffer(pipeline.atlasColorBuffer, colorOffset, new Uint8Array(colorScratch.buffer));
  device.queue.writeBuffer(pipeline.atlasAttrBuffer,  attrOffset,  attrScratch);
  return count;
}

// ── Node table field updates ──────────────────────────────────────────────

/**
 * Update only the atlasSlot field for a single node (4 bytes).
 * Use NO_SLOT to mark the node as unloaded.
 */
export function setNodeAtlasSlot(
  device: GPUDevice,
  pipeline: CopcGpuPipeline,
  nodeId: number,
  globalSlotIndex: number,
): void {
  const offset = nodeId * NODE_STRIDE + 28;  // atlasSlot is at byte 28
  const data = new Uint32Array([globalSlotIndex]);
  device.queue.writeBuffer(pipeline.nodeBuffer, offset, data);
}

// ── Atlas allocation helpers ───────────────────────────────────────────────

/**
 * Attempt to allocate a slot for the given tile, evicting the LRU slot if
 * necessary.  Returns the allocated slot, or null if the tile exceeds all tier
 * capacities (too large to store in the atlas).
 *
 * When eviction occurs, the GPU node table is updated to clear the evicted
 * node's atlasSlot field automatically.
 *
 * @param inFlight  Set of VoxelKey strings currently being fetched — eviction
 *                  will not select nodes whose tiles are in-flight.
 */
export function allocSlotForTile(
  device: GPUDevice,
  pipeline: CopcGpuPipeline,
  nodeId: number,
  pointCount: number,
  inFlight: ReadonlySet<string>,
): AllocatedSlot | null {
  const { atlas } = pipeline;

  const skipEviction = (evictNodeId: number) => {
    const entry = pipeline.nodes[evictNodeId];
    if (!entry) return true;
    return inFlight.has(voxelKeyString(entry.key));
  };

  if (atlas.hasFreeSlot(pointCount)) {
    const slot = atlas.alloc(pointCount)!;
    atlas.assignSlot(nodeId, slot);
    setNodeAtlasSlot(device, pipeline, nodeId, slot.globalIndex);
    atlas.touch(nodeId);
    return slot;
  }

  const lruResult = atlas.lruEvict(pointCount, skipEviction);
  if (!lruResult) return null;

  const { slot: evictedSlot, evictedNodeId } = lruResult;

  setNodeAtlasSlot(device, pipeline, evictedNodeId, NO_SLOT);

  atlas.assignSlot(nodeId, evictedSlot);
  setNodeAtlasSlot(device, pipeline, nodeId, evictedSlot.globalIndex);
  atlas.touch(nodeId);
  return evictedSlot;
}
