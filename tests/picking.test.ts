/**
 * M9.1 — CPU point picking acceptance tests.
 *
 * Tests the PointBuffer.pickNearest() method directly, which is the engine
 * behind the onPointPick callback in StreamedPointCloud / PointCloud.
 *
 * Coverage:
 *   1. pickNearest returns the point nearest to the click within the radius.
 *   2. Empty-region click: returns null when no point is within pick radius.
 *   3. Stacked points: returns the highest-importance point, not arbitrary.
 *   4. Behind-camera points are ignored (clipW ≤ 0).
 *   5. pickNearest returns null on an empty buffer.
 */

import { describe, it, expect } from "vitest";
import { PointBuffer } from "../src/core/backpressure";

// ─── Helper: synthetic VP matrix ─────────────────────────────────────────────

/**
 * Build a simple orthographic VP matrix that maps world space 1:1 to NDC.
 * canvas = 800×600, world coords [-400,400] × [-300,300] → NDC [-1,1].
 *
 * We use an identity-like projection so we can reason about screen positions
 * without actual Three.js camera math.
 *
 * Column-major, as in Three.js Matrix4.elements:
 *   vp[col*4 + row]
 *
 * For an orthographic camera covering [-W/2,W/2] × [-H/2,H/2]:
 *   ndcX = x / (W/2)   ndcY = y / (H/2)   ndcW = 1
 *
 * clip.x = vp[0]*x  →  vp[0] = 2/W
 * clip.y = vp[5]*y  →  vp[5] = 2/H
 * clip.w = vp[15]   →  vp[15] = 1
 */
function makeOrthoVP(canvasW: number, canvasH: number): Float32Array {
  const vp = new Float32Array(16);
  vp[0]  = 2 / canvasW;  // ndcX = x * (2/W)
  vp[5]  = 2 / canvasH;  // ndcY = y * (2/H)
  vp[10] = 1;
  vp[15] = 1;             // homogeneous divide by 1
  return vp;
}

const W = 800;
const H = 600;
const VP = makeOrthoVP(W, H);

/** Convert world (x,y) → screen (px) under the ortho VP above. */
function worldToScreen(wx: number, wy: number): [number, number] {
  const ndcX = wx * (2 / W);
  const ndcY = wy * (2 / H);
  return [(ndcX + 1) * 0.5 * W, (1 - ndcY) * 0.5 * H];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("M9.1 — CPU point picking", () => {

  // ── Test 1: picks the nearest point within radius ─────────────────────────
  it("returns the point whose screen projection falls within pick radius", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });

    // Point A at world (0, 0, 0) → screen (400, 300)
    // Point B at world (100, 0, 0) → screen (500, 300)
    buf.ingest([
      { x: 0,   y: 0, z: 0, attributes: {} },
      { x: 100, y: 0, z: 0, attributes: {} },
    ]);

    const [ax, ay] = worldToScreen(0, 0);    // 400, 300

    const result = buf.pickNearest(VP, ax, ay, W, H, 8);
    expect(result).not.toBeNull();
    // Should pick the point at world (0, 0, 0)
    expect(result!.x).toBeCloseTo(0, 1);
    expect(result!.y).toBeCloseTo(0, 1);
    expect(result!.screenDist).toBeLessThan(1);
  });

  // ── Test 2: returns null when click is outside pick radius ────────────────
  it("returns null when no point projects within the pick radius", () => {
    const buf = new PointBuffer({ maxPoints: 5, mode: "drop-oldest" });

    buf.ingest([{ x: 0, y: 0, z: 0, attributes: {} }]);

    // Click 50px away from the projected point — far outside default radius 8
    const [sx, sy] = worldToScreen(0, 0);
    const result   = buf.pickNearest(VP, sx + 50, sy, W, H, 8);
    expect(result).toBeNull();
  });

  // ── Test 3: stacked points — returns highest-importance point ─────────────
  it("returns the highest-importance point when multiple points project to the same screen position", () => {
    const buf = new PointBuffer({
      maxPoints:      20,
      mode:           "drop-oldest",
      importanceField: "score",
    });

    // Three points at the same world XY but different Z → same screen position
    // (under our ortho VP, Z has no effect on screen X/Y)
    buf.ingest([
      { x: 0, y: 0, z: 0,  attributes: { score: 0.1 } }, // low importance
      { x: 0, y: 0, z: 1,  attributes: { score: 0.9 } }, // high importance
      { x: 0, y: 0, z: -1, attributes: { score: 0.5 } }, // medium
    ]);

    const [sx, sy] = worldToScreen(0, 0);
    const result   = buf.pickNearest(VP, sx, sy, W, H, 8);

    expect(result).not.toBeNull();
    // Must pick the high-importance point (score = 0.9)
    expect(result!.importance).toBeGreaterThan(0.8);
    expect(result!.z).toBeCloseTo(1, 1);
  });

  // ── Test 4: behind-camera points are skipped ─────────────────────────────
  it("ignores points behind the camera (clipW ≤ 0)", () => {
    const buf = new PointBuffer({ maxPoints: 5, mode: "drop-oldest" });

    // For our ortho matrix with vp[15]=1, clipW is always 1 (never ≤ 0).
    // Simulate a perspective VP where a point behind camera gives clipW < 0.
    // We construct a VP where vp[15] = 0 and vp[11] = -1, so:
    //   clipW = vp[3]*x + vp[7]*y + vp[11]*z + vp[15] = -z
    // For z = 5 → clipW = -5 → behind camera.
    const perspVP = new Float32Array(16);
    perspVP[0]  = 1;   // clip.x = x
    perspVP[5]  = 1;   // clip.y = y
    perspVP[11] = -1;  // clip.w = -z  (so z>0 → behind)
    // vp[15] = 0 (default)

    buf.ingest([{ x: 0, y: 0, z: 5, attributes: {} }]); // behind camera in perspVP

    const result = buf.pickNearest(perspVP, W / 2, H / 2, W, H, 50);
    expect(result).toBeNull();
  });

  // ── Test 5: returns null on empty buffer ──────────────────────────────────
  it("returns null when the buffer is empty", () => {
    const buf    = new PointBuffer({ maxPoints: 5, mode: "drop-oldest" });
    const result = buf.pickNearest(VP, 400, 300, W, H, 8);
    expect(result).toBeNull();
  });

  // ── Bonus: attributes are included in the result ─────────────────────────
  it("includes attribute values for the picked point", () => {
    const buf = new PointBuffer({ maxPoints: 5, mode: "drop-oldest" });
    buf.ingest([{ x: 0, y: 0, z: 0, attributes: { intensity: 0.75, classification: 3 } }]);

    const [sx, sy] = worldToScreen(0, 0);
    const result   = buf.pickNearest(VP, sx, sy, W, H, 8);

    expect(result).not.toBeNull();
    expect(result!.attributes.intensity).toBeCloseTo(0.75, 2);
    expect(result!.attributes.classification).toBeCloseTo(3, 1);
  });
});
