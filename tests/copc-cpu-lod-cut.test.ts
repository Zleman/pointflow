import { describe, expect, it } from "vitest";
import { AtlasManager } from "../src/copc/copc-atlas-manager";
import { computeCopcLodCut } from "../src/copc/copc-cpu-lod-cut";

describe("computeCopcLodCut LRU touch semantics", () => {
  it("touches only selected nodes", () => {
    const atlas = new AtlasManager([{ slotCount: 3, pointsPerSlot: 16 }]);
    const rootSlot = atlas.alloc(8)!;
    const childSlot = atlas.alloc(8)!;
    const hiddenSlot = atlas.alloc(8)!;
    atlas.assignSlot(0, rootSlot);
    atlas.assignSlot(1, childSlot);
    atlas.assignSlot(2, hiddenSlot);

    const nodes = [
      {
        bboxMin: [-1, -1, -1] as [number, number, number],
        bboxMax: [1, 1, 1] as [number, number, number],
        error: 10,
        pointCount: 10,
        childIds: [1],
      },
      {
        bboxMin: [-1, -1, -1] as [number, number, number],
        bboxMax: [1, 1, 1] as [number, number, number],
        error: 1,
        pointCount: 10,
        childIds: [],
      },
      {
        bboxMin: [50, 50, 50] as [number, number, number],
        bboxMax: [52, 52, 52] as [number, number, number],
        error: 1,
        pointCount: 10,
        childIds: [],
      },
    ];

    const vp = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];

    const selected = computeCopcLodCut(nodes, [0], atlas, vp, 1, 0.001, false, true);
    expect(selected).toEqual([1]);

    const evicted = atlas.lruEvict(8);
    expect(evicted).not.toBeNull();
    expect(evicted!.evictedNodeId).toBe(0);
  });
});
