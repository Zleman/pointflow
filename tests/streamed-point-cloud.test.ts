import { describe, expect, it } from "vitest";
import { isResetTransition } from "../src/components/reset-cadence";
import { computeEffectiveRefreshIntervalMs } from "../src/components/refresh-cadence";

describe("isResetTransition", () => {
  it("returns true only on transition from non-zero to zero (reset edge)", () => {
    expect(isResetTransition(100, 0)).toBe(true);
    expect(isResetTransition(1, 0)).toBe(true);
  });

  it("returns false when already empty so idle empty does not drive refresh", () => {
    expect(isResetTransition(0, 0)).toBe(false);
  });

  it("returns false when going from empty to non-empty or between non-zero counts", () => {
    expect(isResetTransition(0, 100)).toBe(false);
    expect(isResetTransition(50, 100)).toBe(false);
    expect(isResetTransition(100, 50)).toBe(false);
  });
});

describe("computeEffectiveRefreshIntervalMs", () => {
  it("uses base cadence when adaptive refresh is disabled", () => {
    const interval = computeEffectiveRefreshIntervalMs(false, 10, 120, 40);
    expect(interval).toBe(120);
  });

  it("uses adaptive cadence with identical semantics for both backends", () => {
    const interval = computeEffectiveRefreshIntervalMs(true, 60, 16, 33);
    expect(interval).toBe(66);
  });

  it("clamps adaptive cadence to the hard upper bound", () => {
    const interval = computeEffectiveRefreshIntervalMs(true, 60, 16, 500);
    expect(interval).toBe(200);
  });
});
