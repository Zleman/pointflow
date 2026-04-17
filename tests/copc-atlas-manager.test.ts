/**
 * Unit tests for AtlasManager — CPU-side free-list + LRU tracker.
 *
 * No GPU dependency: AtlasManager is pure TypeScript.
 * Uses two small synthetic tiers for deterministic slot arithmetic:
 *
 *   Tier 0: 3 slots × 10 pts  — globalIndices 0..2, firstVertex 0,10,20
 *   Tier 1: 2 slots × 100 pts — globalIndices 3..4, firstVertex 30,130
 */
import { describe, expect, it } from "vitest";
import {
  AtlasManager,
  DEFAULT_ATLAS_TIERS,
  copcAtlasPositionBufferByteSize,
  copcAtlasRequiredWebGPULimits,
  maxAtlasPointsPerSlot,
  totalAtlasPointsInTiers,
} from "../src/copc/copc-atlas-manager";
import type { AtlasTierConfig } from "../src/copc/copc-atlas-manager";

// ── Two-tier test fixture ─────────────────────────────────────────────────────

const TEST_TIERS: AtlasTierConfig[] = [
  { slotCount: 3, pointsPerSlot: 10 },
  { slotCount: 2, pointsPerSlot: 100 },
];

function makeAtlas() {
  return new AtlasManager(TEST_TIERS);
}

// ── Utility functions ─────────────────────────────────────────────────────────

describe("atlas utility functions", () => {
  it("totalAtlasPointsInTiers sums slotCount × pointsPerSlot", () => {
    expect(totalAtlasPointsInTiers(TEST_TIERS)).toBe(3 * 10 + 2 * 100); // 230
  });

  it("copcAtlasPositionBufferByteSize = totalPoints × 16", () => {
    expect(copcAtlasPositionBufferByteSize(TEST_TIERS)).toBe(230 * 16);
  });

  it("maxAtlasPointsPerSlot returns the largest pointsPerSlot", () => {
    expect(maxAtlasPointsPerSlot(TEST_TIERS)).toBe(100);
  });

  it("copcAtlasRequiredWebGPULimits returns empty object when below defaults", () => {
    // TEST_TIERS produces a tiny buffer — no limit overrides needed.
    const limits = copcAtlasRequiredWebGPULimits(TEST_TIERS);
    expect(limits.maxBufferSize).toBeUndefined();
    expect(limits.maxStorageBufferBindingSize).toBeUndefined();
  });

  it("DEFAULT_ATLAS_TIERS has 3 tiers with increasing pointsPerSlot", () => {
    expect(DEFAULT_ATLAS_TIERS).toHaveLength(3);
    for (let i = 1; i < DEFAULT_ATLAS_TIERS.length; i++) {
      expect(DEFAULT_ATLAS_TIERS[i].pointsPerSlot).toBeGreaterThan(
        DEFAULT_ATLAS_TIERS[i - 1].pointsPerSlot,
      );
    }
  });
});

// ── Constructor / layout ──────────────────────────────────────────────────────

describe("AtlasManager constructor", () => {
  it("totalSlots equals sum of slotCounts", () => {
    const atlas = makeAtlas();
    expect(atlas.totalSlots).toBe(5); // 3 + 2
  });

  it("totalPoints equals sum of slotCount × pointsPerSlot", () => {
    const atlas = makeAtlas();
    expect(atlas.totalPoints).toBe(230);
  });

  it("tierGlobalOffset is [0, 3]", () => {
    const atlas = makeAtlas();
    expect(atlas.tierGlobalOffset).toEqual([0, 3]);
  });

  it("tierVertexOffset is [0, 30]", () => {
    const atlas = makeAtlas();
    expect(atlas.tierVertexOffset).toEqual([0, 30]);
  });

  it("all slots are free initially", () => {
    const atlas = makeAtlas();
    expect(atlas.freeSlotCount(1)).toBe(3);   // tier 0
    expect(atlas.freeSlotCount(10)).toBe(3);  // tier 0 (exactly at capacity)
    expect(atlas.freeSlotCount(11)).toBe(2);  // tier 1
    expect(atlas.freeSlotCount(100)).toBe(2); // tier 1
  });
});

// ── alloc ─────────────────────────────────────────────────────────────────────

describe("alloc", () => {
  it("small point count routes to tier 0", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(5);
    expect(slot).not.toBeNull();
    expect(slot!.tierIndex).toBe(0);
    expect(slot!.pointCapacity).toBe(10);
  });

  it("large point count routes to tier 1", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(50);
    expect(slot).not.toBeNull();
    expect(slot!.tierIndex).toBe(1);
    expect(slot!.pointCapacity).toBe(100);
  });

  it("point count exactly at tier capacity routes to that tier", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(10);
    expect(slot!.tierIndex).toBe(0);
  });

  it("point count exceeding all tiers returns null", () => {
    const atlas = makeAtlas();
    expect(atlas.alloc(101)).toBeNull();
  });

  it("returns null when tier is exhausted", () => {
    const atlas = makeAtlas();
    // Exhaust tier 0 (3 slots).
    for (let i = 0; i < 3; i++) expect(atlas.alloc(1)).not.toBeNull();
    expect(atlas.alloc(1)).toBeNull();
  });

  it("alloc reduces freeSlotCount by 1", () => {
    const atlas = makeAtlas();
    const before = atlas.freeSlotCount(1);
    atlas.alloc(1);
    expect(atlas.freeSlotCount(1)).toBe(before - 1);
  });

  it("slot globalIndex is within the correct tier range", () => {
    const atlas = makeAtlas();
    // Tier 0 global indices: 0..2
    for (let i = 0; i < 3; i++) {
      const slot = atlas.alloc(1)!;
      expect(slot.globalIndex).toBeGreaterThanOrEqual(0);
      expect(slot.globalIndex).toBeLessThan(3);
    }
    // Tier 1 global indices: 3..4
    for (let i = 0; i < 2; i++) {
      const slot = atlas.alloc(50)!;
      expect(slot.globalIndex).toBeGreaterThanOrEqual(3);
      expect(slot.globalIndex).toBeLessThan(5);
    }
  });

  it("slot firstVertex matches tier vertex layout", () => {
    // With TEST_TIERS: tier-0 slot N has firstVertex = N×10; tier-1 slot N has firstVertex = 30 + N×100.
    const atlas = makeAtlas();
    const seen = new Set<number>();
    for (let i = 0; i < 3; i++) {
      const slot = atlas.alloc(1)!;
      expect(slot.firstVertex % 10).toBe(0);          // multiple of pointsPerSlot
      expect(slot.firstVertex).toBeLessThan(30);       // inside tier 0 region
      seen.add(slot.firstVertex);
    }
    expect(seen.size).toBe(3); // all distinct
  });

  it("allocating all slots returns distinct globalIndices", () => {
    const atlas = makeAtlas();
    const indices = new Set<number>();
    for (let i = 0; i < 3; i++) indices.add(atlas.alloc(1)!.globalIndex);
    for (let i = 0; i < 2; i++) indices.add(atlas.alloc(50)!.globalIndex);
    expect(indices.size).toBe(5);
  });
});

// ── assignSlot / getSlot / getNodeId ─────────────────────────────────────────

describe("assignSlot and lookups", () => {
  it("getSlot returns -1 before assignment", () => {
    const atlas = makeAtlas();
    expect(atlas.getSlot(99)).toBe(-1);
  });

  it("getNodeId returns -1 for unoccupied slot", () => {
    const atlas = makeAtlas();
    expect(atlas.getNodeId(0)).toBe(-1);
  });

  it("after assignSlot, getSlot returns correct globalIndex", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(42, slot);
    expect(atlas.getSlot(42)).toBe(slot.globalIndex);
  });

  it("after assignSlot, getNodeId returns correct nodeId", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(42, slot);
    expect(atlas.getNodeId(slot.globalIndex)).toBe(42);
  });
});

// ── free ──────────────────────────────────────────────────────────────────────

describe("free", () => {
  it("freeing a slot makes it available for re-allocation", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    const g = slot.globalIndex;
    atlas.assignSlot(7, slot);
    atlas.free(g);
    const slot2 = atlas.alloc(1)!;
    expect(slot2.globalIndex).toBe(g);
  });

  it("free clears node association", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(7, slot);
    atlas.free(slot.globalIndex);
    expect(atlas.getSlot(7)).toBe(-1);
    expect(atlas.getNodeId(slot.globalIndex)).toBe(-1);
  });

  it("freeing increases freeSlotCount", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    const before = atlas.freeSlotCount(1);
    atlas.free(slot.globalIndex);
    expect(atlas.freeSlotCount(1)).toBe(before + 1);
  });
});

// ── releaseNodeSlot ───────────────────────────────────────────────────────────

describe("releaseNodeSlot", () => {
  it("returns null for unknown nodeId", () => {
    const atlas = makeAtlas();
    expect(atlas.releaseNodeSlot(999)).toBeNull();
  });

  it("returns the AllocatedSlot struct", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(5, slot);
    const released = atlas.releaseNodeSlot(5);
    expect(released).not.toBeNull();
    expect(released!.globalIndex).toBe(slot.globalIndex);
  });

  it("released slot can be re-allocated", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    const g = slot.globalIndex;
    atlas.assignSlot(5, slot);
    atlas.releaseNodeSlot(5);
    const slot2 = atlas.alloc(1)!;
    expect(slot2.globalIndex).toBe(g);
  });

  it("clears both forward and reverse mappings", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(5, slot);
    atlas.releaseNodeSlot(5);
    expect(atlas.getSlot(5)).toBe(-1);
    expect(atlas.getNodeId(slot.globalIndex)).toBe(-1);
  });
});

// ── lruEvict ──────────────────────────────────────────────────────────────────

describe("lruEvict", () => {
  it("returns null when no nodes are loaded", () => {
    const atlas = makeAtlas();
    expect(atlas.lruEvict(1)).toBeNull();
  });

  it("evicts the least-recently-used node first", () => {
    const atlas = makeAtlas();
    // Load 3 nodes into tier 0.
    for (let nodeId = 10; nodeId < 13; nodeId++) {
      const slot = atlas.alloc(1)!;
      atlas.assignSlot(nodeId, slot);
    }
    // nodeId 10 is LRU (inserted first).
    const result = atlas.lruEvict(1)!;
    expect(result.evictedNodeId).toBe(10);
  });

  it("touch promotes node to MRU position", () => {
    const atlas = makeAtlas();
    for (let nodeId = 10; nodeId < 13; nodeId++) {
      const slot = atlas.alloc(1)!;
      atlas.assignSlot(nodeId, slot);
    }
    // Touch nodeId 10 — it moves to MRU, so 11 becomes LRU.
    atlas.touch(10);
    const result = atlas.lruEvict(1)!;
    expect(result.evictedNodeId).toBe(11);
  });

  it("skipNodeId predicate skips that node and evicts the next", () => {
    const atlas = makeAtlas();
    for (let nodeId = 10; nodeId < 13; nodeId++) {
      const slot = atlas.alloc(1)!;
      atlas.assignSlot(nodeId, slot);
    }
    // Skip nodeId 10 (LRU) — should evict 11 instead.
    const result = atlas.lruEvict(1, (id) => id === 10)!;
    expect(result.evictedNodeId).toBe(11);
  });

  it("returns null when all loaded nodes are skipped", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(10, slot);
    expect(atlas.lruEvict(1, () => true)).toBeNull();
  });

  it("evicted slot is returned to the free-list", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(10, slot);
    const before = atlas.freeSlotCount(1);
    atlas.lruEvict(1);
    expect(atlas.freeSlotCount(1)).toBe(before + 1);
  });

  it("evicting clears node ↔ slot associations", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(10, slot);
    atlas.lruEvict(1);
    expect(atlas.getSlot(10)).toBe(-1);
    expect(atlas.getNodeId(slot.globalIndex)).toBe(-1);
  });

  it("evicted slot can be immediately re-allocated", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    const g = slot.globalIndex;
    atlas.assignSlot(10, slot);
    atlas.lruEvict(1);
    const slot2 = atlas.alloc(1)!;
    expect(slot2.globalIndex).toBe(g);
  });

  it("returns null for pointCount exceeding all tiers", () => {
    const atlas = makeAtlas();
    const slot = atlas.alloc(1)!;
    atlas.assignSlot(10, slot);
    expect(atlas.lruEvict(9999)).toBeNull();
  });
});

// ── hasFreeSlot / freeSlotCount ────────────────────────────────────────────────

describe("hasFreeSlot and freeSlotCount", () => {
  it("hasFreeSlot true when slots are available", () => {
    const atlas = makeAtlas();
    expect(atlas.hasFreeSlot(1)).toBe(true);
  });

  it("hasFreeSlot false after tier is exhausted", () => {
    const atlas = makeAtlas();
    for (let i = 0; i < 3; i++) atlas.alloc(1);
    expect(atlas.hasFreeSlot(1)).toBe(false);
  });

  it("hasFreeSlot false for pointCount exceeding all tiers", () => {
    const atlas = makeAtlas();
    expect(atlas.hasFreeSlot(9999)).toBe(false);
  });

  it("freeSlotCount decreases with each alloc", () => {
    const atlas = makeAtlas();
    expect(atlas.freeSlotCount(1)).toBe(3);
    atlas.alloc(1);
    expect(atlas.freeSlotCount(1)).toBe(2);
    atlas.alloc(1);
    expect(atlas.freeSlotCount(1)).toBe(1);
    atlas.alloc(1);
    expect(atlas.freeSlotCount(1)).toBe(0);
  });
});

// ── Full alloc → evict → re-alloc cycle ───────────────────────────────────────

describe("full cycle", () => {
  it("exhausting tier 0, evicting LRU, and re-allocating succeeds", () => {
    const atlas = makeAtlas();
    // Fill tier 0.
    const slots: number[] = [];
    for (let nodeId = 0; nodeId < 3; nodeId++) {
      const slot = atlas.alloc(1)!;
      atlas.assignSlot(nodeId, slot);
      slots.push(slot.globalIndex);
    }
    // No free slot.
    expect(atlas.alloc(1)).toBeNull();

    // Evict LRU (nodeId 0).
    const ev = atlas.lruEvict(1)!;
    expect(ev.evictedNodeId).toBe(0);

    // Re-allocate.
    const newSlot = atlas.alloc(1);
    expect(newSlot).not.toBeNull();
    atlas.assignSlot(99, newSlot!);
    expect(atlas.getSlot(99)).toBe(newSlot!.globalIndex);
  });

  it("LRU order reflects touch calls across multiple nodes", () => {
    const atlas = makeAtlas();
    for (let nodeId = 0; nodeId < 3; nodeId++) {
      const slot = atlas.alloc(1)!;
      atlas.assignSlot(nodeId, slot);
    }
    // Touch 0 and 1 — only 2 is untouched (LRU).
    atlas.touch(0);
    atlas.touch(1);
    const ev = atlas.lruEvict(1)!;
    expect(ev.evictedNodeId).toBe(2);
  });
});
