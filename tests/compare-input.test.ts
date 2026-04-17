import { describe, expect, it } from "vitest";
import {
  COMPARE_INTERVAL_MS_MAX,
  COMPARE_INTERVAL_MS_MIN,
  COMPARE_POINTS_PER_CHUNK_MAX,
  COMPARE_POINTS_PER_CHUNK_MIN,
  isValidCompareIntervalMs,
  isValidComparePointsPerChunk,
  parseCompareBoundedInt,
} from "../demo/compare-input";

describe("compare input invariants", () => {
  it("accepts valid points-per-chunk values", () => {
    expect(isValidComparePointsPerChunk(COMPARE_POINTS_PER_CHUNK_MIN)).toBe(true);
    expect(isValidComparePointsPerChunk(500)).toBe(true);
    expect(isValidComparePointsPerChunk(COMPARE_POINTS_PER_CHUNK_MAX)).toBe(true);
  });

  it("rejects invalid points-per-chunk values", () => {
    expect(isValidComparePointsPerChunk(Number.NaN)).toBe(false);
    expect(isValidComparePointsPerChunk(0)).toBe(false);
    expect(isValidComparePointsPerChunk(COMPARE_POINTS_PER_CHUNK_MAX + 1)).toBe(false);
    expect(isValidComparePointsPerChunk(42.5)).toBe(false);
  });

  it("accepts valid interval values", () => {
    expect(isValidCompareIntervalMs(COMPARE_INTERVAL_MS_MIN)).toBe(true);
    expect(isValidCompareIntervalMs(100)).toBe(true);
    expect(isValidCompareIntervalMs(COMPARE_INTERVAL_MS_MAX)).toBe(true);
  });

  it("rejects invalid interval values", () => {
    expect(isValidCompareIntervalMs(Number.NaN)).toBe(false);
    expect(isValidCompareIntervalMs(0)).toBe(false);
    expect(isValidCompareIntervalMs(COMPARE_INTERVAL_MS_MAX + 1)).toBe(false);
    expect(isValidCompareIntervalMs(33.5)).toBe(false);
  });

  it("parses only bounded integer input", () => {
    expect(parseCompareBoundedInt("", 10, 100)).toBeNull();
    expect(parseCompareBoundedInt(" ", 10, 100)).toBeNull();
    expect(parseCompareBoundedInt("abc", 10, 100)).toBeNull();
    expect(parseCompareBoundedInt("9", 10, 100)).toBeNull();
    expect(parseCompareBoundedInt("101", 10, 100)).toBeNull();
    expect(parseCompareBoundedInt("10", 10, 100)).toBe(10);
    expect(parseCompareBoundedInt("42.9", 10, 100)).toBe(42);
  });
});
