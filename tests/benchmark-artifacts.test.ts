import { describe, expect, test } from "vitest";
import {
  assertBenchmarkGatePassed,
  BENCHMARK_PROFILES,
  buildBenchmarkArtifacts,
  evaluateBenchmarkPass,
} from "../demo/benchmark";

describe("benchmark artifacts", () => {
  test("builds schema and markdown summary", () => {
    const artifacts = buildBenchmarkArtifacts(BENCHMARK_PROFILES.normal, [
      {
        passIndex: 1,
        durationSec: 30,
        warmupSec: 5,
        elapsedMs: 30_000,
        avgFrameMs: 7,
        rollingP95Ms: 10,
        hitches50: 1,
        hitches100: 0,
        heapCurrentMb: null,
        heapMaxMb: 120,
        ingestPeakPtsPerSec: 1000,
        ingestTotal: 10_000,
        droppedPoints: 100,
        droppedRatioPct: 1,
        bufferKept: 9_900,
        pressure: false,
        renderedPeak: 9_900,
        minFps: 30,
        maxFps: 120,
        requestedBackend: "auto",
        activeBackend: "webgpu",
        fallbackActive: false,
        workerMode: true,
        frustumCulling: true,
        autoLod: true,
        importanceSamplingEnabled: false,
      },
    ], undefined, {
      baselineId: "normal",
      values: {
        maxRollingP95Ms: 30,
        maxHitches50: 10,
        maxHitches100: 2,
        maxDroppedRatioPct: 5,
        minIngestPeakPtsPerSec: 500,
        minRenderedPeak: 5000,
      },
    });
    expect(artifacts.schema.schemaVersion).toBe(1);
    expect(artifacts.schema.thresholds?.baselineId).toBe("normal");
    expect(artifacts.markdownSummary).toContain("PointFlow Benchmark Summary");
    expect(artifacts.markdownSummary).toContain("Profile: Normal");
  });

  test("evaluates benchmark pass against thresholds", () => {
    const gate = evaluateBenchmarkPass(
      {
        rollingP95Ms: 12,
        hitches50: 1,
        hitches100: 0,
        droppedRatioPct: 0.5,
        ingestPeakPtsPerSec: 1200,
        renderedPeak: 10000,
      },
      {
        maxRollingP95Ms: 20,
        maxHitches50: 3,
        maxHitches100: 1,
        maxDroppedRatioPct: 2,
        minIngestPeakPtsPerSec: 1000,
        minRenderedPeak: 5000,
      },
    );
    expect(gate.passed).toBe(true);
    expect(gate.failures).toHaveLength(0);
  });

  test("flags regression when thresholds are exceeded", () => {
    const gate = evaluateBenchmarkPass(
      {
        rollingP95Ms: 80,
        hitches50: 25,
        hitches100: 8,
        droppedRatioPct: 12,
        ingestPeakPtsPerSec: 200,
        renderedPeak: 1000,
      },
      {
        maxRollingP95Ms: 20,
        maxHitches50: 5,
        maxHitches100: 1,
        maxDroppedRatioPct: 2,
        minIngestPeakPtsPerSec: 1000,
        minRenderedPeak: 5000,
      },
    );
    expect(gate.passed).toBe(false);
    expect(gate.failures).toContain("rollingP95Ms");
    expect(gate.failures).toContain("hitches50");
    expect(gate.failures).toContain("hitches100");
    expect(gate.failures).toContain("droppedRatioPct");
    expect(gate.failures).toContain("ingestPeakPtsPerSec");
    expect(gate.failures).toContain("renderedPeak");
  });

  test("throws explicit diagnostics when benchmark gate fails", () => {
    expect(() => {
      assertBenchmarkGatePassed(
        {
          rollingP95Ms: 80,
          hitches50: 10,
          hitches100: 5,
          droppedRatioPct: 9,
          ingestPeakPtsPerSec: 300,
          renderedPeak: 1000,
        },
        {
          maxRollingP95Ms: 20,
          maxHitches50: 1,
          maxHitches100: 1,
          maxDroppedRatioPct: 2,
          minIngestPeakPtsPerSec: 1000,
          minRenderedPeak: 5000,
        },
        "normal",
      );
    }).toThrowError(/Benchmark gate failed for baseline "normal"/);
  });
});
