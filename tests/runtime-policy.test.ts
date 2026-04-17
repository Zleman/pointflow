import { describe, expect, it } from "vitest";
import {
  computeActivePolicy,
  detectTier,
  detectTierFromEnvironment,
} from "../src/core/runtime-policy";

describe("runtime policy", () => {
  it("builds expected max throughput budgets per tier", () => {
    expect(computeActivePolicy("L", "max_throughput", {}).pointBudget).toBe(200_000);
    expect(computeActivePolicy("M", "max_throughput", {}).pointBudget).toBe(500_000);
    expect(computeActivePolicy("H", "max_throughput", {}).pointBudget).toBe(1_000_000);
  });

  it("keeps ordering eco < balanced < max throughput", () => {
    for (const tier of ["L", "M", "H"] as const) {
      const eco = computeActivePolicy(tier, "eco", {});
      const balanced = computeActivePolicy(tier, "balanced", {});
      const max = computeActivePolicy(tier, "max_throughput", {});
      expect(eco.pointBudget).toBeLessThan(balanced.pointBudget);
      expect(balanced.pointBudget).toBeLessThan(max.pointBudget);
      expect(eco.updateCadenceMs).toBeGreaterThanOrEqual(balanced.updateCadenceMs);
    }
  });

  it("enforces user constraints as hard caps", () => {
    const capped = computeActivePolicy("H", "max_throughput", {
      pointBudgetCap: 300_000,
      updateCadenceMinMs: 500,
    });
    expect(capped.pointBudget).toBe(300_000);
    expect(capped.updateCadenceMs).toBeGreaterThanOrEqual(500);
  });

  it("detects tiers from capability signals deterministically", () => {
    expect(detectTier(4096, { webGpuAvailable: false, hardwareConcurrency: 4, deviceMemoryGb: 4 })).toBe("L");
    expect(detectTier(8192, { webGpuAvailable: false, hardwareConcurrency: 8, deviceMemoryGb: 8 })).toBe("M");
    expect(detectTier(16384, { webGpuAvailable: true, hardwareConcurrency: 16, deviceMemoryGb: 16 })).toBe("H");

    const signals = { webGpuAvailable: true, hardwareConcurrency: 16, deviceMemoryGb: 16 };
    expect(detectTier(16384, signals)).toBe(detectTier(16384, signals));
  });

  it("returns a valid environment-derived tier", () => {
    expect(["L", "M", "H"]).toContain(detectTierFromEnvironment());
  });
});
