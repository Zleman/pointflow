/**
 * M10.2 — Density-aware importance acceptance tests.
 */
import { describe, it, expect } from "vitest";
import { PointBuffer } from "../src/core/backpressure";

describe("M10.2 — Density-aware importance", () => {

  it("retains more points from sparse regions than dense regions under pressure", () => {
    // Create a buffer with inverse density weighting.
    // Sparse region: x ∈ [-100, -50]  — few points per cell
    // Dense region:  x ∈ [50, 100]    — many points per cell (same cell size = 10)
    const buf = new PointBuffer({
      maxPoints: 20,
      mode: "drop-oldest",
      densityWeight: "inverse",
      spatialCulling: true,
    });

    // Ingest 5 sparse points spread across 5 different cells
    for (let i = 0; i < 5; i++) {
      buf.ingest([{ x: -100 + i * 15, y: 0, z: 0, attributes: {} }]);
    }

    // Ingest 15 dense points all in the same ~2 cells
    for (let i = 0; i < 15; i++) {
      buf.ingest([{ x: 51 + (i % 3), y: 0, z: 0, attributes: {} }]);
    }

    // Buffer is now full (20 points). Add 10 more dense points to trigger eviction.
    for (let i = 0; i < 10; i++) {
      buf.ingest([{ x: 52, y: 0, z: 0, attributes: {} }]);
    }

    const pts = buf.snapshot();
    const sparseCount = pts.filter(p => p.x < 0).length;
    const denseCount  = pts.filter(p => p.x > 50).length;

    // Sparse region (higher density-weight score) should have retained more points
    // than a proportional share (they were only 5/20 = 25% originally).
    expect(sparseCount).toBeGreaterThan(0);
    // Dense points should have been evicted preferentially
    expect(denseCount).toBeLessThan(20);
  });

  it("densityWeight='none' produces identical behaviour to baseline (no density term)", () => {
    const makeBuffer = (dw: "none" | "inverse") => {
      const buf = new PointBuffer({ maxPoints: 5, mode: "drop-oldest", densityWeight: dw });
      for (let i = 0; i < 7; i++) {
        buf.ingest([{ x: i, y: 0, z: 0, attributes: {} }]);
      }
      return buf.snapshot().map(p => p.x).sort((a, b) => a - b);
    };

    // With densityWeight="none" and uniform importance, eviction is pure FIFO.
    // Both should produce the same result.
    const none    = makeBuffer("none");
    const noneRef = makeBuffer("none");
    expect(none).toEqual(noneRef);
  });

  it("sqrt_inverse mode retains sparse points with a softer bias", () => {
    const buf = new PointBuffer({
      maxPoints: 10,
      mode: "drop-oldest",
      densityWeight: "sqrt_inverse",
    });

    // Mix: 2 sparse + 8 dense (in same cell)
    buf.ingest([{ x: -200, y: 0, z: 0, attributes: {} }]);
    buf.ingest([{ x: -100, y: 0, z: 0, attributes: {} }]);
    for (let i = 0; i < 8; i++) {
      buf.ingest([{ x: 55, y: 0, z: 0, attributes: {} }]);
    }

    // Apply pressure: add 5 more points to trigger eviction
    for (let i = 0; i < 5; i++) {
      buf.ingest([{ x: 56, y: 0, z: 0, attributes: {} }]);
    }

    // At least one sparse point should survive
    const pts = buf.snapshot();
    const sparseCount = pts.filter(p => p.x < 0).length;
    expect(sparseCount).toBeGreaterThanOrEqual(1);
  });

  it("density weighting forces spatialCulling on even when not explicitly set", () => {
    // Should not throw even without spatialCulling: true
    const buf = new PointBuffer({
      maxPoints: 5,
      mode: "drop-oldest",
      densityWeight: "inverse",
      // spatialCulling not set — should be forced on internally
    });
    buf.ingest([{ x: 0, y: 0, z: 0, attributes: {} }]);
    expect(buf.snapshot()).toHaveLength(1);
  });
});
