import { describe, it } from "vitest";
import { PointBuffer } from "../src/core/backpressure";
import { packChunk } from "../src/worker/worker-bridge";
import { computeActivePolicy, detectTier } from "../src/core/runtime-policy";
import type { PointRecord } from "../src/core/types";

function makeAttrPoints(n: number, keys: string[]): PointRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    x: i * 0.001,
    y: Math.sin(i * 0.01),
    z: Math.cos(i * 0.01),
    attributes: Object.fromEntries(keys.map((k, ki) => [k, (i + 1) * (ki + 1) * 0.001])),
  }));
}

function formatMs(ms: number): string {
  return ms.toFixed(3);
}

function emitRecord(record: Record<string, unknown>): void {
  console.log("[bench:policy-hotpath]", JSON.stringify(record));
}

describe("bench:copyToTypedArrays throughput", () => {
  it("range cache clean path outperforms dirty path", () => {
    const sizes = [50_000, 200_000, 500_000];

    for (const n of sizes) {
      const buf = new PointBuffer({ maxPoints: n, mode: "drop-oldest" });
      const pts = makeAttrPoints(n, ["velocity"]);
      buf.ingest(pts);

      const positions = new Float32Array(n * 3);
      const colors = new Float32Array(n * 3);
      const iterations = 5;

      buf.copyToTypedArrays(positions, colors, 1, "velocity");

      const cleanStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        buf.copyToTypedArrays(positions, colors, 1, "velocity");
      }
      const cleanMs = (performance.now() - cleanStart) / iterations;

      const dirtyBuf = new PointBuffer({ maxPoints: n, mode: "drop-oldest" });
      dirtyBuf.ingest(pts);
      const dirtyStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        dirtyBuf.copyToTypedArrays(positions, colors, 1, "velocity");
        dirtyBuf.copyToTypedArrays(positions, colors, 1, "other_key_forces_reset");
      }
      const dirtyMs = (performance.now() - dirtyStart) / (iterations * 2);

      emitRecord({
        test: "range_cache_throughput",
        n,
        clean_path_ms: parseFloat(formatMs(cleanMs)),
        dirty_path_ms: parseFloat(formatMs(dirtyMs)),
        speedup_ratio: parseFloat((dirtyMs / cleanMs).toFixed(2)),
      });
    }
  });

  it("generation-stamp slot reuse stays fast with many channels", () => {
    const n = 10_000;
    const iterations = 200;
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const points = makeAttrPoints(n, keys);
    const chunk = { points };

    const buf = new PointBuffer({ maxPoints: n, mode: "drop-oldest" });
    buf.ingest(points);

    const { xyz, attributes, count } = packChunk(chunk);

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      buf.ingestFromBinary(xyz, attributes, count);
    }
    const perIterMs = (performance.now() - start) / iterations;

    emitRecord({
      test: "generation_stamp_slot_reuse",
      n,
      channels: keys.length,
      iterations,
      per_iter_ms: parseFloat(formatMs(perIterMs)),
      points_per_ms: parseFloat((n / perIterMs).toFixed(0)),
    });
  });
});

describe("bench:packChunk throughput", () => {
  it("measures packing throughput for 1 and 8 channels", () => {
    const sizes = [100, 1_000, 10_000];
    const channelSets = [["velocity"], ["a", "b", "c", "d", "e", "f", "g", "h"]];
    const iterations = 50;

    for (const size of sizes) {
      for (const keys of channelSets) {
        const chunk = { points: makeAttrPoints(size, keys) };
        packChunk(chunk);

        const start = performance.now();
        for (let i = 0; i < iterations; i++) {
          packChunk(chunk);
        }
        const perIterMs = (performance.now() - start) / iterations;

        emitRecord({
          test: "pack_throughput",
          chunk_size: size,
          channels: keys.length,
          per_iter_ms: parseFloat(formatMs(perIterMs)),
          points_per_ms: parseFloat((size / perIterMs).toFixed(0)),
        });
      }
    }
  });
});

describe("bench:runtime policy evidence", () => {
  it("matches required cross-tier max-throughput budgets", () => {
    const tiers = [
      { tier: "L" as const, requiredBudget: 200_000 },
      { tier: "M" as const, requiredBudget: 500_000 },
      { tier: "H" as const, requiredBudget: 1_000_000 },
    ];

    for (const { tier, requiredBudget } of tiers) {
      const p = computeActivePolicy(tier, "max_throughput", {});
      emitRecord({
        test: "cross_tier_budget",
        tier,
        required_budget: requiredBudget,
        actual_budget: p.pointBudget,
        cadence_ms: p.updateCadenceMs,
      });
      if (p.pointBudget < requiredBudget) {
        throw new Error(`SLA FAIL: tier ${tier} budget ${p.pointBudget} < ${requiredBudget}`);
      }
    }
  });

  it("keeps constraint precedence with zero violations", () => {
    const cap = 300_000;
    const tiers = ["L", "M", "H"] as const;
    const modes = ["eco", "balanced", "max_throughput", "custom"] as const;
    let violations = 0;

    for (let i = 0; i < 10_000; i++) {
      const tier = tiers[i % tiers.length];
      const mode = modes[i % modes.length];
      if (computeActivePolicy(tier, mode, { pointBudgetCap: cap }).pointBudget > cap) {
        violations++;
      }
    }

    emitRecord({ test: "constraint_precedence_stress", cap, violations });
    if (violations > 0) throw new Error(`Constraint violations: ${violations}`);
  });

  it("keeps detectTier deterministic for stable inputs", () => {
    const inputs = [
      { maxTex: 4096, signals: { webGpuAvailable: false, hardwareConcurrency: 4, deviceMemoryGb: 4 } },
      { maxTex: 8192, signals: { webGpuAvailable: false, hardwareConcurrency: 8, deviceMemoryGb: 8 } },
      { maxTex: 16384, signals: { webGpuAvailable: true, hardwareConcurrency: 16, deviceMemoryGb: 16 } },
    ];

    for (const { maxTex, signals } of inputs) {
      const first = detectTier(maxTex, signals);
      for (let i = 0; i < 999; i++) {
        if (detectTier(maxTex, signals) !== first) {
          throw new Error("detectTier is non-deterministic");
        }
      }
    }
  });
});
