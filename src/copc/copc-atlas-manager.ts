/**
 * AtlasManager — CPU-side free-list and LRU tracker for the COPC point atlas.
 *
 * The atlas is partitioned into three tiers of fixed-size slots so that tiles
 * of varying point counts can be stored without excessive internal fragmentation:
 *
 *   Tier 0 (small)  — default 2048 slots × 512 pts  — leaf / deep nodes
 *   Tier 1 (medium) — default  512 slots × 8192 pts — mid-level nodes
 *   Tier 2 (large)  — default  200 slots × 65536 pts — root / depth-4+ tiles (many COPC nodes)
 *
 * Each tier maintains an O(1) free-list (index-stack).  LRU eviction is
 * tracked per-tier via a Map whose insertion order gives least-recently-used
 * first.  The AtlasManager never touches the GPU — all GPU writes are done in
 * copc-gpu-pipeline.ts using the slot information returned here.
 */

export interface AtlasTierConfig {
  /** Number of slots in this tier. */
  slotCount: number;
  /** Maximum points that can be stored in one slot. */
  pointsPerSlot: number;
}

// Point capacity: 2048×512 + 512×8192 + 200×65536 = 18,350,080 points.
// Atlas pos buffer ≈ 280 MB (vec4<f32> per point) — above WebGPU default
// maxBufferSize (256 MiB) and maxStorageBufferBindingSize (128 MiB).
// CopcPointCloud passes copcAtlasRequiredWebGPULimits() into WebGPURenderer
// so requestDevice() raises those limits when the adapter allows it.
export const DEFAULT_ATLAS_TIERS: AtlasTierConfig[] = [
  { slotCount: 4096, pointsPerSlot: 512 },
  { slotCount: 1024, pointsPerSlot: 8192 },
  { slotCount: 256,  pointsPerSlot: 65536 },
];

export function maxAtlasPointsPerSlot(tiers: readonly AtlasTierConfig[]): number {
  let m = 0;
  for (const t of tiers) m = Math.max(m, t.pointsPerSlot);
  return m;
}

const WEBGPU_DEFAULT_MIN_MAX_BUFFER_SIZE = 268435456;
const WEBGPU_DEFAULT_MIN_MAX_STORAGE_BUFFER_BINDING = 128 * 1024 * 1024;

export function totalAtlasPointsInTiers(tiers: readonly AtlasTierConfig[]): number {
  let n = 0;
  for (const t of tiers) n += t.slotCount * t.pointsPerSlot;
  return n;
}

export function copcAtlasPositionBufferByteSize(tiers: readonly AtlasTierConfig[]): number {
  return totalAtlasPointsInTiers(tiers) * 16;
}

export function copcAtlasRequiredWebGPULimits(tiers: readonly AtlasTierConfig[]): {
  maxBufferSize?: number;
  maxStorageBufferBindingSize?: number;
} {
  const need = copcAtlasPositionBufferByteSize(tiers);
  const out: { maxBufferSize?: number; maxStorageBufferBindingSize?: number } = {};
  if (need > WEBGPU_DEFAULT_MIN_MAX_BUFFER_SIZE) out.maxBufferSize = need;
  if (need > WEBGPU_DEFAULT_MIN_MAX_STORAGE_BUFFER_BINDING) {
    out.maxStorageBufferBindingSize = need;
  }
  return out;
}

/** A successfully allocated atlas slot. */
export interface AllocatedSlot {
  /** Index of the tier this slot belongs to (0 = small, 1 = medium, 2 = large). */
  tierIndex: number;
  /** Index of the slot within its tier (0-based). */
  slotInTier: number;
  /** Slot index across all tiers, used as the GPU-facing address. */
  globalIndex: number;
  /**
   * Index of the first point in the unified atlas position/color buffers.
   * The GPU vertex shader reads atlasPositions[vertexIndex], where vertexIndex
   * runs from firstVertex to firstVertex + pointCount - 1.
   */
  firstVertex: number;
  /** Maximum points this slot can hold (= tier's pointsPerSlot). */
  pointCapacity: number;
}

export class AtlasManager {
  readonly tiers: readonly AtlasTierConfig[];

  /** Global slot index of the first slot in each tier. */
  readonly tierGlobalOffset: readonly number[];

  /** Point index of the first point in each tier's region of the atlas buffers. */
  readonly tierVertexOffset: readonly number[];

  /** Total number of slots across all tiers. */
  readonly totalSlots: number;

  /** Total number of point slots across all tiers (size of atlas buffers in points). */
  readonly totalPoints: number;

  /** Per-tier free-list stacks (indices are within-tier slot indices). */
  private readonly freeLists: Uint32Array[];
  private readonly freeListTops: number[];

  /**
   * Per-tier LRU order: nodeId → globalSlotIndex.
   * Map insertion order is oldest-first, so eviction takes from the front.
   * One Map per tier so eviction is tier-local.
   */
  private readonly lruMaps: Map<number, number>[];

  /** globalSlotIndex → nodeId (reverse of lruMaps, for O(1) reverse lookup). */
  private readonly slotToNode = new Map<number, number>();

  /** nodeId → globalSlotIndex. */
  private readonly nodeToSlot = new Map<number, number>();

  constructor(tiers: AtlasTierConfig[] = DEFAULT_ATLAS_TIERS) {
    this.tiers = tiers;

    // Precompute tier offsets.
    const tierGlobalOffset: number[] = [];
    const tierVertexOffset: number[] = [];
    let globalOffset  = 0;
    let vertexOffset  = 0;
    for (const tier of tiers) {
      tierGlobalOffset.push(globalOffset);
      tierVertexOffset.push(vertexOffset);
      globalOffset += tier.slotCount;
      vertexOffset += tier.slotCount * tier.pointsPerSlot;
    }
    this.tierGlobalOffset = tierGlobalOffset;
    this.tierVertexOffset  = tierVertexOffset;
    this.totalSlots  = globalOffset;
    this.totalPoints = vertexOffset;

    // Initialise free-lists: all slots are free at start.
    this.freeLists    = tiers.map(t => {
      const list = new Uint32Array(t.slotCount);
      for (let i = 0; i < t.slotCount; i++) list[i] = i;
      return list;
    });
    this.freeListTops = tiers.map(t => t.slotCount); // points one past the top

    // Initialise per-tier LRU maps.
    this.lruMaps = tiers.map(() => new Map<number, number>());
  }

  // ── Slot allocation ──────────────────────────────────────────────────────

  /**
   * Allocate a slot capable of holding at least `pointCount` points.
   * Returns null if no free slot exists in any suitable tier (caller should evict first).
   */
  alloc(pointCount: number): AllocatedSlot | null {
    const tierIndex = this._pickTier(pointCount);
    if (tierIndex === -1) return null; // point count exceeds all tier capacities

    const top = this.freeListTops[tierIndex];
    if (top === 0) return null; // no free slot in this tier

    this.freeListTops[tierIndex]--;
    const slotInTier = this.freeLists[tierIndex][this.freeListTops[tierIndex]];
    return this._makeSlot(tierIndex, slotInTier);
  }

  /**
   * Free a slot by its global index, returning it to the free-list.
   * Also removes any nodeId association.
   * Call `setNodeSlot` with -1 before this to keep reverse maps consistent,
   * or use `releaseNodeSlot` which does both atomically.
   */
  free(globalIndex: number): void {
    const tierIndex  = this._tierOfGlobal(globalIndex);
    const slotInTier = globalIndex - this.tierGlobalOffset[tierIndex];

    // Remove LRU entry if present.
    const nodeId = this.slotToNode.get(globalIndex);
    if (nodeId !== undefined) {
      this.lruMaps[tierIndex].delete(nodeId);
      this.slotToNode.delete(globalIndex);
      this.nodeToSlot.delete(nodeId);
    }

    // Return to free-list.
    this.freeLists[tierIndex][this.freeListTops[tierIndex]] = slotInTier;
    this.freeListTops[tierIndex]++;
  }

  // ── Node ↔ slot association ──────────────────────────────────────────────

  /**
   * Associate a nodeId with an allocated slot and mark it as recently used.
   * Must be called after `alloc` to complete the assignment.
   */
  assignSlot(nodeId: number, slot: AllocatedSlot): void {
    this.nodeToSlot.set(nodeId, slot.globalIndex);
    this.slotToNode.set(slot.globalIndex, nodeId);
    // Inserting into the Map marks it as most-recently-used.
    this.lruMaps[slot.tierIndex].set(nodeId, slot.globalIndex);
  }

  /**
   * Release the slot currently held by nodeId, returning it to the free-list.
   * Returns the freed slot (for GPU update bookkeeping) or null if nodeId had
   * no slot.
   */
  releaseNodeSlot(nodeId: number): AllocatedSlot | null {
    const globalIndex = this.nodeToSlot.get(nodeId);
    if (globalIndex === undefined) return null;

    const tierIndex  = this._tierOfGlobal(globalIndex);
    const slotInTier = globalIndex - this.tierGlobalOffset[tierIndex];
    const slot = this._makeSlot(tierIndex, slotInTier);

    // Remove associations.
    this.lruMaps[tierIndex].delete(nodeId);
    this.slotToNode.delete(globalIndex);
    this.nodeToSlot.delete(nodeId);

    // Return to free-list.
    this.freeLists[tierIndex][this.freeListTops[tierIndex]] = slotInTier;
    this.freeListTops[tierIndex]++;

    return slot;
  }

  // ── LRU tracking ─────────────────────────────────────────────────────────

  /**
   * Mark nodeId as recently used (move to end of LRU map).
   * Call this each frame for every node that is in the LOD cut.
   */
  touch(nodeId: number): void {
    const globalIndex = this.nodeToSlot.get(nodeId);
    if (globalIndex === undefined) return;
    const tierIndex = this._tierOfGlobal(globalIndex);
    // Re-insert to move to the "most recently used" end.
    this.lruMaps[tierIndex].delete(nodeId);
    this.lruMaps[tierIndex].set(nodeId, globalIndex);
  }

  /**
   * Evict the least-recently-used loaded node in the tier that can hold
   * `pointCount` points, freeing its slot.
   * Returns the freed slot (caller must update the GPU node table to clear
   * atlasSlot for the evicted node), or null if the tier has no loaded nodes.
   *
   * The caller is responsible for ensuring the evicted nodeId is not
   * currently in-flight for a fetch (check via CopcFetchScheduler).
   */
  lruEvict(
    pointCount: number,
    skipNodeId?: (nodeId: number) => boolean,
  ): { slot: AllocatedSlot; evictedNodeId: number } | null {
    const tierIndex = this._pickTier(pointCount);
    if (tierIndex === -1) return null;

    const lru = this.lruMaps[tierIndex];
    if (lru.size === 0) return null;

    const skip = skipNodeId ?? (() => false);
    let victim: [number, number] | null = null;
    for (const [nodeId, globalIndex] of lru) {
      if (skip(nodeId)) continue;
      victim = [nodeId, globalIndex];
      break;
    }
    if (!victim) return null;

    return this._evictNode(victim[0], victim[1], tierIndex);
  }

  /**
   * Evict with density awareness - prefer keeping tiles that contribute
   * more screen-space points, not just LRU.
   */
  lruEvictWithDensity(
    pointCount: number,
    skipNodeId?: (nodeId: number) => boolean,
    getNodeScreenPoints?: (nodeId: number) => number,
  ): { slot: AllocatedSlot; evictedNodeId: number } | null {
    const tierIndex = this._pickTier(pointCount);
    if (tierIndex === -1) return null;

    const lru = this.lruMaps[tierIndex];
    if (lru.size === 0) return null;

    const skip = skipNodeId ?? (() => false);

    if (getNodeScreenPoints) {
      let victim: [number, number] | null = null;
      let minScreenPoints = Infinity;

      for (const [nodeId, globalIndex] of lru) {
        if (skip(nodeId)) continue;
        const screenPoints = getNodeScreenPoints(nodeId);
        if (screenPoints < minScreenPoints) {
          minScreenPoints = screenPoints;
          victim = [nodeId, globalIndex];
        }
      }
      if (!victim) return null;
      return this._evictNode(victim[0], victim[1], tierIndex);
    }

    let victim: [number, number] | null = null;
    for (const [nodeId, globalIndex] of lru) {
      if (skip(nodeId)) continue;
      victim = [nodeId, globalIndex];
      break;
    }
    if (!victim) return null;
    return this._evictNode(victim[0], victim[1], tierIndex);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** Returns the global slot index for nodeId, or -1 if not loaded. */
  getSlot(nodeId: number): number {
    return this.nodeToSlot.get(nodeId) ?? -1;
  }

  /** Returns the nodeId occupying globalIndex, or -1 if empty. */
  getNodeId(globalIndex: number): number {
    return this.slotToNode.get(globalIndex) ?? -1;
  }

  /** True if the tier that handles `pointCount` has at least one free slot. */
  hasFreeSlot(pointCount: number): boolean {
    const tierIndex = this._pickTier(pointCount);
    return tierIndex !== -1 && this.freeListTops[tierIndex] > 0;
  }

  /** Number of free slots in the tier that handles `pointCount`. */
  freeSlotCount(pointCount: number): number {
    const tierIndex = this._pickTier(pointCount);
    return tierIndex === -1 ? 0 : this.freeListTops[tierIndex];
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Pick the smallest tier that fits pointCount. Returns -1 if none fit. */
  private _pickTier(pointCount: number): number {
    for (let i = 0; i < this.tiers.length; i++) {
      if (pointCount <= this.tiers[i].pointsPerSlot) return i;
    }
    return -1;
  }

  /** Determine which tier a global slot index belongs to. */
  private _tierOfGlobal(globalIndex: number): number {
    for (let i = this.tiers.length - 1; i >= 0; i--) {
      if (globalIndex >= this.tierGlobalOffset[i]) return i;
    }
    return 0;
  }

  /**
   * Helper method to evict a node from a specific tier.
   */
  private _evictNode(
    nodeId: number,
    globalIndex: number,
    tierIndex: number,
  ): { slot: AllocatedSlot; evictedNodeId: number } {
    const slotInTier = globalIndex - this.tierGlobalOffset[tierIndex];
    const slot = this._makeSlot(tierIndex, slotInTier);

    this.lruMaps[tierIndex].delete(nodeId);
    this.slotToNode.delete(globalIndex);
    this.nodeToSlot.delete(nodeId);

    this.freeLists[tierIndex][this.freeListTops[tierIndex]++] = slotInTier;

    return { slot, evictedNodeId: nodeId };
  }

  /** Build an AllocatedSlot from tier + within-tier index. */
  private _makeSlot(tierIndex: number, slotInTier: number): AllocatedSlot {
    const globalIndex  = this.tierGlobalOffset[tierIndex] + slotInTier;
    const firstVertex  = this.tierVertexOffset[tierIndex] + slotInTier * this.tiers[tierIndex].pointsPerSlot;
    return {
      tierIndex,
      slotInTier,
      globalIndex,
      firstVertex,
      pointCapacity: this.tiers[tierIndex].pointsPerSlot,
    };
  }
}
