import { describe, expect, it } from "vitest";
import { buildLodBuckets, sampleByStep } from "../src/core/lod";

function points(n: number) {
  return Array.from({ length: n }, (_, i) => ({ x: i, y: i, z: i }));
}

describe("LOD", () => {
  it("samples by step deterministically", () => {
    const out = sampleByStep(points(10), 2);
    expect(out.map((p) => p.x)).toEqual([0, 2, 4, 6, 8]);
  });

  it("returns requested number of buckets", () => {
    const buckets = buildLodBuckets(points(16), 4);
    expect(buckets).toHaveLength(4);
    expect(buckets[0]).toHaveLength(16);
    expect(buckets[1]).toHaveLength(8);
    expect(buckets[2]).toHaveLength(4);
    expect(buckets[3]).toHaveLength(2);
  });

  it("throws when levels is invalid", () => {
    expect(() => buildLodBuckets(points(4), 0)).toThrowError("levels must be >= 1");
  });
});
