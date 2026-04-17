/**
 * Tests for COPC frustum / LOD tile selection.
 * Pure math only — no Three.js, no DOM needed.
 */
import { describe, it, expect } from "vitest";
import {
  adaptCopcConcurrency,
  extractFrustumPlanes,
  aabbInFrustum,
  rotateCandidatesForFairness,
  voxelBounds,
  selectVisibleTiles,
} from "../src/copc/copc-frustum";
import type { CopcInfo, CopcNode } from "../src/copc/copc-types";
import { voxelKeyString } from "../src/copc/copc-types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Identity VP matrix (column-major, no projection distortion). */
function identityMatrix(): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

/**
 * Build a simple orthographic projection matrix (column-major).
 * Maps the box [l,r] × [b,t] × [n,f] to NDC [-1,1]³.
 */
function orthoMatrix(
  l: number, r: number, b: number, t: number, n: number, f: number,
): number[] {
  const m = Array(16).fill(0);
  m[0]  = 2 / (r - l);
  m[5]  = 2 / (t - b);
  m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = -(f + n) / (f - n);
  m[15] = 1;
  return m;
}

/** Minimal CopcInfo for tests. */
function makeInfo(halfsize = 100): CopcInfo {
  return {
    center: [0, 0, 0],
    halfsize,
    spacing: 1,
    rootHierOffset: 0n,
    rootHierSize: 0n,
    gpsMin: 0,
    gpsMax: 1,
  };
}

/** Build a simple nodes map with the root node. */
function makeNodes(
  entries: Array<{ depth: number; x: number; y: number; z: number }>,
): Map<string, CopcNode> {
  const m = new Map<string, CopcNode>();
  for (const e of entries) {
    const key = { ...e };
    m.set(voxelKeyString(key), {
      key,
      offset: 1000n,
      byteSize: 512n,
      pointCount: 100n,
    });
  }
  return m;
}

// ─── extractFrustumPlanes ─────────────────────────────────────────────────────

describe("extractFrustumPlanes", () => {
  it("returns 6 planes", () => {
    const planes = extractFrustumPlanes(identityMatrix());
    expect(planes).toHaveLength(6);
  });

  it("each plane has 4 components", () => {
    const planes = extractFrustumPlanes(identityMatrix());
    for (const p of planes) {
      expect(p).toHaveLength(4);
    }
  });

  it("a point inside the frustum satisfies all plane tests", () => {
    // The ortho matrix maps the box [l,r]×[b,t]×[n,f] to NDC.
    // A point at (0,0,-50) is midway between near (0.1) and far (100) in
    // the Z direction for this matrix (Z = -(n+f)/2 = -50).
    const vp = orthoMatrix(-10, 10, -10, 10, 0.1, 100);
    const planes = extractFrustumPlanes(vp);
    // Test a point clearly inside the frustum box.
    const px = 0, py = 0, pz = -50;
    let allPositive = true;
    for (const [a, b, c, d] of planes) {
      if (a * px + b * py + c * pz + d < 0) { allPositive = false; break; }
    }
    expect(allPositive).toBe(true);
  });

  it("planes are normalised (normal length ≈ 1)", () => {
    const vp = orthoMatrix(-5, 5, -5, 5, 1, 50);
    const planes = extractFrustumPlanes(vp);
    for (const [a, b, c] of planes) {
      const len = Math.sqrt(a * a + b * b + c * c);
      expect(len).toBeCloseTo(1, 3);
    }
  });
});

// ─── aabbInFrustum ────────────────────────────────────────────────────────────

describe("aabbInFrustum", () => {
  it("returns true for a box at the origin inside an ortho frustum", () => {
    const vp     = orthoMatrix(-10, 10, -10, 10, 0.1, 100);
    const planes = extractFrustumPlanes(vp);
    expect(aabbInFrustum(planes, -1, -1, -1, 1, 1, 1)).toBe(true);
  });

  it("returns false for a box entirely outside the frustum", () => {
    const vp     = orthoMatrix(-10, 10, -10, 10, 0.1, 100);
    const planes = extractFrustumPlanes(vp);
    // Box at x = 20–30, well outside right side.
    expect(aabbInFrustum(planes, 20, -1, -1, 30, 1, 1)).toBe(false);
  });

  it("returns true for a large box that encloses the frustum", () => {
    const vp     = orthoMatrix(-10, 10, -10, 10, 0.1, 100);
    const planes = extractFrustumPlanes(vp);
    expect(aabbInFrustum(planes, -1000, -1000, -1000, 1000, 1000, 1000)).toBe(true);
  });

  it("returns true for a box partially overlapping the frustum", () => {
    const vp     = orthoMatrix(-10, 10, -10, 10, 0.1, 100);
    const planes = extractFrustumPlanes(vp);
    // Partially inside: x spans from -5 to 15 (right side goes beyond +10).
    expect(aabbInFrustum(planes, -5, -5, -5, 15, 5, 5)).toBe(true);
  });
});

// ─── voxelBounds ─────────────────────────────────────────────────────────────

describe("voxelBounds", () => {
  it("root voxel covers center ± halfsize", () => {
    const info   = makeInfo(100);
    const [minX, minY, minZ, maxX, maxY, maxZ] = voxelBounds({ depth: 0, x: 0, y: 0, z: 0 }, info);
    expect(minX).toBeCloseTo(-100);
    expect(maxX).toBeCloseTo(100);
    expect(minY).toBeCloseTo(-100);
    expect(maxY).toBeCloseTo(100);
    expect(minZ).toBeCloseTo(-100);
    expect(maxZ).toBeCloseTo(100);
  });

  it("depth-1 voxel has half the side length of root", () => {
    const info   = makeInfo(100);
    const [minX,, , maxX] = voxelBounds({ depth: 1, x: 0, y: 0, z: 0 }, info);
    // step at depth 1 = (2*100)/2 = 100; minX = -100 + 0*100 = -100; maxX = 0
    expect(maxX - minX).toBeCloseTo(100);
  });

  it("depth-1 x=1 voxel is adjacent to x=0 voxel", () => {
    const info   = makeInfo(100);
    const [, , , maxX0] = voxelBounds({ depth: 1, x: 0, y: 0, z: 0 }, info);
    const [minX1]       = voxelBounds({ depth: 1, x: 1, y: 0, z: 0 }, info);
    expect(maxX0).toBeCloseTo(minX1);
  });
});

// ─── selectVisibleTiles ───────────────────────────────────────────────────────

describe("selectVisibleTiles", () => {
  it("selects root tile when VP matrix shows the root voxel is visible", () => {
    const info   = makeInfo(100);
    const nodes  = makeNodes([{ depth: 0, x: 0, y: 0, z: 0 }]);
    const vp     = orthoMatrix(-200, 200, -200, 200, 0.1, 1000);
    const camera: [number, number, number] = [0, 0, 500];

    const result = selectVisibleTiles(nodes, info, vp, camera, 0.0, 10);
    const keys   = result.map(k => voxelKeyString(k));
    expect(keys).toContain("0-0-0-0");
  });

  it("does not select tiles not present in the nodes map", () => {
    const info   = makeInfo(100);
    // Only root exists, children do not.
    const nodes  = makeNodes([{ depth: 0, x: 0, y: 0, z: 0 }]);
    const vp     = orthoMatrix(-200, 200, -200, 200, 0.1, 1000);
    const camera: [number, number, number] = [0, 0, 500];

    const result = selectVisibleTiles(nodes, info, vp, camera, 0.001, 10);
    // Only root should be selected (children not in nodes).
    expect(result.every(k => k.depth === 0)).toBe(true);
  });

  it("skips empty tiles (byteSize = 0)", () => {
    const info  = makeInfo(100);
    const nodes = new Map<string, CopcNode>();
    // Root tile is empty.
    nodes.set("0-0-0-0", {
      key: { depth: 0, x: 0, y: 0, z: 0 },
      offset: 1000n,
      byteSize: 0n,
      pointCount: 0n,
    });
    const vp     = orthoMatrix(-200, 200, -200, 200, 0.1, 1000);
    const camera: [number, number, number] = [0, 0, 500];

    const result = selectVisibleTiles(nodes, info, vp, camera, 0.0, 10);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when nodes map is empty", () => {
    const info   = makeInfo(100);
    const nodes  = new Map<string, CopcNode>();
    const vp     = orthoMatrix(-200, 200, -200, 200, 0.1, 1000);
    const camera: [number, number, number] = [0, 0, 500];

    const result = selectVisibleTiles(nodes, info, vp, camera, 0.0, 10);
    expect(result).toHaveLength(0);
  });

  it("skips oversize nodes for selection but recurses so children can be selected", () => {
    const info = makeInfo(100);
    const nodes = new Map<string, CopcNode>();
    nodes.set("0-0-0-0", {
      key: { depth: 0, x: 0, y: 0, z: 0 },
      offset: 1n,
      byteSize: 100n,
      pointCount: 100n,
    });
    nodes.set("1-0-0-0", {
      key: { depth: 1, x: 0, y: 0, z: 0 },
      offset: 1n,
      byteSize: 100n,
      pointCount: 50n,
    });
    const vp = orthoMatrix(-200, 200, -200, 200, 0.1, 1000);
    const camera: [number, number, number] = [0, 0, 500];

    const result = selectVisibleTiles(nodes, info, vp, camera, 0.0, 10, 10, 99);
    const keys = result.map(k => voxelKeyString(k));
    expect(keys).not.toContain("0-0-0-0");
    expect(keys).toContain("1-0-0-0");
  });
});

describe("adaptCopcConcurrency", () => {
  it("uses hysteresis before reducing concurrency", () => {
    let state = { next: 8, overBudgetStreak: 0, underBudgetStreak: 0 };
    state = adaptCopcConcurrency(state.next, 16, 35, state.overBudgetStreak, state.underBudgetStreak);
    state = adaptCopcConcurrency(state.next, 16, 34, state.overBudgetStreak, state.underBudgetStreak);
    expect(state.next).toBe(8);
    state = adaptCopcConcurrency(state.next, 16, 33, state.overBudgetStreak, state.underBudgetStreak);
    expect(state.next).toBe(7);
  });

  it("uses hysteresis before increasing concurrency", () => {
    let state = { next: 4, overBudgetStreak: 0, underBudgetStreak: 0 };
    state = adaptCopcConcurrency(state.next, 6, 10, state.overBudgetStreak, state.underBudgetStreak);
    state = adaptCopcConcurrency(state.next, 6, 12, state.overBudgetStreak, state.underBudgetStreak);
    expect(state.next).toBe(4);
    state = adaptCopcConcurrency(state.next, 6, 11, state.overBudgetStreak, state.underBudgetStreak);
    expect(state.next).toBe(5);
  });
});

describe("rotateCandidatesForFairness", () => {
  it("rotates in a deterministic round-robin order", () => {
    const input = [1, 2, 3, 4];
    expect(rotateCandidatesForFairness(input, 0)).toEqual([1, 2, 3, 4]);
    expect(rotateCandidatesForFairness(input, 1)).toEqual([2, 3, 4, 1]);
    expect(rotateCandidatesForFairness(input, 2)).toEqual([3, 4, 1, 2]);
  });
});
