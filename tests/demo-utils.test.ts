import { describe, expect, it } from "vitest";
import { makeMockChunk, resetMockSequence } from "../demo/utils";

describe("demo mock stream utils", () => {
  it("returns empty chunk for non-finite pointsPerChunk without poisoning sequence", () => {
    resetMockSequence();
    const invalid = makeMockChunk(Number.NaN, "single", "spiral");
    expect(invalid.points).toHaveLength(0);

    const valid = makeMockChunk(2, "single", "spiral");
    expect(valid.points).toHaveLength(2);
    for (const p of valid.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });

  it("returns empty chunk for non-positive pointsPerChunk", () => {
    resetMockSequence();
    expect(makeMockChunk(0, "single", "spiral").points).toHaveLength(0);
    expect(makeMockChunk(-10, "single", "spiral").points).toHaveLength(0);
  });
});
