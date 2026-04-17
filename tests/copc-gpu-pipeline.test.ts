/**
 * Tests for pure/mockable logic in copc-gpu-pipeline.ts.
 *
 * GPU device calls are mocked (vi.fn()) — no real WebGPU context needed.
 * Tests cover:
 *   - NODE_STRIDE byte layout (constant verification)
 *   - setSlotDesc / clearSlotDesc byte offsets
 *   - uploadNodeTable BFS + parent/child link resolution
 */
import { describe, expect, it, vi } from "vitest";
import {
  NODE_STRIDE,
  NO_SLOT,
  TRAVERSE_WORKGROUP_SIZE,
  uploadNodeTable,
  setSlotDesc,
  clearSlotDesc,
  uploadTilePoints,
} from "../src/copc/copc-gpu-pipeline";
import type { CopcGpuPipeline } from "../src/copc/copc-gpu-pipeline";
import type { CopcIndex, CopcNode } from "../src/copc/copc-types";
import { voxelKeyString } from "../src/copc/copc-types";

// ── Minimal mocks ─────────────────────────────────────────────────────────────

function makeDevice() {
  const writeBuffer = vi.fn();
  return {
    queue: { writeBuffer },
    _writeBuffer: writeBuffer,
  } as unknown as GPUDevice & { _writeBuffer: ReturnType<typeof vi.fn> };
}

function makePipeline(overrides: Partial<CopcGpuPipeline> = {}): CopcGpuPipeline {
  return {
    keyToId:        new Map(),
    nodes:          [],
    rootNodeIds:    [],
    maxNodes:       1000,
    maxDepth:       12,
    atlas:          { getSlot: () => -1 } as unknown as CopcGpuPipeline["atlas"],
    nodeBuffer:     {} as GPUBuffer,
    atlasPosBuffer: {} as GPUBuffer,
    atlasColorBuffer: {} as GPUBuffer,
    atlasAttrBuffer:  {} as GPUBuffer,
    workQueueA:     {} as GPUBuffer,
    workQueueB:     {} as GPUBuffer,
    queueCountBuffer:       {} as GPUBuffer,
    indirectDispatchBuffer: {} as GPUBuffer,
    drawArgsBuffer:         {} as GPUBuffer,
    selectedSlotsBuffer:    {} as GPUBuffer,
    slotDescBuffer:         {} as GPUBuffer,
    packListBuffer:         {} as GPUBuffer,
    drawCountBuffer:        {} as GPUBuffer,
    destroy: vi.fn(),
    ...overrides,
  } as CopcGpuPipeline;
}

function makeCopcNode(overrides: Partial<CopcNode> = {}): CopcNode {
  return {
    key:        { depth: 0, x: 0, y: 0, z: 0 },
    offset:     0n,
    byteSize:   1n,          // non-zero = real tile
    pointCount: 100n,
    ...overrides,
  };
}

function makeCopcIndex(nodeList: CopcNode[]): CopcIndex {
  const nodes = new Map<string, CopcNode>();
  for (const n of nodeList) nodes.set(voxelKeyString(n.key), n);
  return {
    info: {
      center: [0, 0, 0],
      halfsize: 100,
      spacing: 1,
      rootHierOffset: 0n,
      rootHierSize:   0n,
      gpsMin: 0,
      gpsMax: 0,
    },
    lasHeader: {
      pointFormat: 6,
      pointRecLen: 30,
      scaleX: 0.001, scaleY: 0.001, scaleZ: 0.001,
      offsetX: 0, offsetY: 0, offsetZ: 0,
      centroidX: 0, centroidY: 0, centroidZ: 0,
      attributeKeys: [],
    },
    nodes,
  };
}

// ── NODE_STRIDE layout ────────────────────────────────────────────────────────

describe("NODE_STRIDE layout", () => {
  it("is exactly 80 bytes", () => {
    expect(NODE_STRIDE).toBe(80);
  });

  it("covers 6 f32 bbox + error f32 + 6 u32 fields + 8 u32 children = 80 bytes", () => {
    // 7 floats (bbox×6 + error) = 28 bytes
    // 6 u32s (atlasSlot, pointCount, parent, flags, _pad × 2) = 24 bytes (actually 5 fields: atlasSlot, pointCount, parent, flags, _pad)
    // children[8] u32 = 32 bytes
    // total: 28 + 20 + 32 = 80 bytes
    const bboxAndError = 7 * 4;          // 28
    const scalarFields = 5 * 4;          // 20  (atlasSlot, pointCount, parent, flags, _pad)
    const children     = 8 * 4;          // 32
    expect(bboxAndError + scalarFields + children).toBe(80);
    expect(NODE_STRIDE).toBe(bboxAndError + scalarFields + children);
  });

  it("NODE_STRIDE is divisible by 4 (u32-aligned)", () => {
    expect(NODE_STRIDE % 4).toBe(0);
  });

  it("TRAVERSE_WORKGROUP_SIZE is 64", () => {
    expect(TRAVERSE_WORKGROUP_SIZE).toBe(64);
  });

  it("NO_SLOT sentinel is 0xFFFFFFFF", () => {
    expect(NO_SLOT).toBe(0xFFFFFFFF);
    // Must fit in u32.
    expect(NO_SLOT).toBeLessThanOrEqual(0xFFFFFFFF);
    expect(NO_SLOT).toBeGreaterThan(0);
  });
});

// ── setSlotDesc / clearSlotDesc offsets ──────────────────────────────────────

describe("setSlotDesc", () => {
  it("writes to byte offset = globalSlotIndex × 8", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    const slotDescBuffer = {} as GPUBuffer;
    pipeline.slotDescBuffer = slotDescBuffer;

    setSlotDesc(device, pipeline, 5, 1024, 512);

    expect(device._writeBuffer).toHaveBeenCalledOnce();
    const [buf, offset, data] = device._writeBuffer.mock.calls[0] as [GPUBuffer, number, Uint32Array];
    expect(buf).toBe(slotDescBuffer);
    expect(offset).toBe(5 * 8);     // 40 bytes
    expect(Array.from(data)).toEqual([1024, 512]);
  });

  it("slot 0 writes at offset 0", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    setSlotDesc(device, pipeline, 0, 0, 0);
    const [, offset] = device._writeBuffer.mock.calls[0] as [GPUBuffer, number, Uint32Array];
    expect(offset).toBe(0);
  });

  it("slot 100 writes at byte offset 800", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    setSlotDesc(device, pipeline, 100, 999, 512);
    const [, offset] = device._writeBuffer.mock.calls[0] as [GPUBuffer, number, Uint32Array];
    expect(offset).toBe(800);
  });

  it("writes firstPoint and pointCount as u32 pair", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    setSlotDesc(device, pipeline, 3, 65536, 4096);
    const [, , data] = device._writeBuffer.mock.calls[0] as [GPUBuffer, number, Uint32Array];
    expect(data[0]).toBe(65536);
    expect(data[1]).toBe(4096);
  });
});

describe("clearSlotDesc", () => {
  it("writes zeros to the same offset as setSlotDesc", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    clearSlotDesc(device, pipeline, 7);
    const [, offset, data] = device._writeBuffer.mock.calls[0] as [GPUBuffer, number, Uint32Array];
    expect(offset).toBe(7 * 8);
    expect(Array.from(data)).toEqual([0, 0]);
  });
});

// ── uploadNodeTable BFS + parent/child links ──────────────────────────────────

describe("uploadNodeTable BFS", () => {
  it("assigns nodeId 0 to root node", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    const root = makeCopcNode({ key: { depth: 0, x: 0, y: 0, z: 0 } });
    const index = makeCopcIndex([root]);

    uploadNodeTable(device, pipeline, index, 12);

    expect(pipeline.keyToId.get("0-0-0-0")).toBe(0);
    expect(pipeline.nodes[0].nodeId).toBe(0);
    expect(pipeline.rootNodeIds).toContain(0);
  });

  it("BFS enqueues child nodes and assigns increasing nodeIds", () => {
    const device = makeDevice();
    const pipeline = makePipeline();

    // Root + two children at depth 1.
    const root  = makeCopcNode({ key: { depth: 0, x: 0, y: 0, z: 0 } });
    const child0 = makeCopcNode({ key: { depth: 1, x: 0, y: 0, z: 0 } });
    const child1 = makeCopcNode({ key: { depth: 1, x: 1, y: 0, z: 0 } });
    const index = makeCopcIndex([root, child0, child1]);

    uploadNodeTable(device, pipeline, index, 12);

    expect(pipeline.nodes.length).toBe(3);
    // Root gets ID 0 (enqueued first).
    expect(pipeline.keyToId.get("0-0-0-0")).toBe(0);
    // Children get IDs 1 and 2 (order depends on BFS queue traversal).
    const child0Id = pipeline.keyToId.get("1-0-0-0");
    const child1Id = pipeline.keyToId.get("1-1-0-0");
    expect(child0Id).toBeDefined();
    expect(child1Id).toBeDefined();
    expect(new Set([child0Id, child1Id]).size).toBe(2);  // distinct IDs
  });

  it("resolves parent link from child to root", () => {
    const device = makeDevice();
    const pipeline = makePipeline();

    const root  = makeCopcNode({ key: { depth: 0, x: 0, y: 0, z: 0 } });
    const child = makeCopcNode({ key: { depth: 1, x: 0, y: 0, z: 0 } });
    const index = makeCopcIndex([root, child]);

    uploadNodeTable(device, pipeline, index, 12);

    const rootId  = pipeline.keyToId.get("0-0-0-0")!;
    const childId = pipeline.keyToId.get("1-0-0-0")!;
    expect(pipeline.nodes[childId].parentId).toBe(rootId);
  });

  it("resolves child link from root to child", () => {
    const device = makeDevice();
    const pipeline = makePipeline();

    const root  = makeCopcNode({ key: { depth: 0, x: 0, y: 0, z: 0 } });
    const child = makeCopcNode({ key: { depth: 1, x: 0, y: 0, z: 0 } });
    const index = makeCopcIndex([root, child]);

    uploadNodeTable(device, pipeline, index, 12);

    const rootId  = pipeline.keyToId.get("0-0-0-0")!;
    const childId = pipeline.keyToId.get("1-0-0-0")!;
    expect(pipeline.nodes[rootId].childIds).toContain(childId);
  });

  it("root node gets parentId = NO_SLOT", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    const root = makeCopcNode();
    const index = makeCopcIndex([root]);

    uploadNodeTable(device, pipeline, index, 12);

    expect(pipeline.nodes[0].parentId).toBe(NO_SLOT);
  });

  it("skips nodes with byteSize = 0", () => {
    const device = makeDevice();
    const pipeline = makePipeline();

    const empty = makeCopcNode({ key: { depth: 0, x: 0, y: 0, z: 0 }, byteSize: 0n });
    const index = makeCopcIndex([empty]);

    uploadNodeTable(device, pipeline, index, 12);
    expect(pipeline.nodes.length).toBe(0);
  });

  it("respects maxDepth — nodes beyond maxDepth are excluded", () => {
    const device = makeDevice();
    const pipeline = makePipeline();

    const root  = makeCopcNode({ key: { depth: 0, x: 0, y: 0, z: 0 } });
    const deep  = makeCopcNode({ key: { depth: 3, x: 0, y: 0, z: 0 } });
    const index = makeCopcIndex([root, deep]);

    uploadNodeTable(device, pipeline, index, 2);  // maxDepth = 2

    expect(pipeline.keyToId.has("3-0-0-0")).toBe(false);
    expect(pipeline.nodes.length).toBe(1);
  });

  it("calls device.queue.writeBuffer 3 times per uploadNodeTable (nodeBuffer, workQueueA, queueCountBuffer)", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    const root = makeCopcNode();
    const index = makeCopcIndex([root]);

    uploadNodeTable(device, pipeline, index, 12);

    // nodeBuffer (pass 3), workQueueA (root IDs), queueCountBuffer (wave 0 count).
    expect(device._writeBuffer).toHaveBeenCalledTimes(3);
  });

  it("geometric error = spacing / 2^depth", () => {
    const device = makeDevice();
    const pipeline = makePipeline();
    const root  = makeCopcNode({ key: { depth: 0, x: 0, y: 0, z: 0 } });
    // Depth-1 intermediate needed so BFS enqueues depth-2 children.
    const d1    = makeCopcNode({ key: { depth: 1, x: 0, y: 0, z: 0 } });
    const d2    = makeCopcNode({ key: { depth: 2, x: 0, y: 0, z: 0 } });
    const index = makeCopcIndex([root, d1, d2]);
    index.info.spacing = 4;

    uploadNodeTable(device, pipeline, index, 12);

    const rootEntry = pipeline.nodes.find((n) => n.key.depth === 0)!;
    const d2Entry   = pipeline.nodes.find((n) => n.key.depth === 2)!;
    expect(rootEntry.error).toBeCloseTo(4 / Math.pow(2, 0));   // 4
    expect(d2Entry.error).toBeCloseTo(4 / Math.pow(2, 2));     // 1
  });
});

describe("uploadTilePoints accounting", () => {
  it("caps written points to slot capacity and returns written count", () => {
    const device = makeDevice();
    const pipeline = makePipeline({
      atlasPosBuffer: {} as GPUBuffer,
      atlasColorBuffer: {} as GPUBuffer,
      atlasAttrBuffer: {} as GPUBuffer,
    });
    const written = uploadTilePoints(
      device,
      pipeline,
      {
        tierIndex: 0,
        slotInTier: 0,
        globalIndex: 0,
        firstVertex: 0,
        pointCapacity: 2,
      },
      {
        xyz: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
        attributes: [],
        count: 3,
      },
    );

    expect(written).toBe(2);
    expect(device._writeBuffer).toHaveBeenCalledTimes(3);
  });
});
