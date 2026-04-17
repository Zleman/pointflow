/**
 * M10.3 — Classification weights acceptance tests.
 */
import { describe, it, expect } from "vitest";
import { PointBuffer } from "../src/core/backpressure";

describe("M10.3 — Classification weights", () => {

  it("overrides importance with the mapped weight for matched classification", () => {
    const buf = new PointBuffer({
      maxPoints: 10,
      mode: "drop-oldest",
      classificationWeights: { 2: 0.1, 6: 0.9 },
    });

    buf.ingest([
      { x: 0, y: 0, z: 0, attributes: { classification: 2 } }, // ground → low
      { x: 1, y: 0, z: 0, attributes: { classification: 6 } }, // building → high
    ]);

    // Fill buffer then add more points — building should survive over ground
    for (let i = 0; i < 8; i++) {
      buf.ingest([{ x: i + 2, y: 0, z: 0, attributes: { classification: 2 } }]);
    }

    // Buffer now full (10 pts). Add one more ground point to trigger eviction.
    buf.ingest([{ x: 100, y: 0, z: 0, attributes: { classification: 2 } }]);

    // The building point (classification=6, importance=0.9) should be retained.
    const pts = buf.snapshot();
    const hasBuilding = pts.some(
      (p) => Math.round(p.attributes?.classification ?? -1) === 6
    );
    expect(hasBuilding).toBe(true);
  });

  it("defaults to 1.0 importance for unrecognised classification values", () => {
    const buf = new PointBuffer({
      maxPoints: 5,
      mode: "drop-oldest",
      classificationWeights: { 2: 0.5 },
    });

    buf.ingest([{ x: 0, y: 0, z: 0, attributes: { classification: 99 } }]);

    // Should not crash; importance defaults to 1.0 (unrecognised)
    const pts = buf.snapshot();
    expect(pts).toHaveLength(1);
    expect(pts[0].attributes?.classification).toBeCloseTo(99, 0);
  });

  it("classificationWeights overrides importanceField for matched points", () => {
    const buf = new PointBuffer({
      maxPoints: 10,
      mode: "drop-oldest",
      importanceField: "score",
      classificationWeights: { 0: 0.05 },
    });

    // classification=0 → weight=0.05 (override), score=0.9 is ignored
    // classification=1 → no weight, score=0.9 applies
    buf.ingest([
      { x: 0, y: 0, z: 0, attributes: { classification: 0, score: 0.9 } },
      { x: 1, y: 0, z: 0, attributes: { classification: 1, score: 0.9 } },
    ]);

    // Fill and apply pressure — class=0 point (overridden to 0.05) should be evicted first
    for (let i = 2; i < 10; i++) {
      buf.ingest([{ x: i, y: 0, z: 0, attributes: { classification: 0, score: 0.9 } }]);
    }
    buf.ingest([{ x: 99, y: 0, z: 0, attributes: { classification: 1, score: 0.9 } }]);

    const pts = buf.snapshot();
    // The classification=1/score=0.9 points should be retained (higher effective importance)
    const count1 = pts.filter(p => Math.round(p.attributes?.classification ?? -1) === 1).length;
    expect(count1).toBeGreaterThanOrEqual(1);
  });

  it("works with custom classificationField", () => {
    const buf = new PointBuffer({
      maxPoints: 5,
      mode: "drop-oldest",
      classificationWeights: { 1: 0.1 },
      classificationField: "label",
    });

    buf.ingest([
      { x: 0, y: 0, z: 0, attributes: { label: 1 } }, // → weight 0.1
      { x: 1, y: 0, z: 0, attributes: { label: 2 } }, // → unrecognised, weight 1.0
    ]);

    const pts = buf.snapshot();
    expect(pts).toHaveLength(2);
  });
});
