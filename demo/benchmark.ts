export type BenchmarkProfileId = "normal" | "heavy" | "extreme" | "1M" | "custom";

export interface BenchmarkProfile {
  id: string;
  label: string;
  maxPoints: number;
  pointsPerChunk: number;
  intervalMs: number;
  durationSec: number;
  warmupSec: number;
}

const FIXED_PROFILE_IDS: Exclude<BenchmarkProfileId, "custom">[] = ["normal", "heavy", "extreme", "1M"];

export const BENCHMARK_PROFILES: Record<Exclude<BenchmarkProfileId, "custom">, BenchmarkProfile> = {
  normal: {
    id: "normal",
    label: "Normal",
    maxPoints: 50_000,
    pointsPerChunk: 50,
    intervalMs: 100,
    durationSec: 30,
    warmupSec: 5
  },
  heavy: {
    id: "heavy",
    label: "Heavy",
    maxPoints: 50_000,
    pointsPerChunk: 200,
    intervalMs: 100,
    durationSec: 30,
    warmupSec: 5
  },
  extreme: {
    id: "extreme",
    label: "Extreme",
    maxPoints: 50_000,
    pointsPerChunk: 500,
    intervalMs: 100,
    durationSec: 30,
    warmupSec: 5
  },
  "1M": {
    id: "1M",
    label: "1M Retained",
    maxPoints: 1_000_000,
    pointsPerChunk: 500,
    intervalMs: 28,
    durationSec: 60,
    warmupSec: 8
  }
};

export interface BenchmarkPassResult {
  passIndex: number;
  durationSec: number;
  warmupSec: number;
  elapsedMs: number;
  avgFrameMs: number;
  rollingP95Ms: number;
  hitches50: number;
  hitches100: number;
  heapCurrentMb: number | null;
  heapMaxMb: number;
  ingestPeakPtsPerSec: number;
  ingestTotal: number;
  droppedPoints: number;
  droppedRatioPct: number;
  bufferKept: number;
  pressure: boolean;
  renderedPeak: number;
  minFps: number;
  maxFps: number;
  requestedBackend: string;
  activeBackend: string;
  fallbackActive: boolean;
  workerMode: boolean;
  frustumCulling: boolean;
  autoLod: boolean;
  /** M12b.3: whether K-lookahead + GPU stochastic importance sampling was active. */
  importanceSamplingEnabled: boolean;
  baselineId?: string;
  gatePassed?: boolean;
  gateFailures?: string[];
  gateDiagnostics?: string;
}

export interface BenchmarkThreshold {
  maxRollingP95Ms: number;
  maxHitches50: number;
  maxHitches100: number;
  maxDroppedRatioPct: number;
  minIngestPeakPtsPerSec: number;
  minRenderedPeak: number;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  timestamp: string;
  environment: {
    userAgent: string;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
  };
  profile: BenchmarkProfile;
  warmup: {
    warmupSec: number;
    excludedFromAvgP95Hitches: true;
  };
  thresholds?: {
    baselineId: string;
    values: BenchmarkThreshold;
  };
  passes: BenchmarkPassResult[];
  multiRunSummary?: {
    runs: number;
    avgFrameMsMean: number;
    rollingP95MsMean: number;
    hitches50Total: number;
    hitches100Total: number;
  };
}

export interface BenchmarkArtifacts {
  schema: BenchmarkReport;
  markdownSummary: string;
}

export function evaluateBenchmarkPass(
  pass: Pick<
    BenchmarkPassResult,
    "rollingP95Ms" | "hitches50" | "hitches100" | "droppedRatioPct" | "ingestPeakPtsPerSec" | "renderedPeak"
  >,
  threshold: BenchmarkThreshold,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (pass.rollingP95Ms > threshold.maxRollingP95Ms) failures.push("rollingP95Ms");
  if (pass.hitches50 > threshold.maxHitches50) failures.push("hitches50");
  if (pass.hitches100 > threshold.maxHitches100) failures.push("hitches100");
  if (pass.droppedRatioPct > threshold.maxDroppedRatioPct) failures.push("droppedRatioPct");
  if (pass.ingestPeakPtsPerSec < threshold.minIngestPeakPtsPerSec) failures.push("ingestPeakPtsPerSec");
  if (pass.renderedPeak < threshold.minRenderedPeak) failures.push("renderedPeak");
  return { passed: failures.length === 0, failures };
}

export function formatBenchmarkGateDiagnostics(
  baselineId: string,
  failures: string[],
): string {
  return `Benchmark gate failed for baseline "${baselineId}": ${failures.join(", ")}`;
}

export function assertBenchmarkGatePassed(
  pass: Pick<
    BenchmarkPassResult,
    "rollingP95Ms" | "hitches50" | "hitches100" | "droppedRatioPct" | "ingestPeakPtsPerSec" | "renderedPeak"
  >,
  threshold: BenchmarkThreshold,
  baselineId: string,
): void {
  const gate = evaluateBenchmarkPass(pass, threshold);
  if (!gate.passed) {
    throw new Error(formatBenchmarkGateDiagnostics(baselineId, gate.failures));
  }
}

export function buildBenchmarkReport(
  profile: BenchmarkProfile,
  passes: BenchmarkPassResult[],
  multiRunSummary?: BenchmarkReport["multiRunSummary"],
  thresholds?: BenchmarkReport["thresholds"],
): BenchmarkReport {
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    environment: {
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      viewportWidth: typeof window !== "undefined" ? window.innerWidth : 0,
      viewportHeight: typeof window !== "undefined" ? window.innerHeight : 0,
      devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : 1
    },
    profile: { ...profile },
    warmup: {
      warmupSec: profile.warmupSec,
      excludedFromAvgP95Hitches: true
    },
    thresholds,
    passes,
    multiRunSummary
  };
}

export function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  const pass = report.passes[report.passes.length - 1];
  const p95 = pass ? pass.rollingP95Ms.toFixed(2) : "0.00";
  const avg = pass ? pass.avgFrameMs.toFixed(2) : "0.00";
  const dropped = pass ? pass.droppedRatioPct.toFixed(2) : "0.00";
  const gate = pass?.gatePassed === undefined
    ? "n/a"
    : pass.gatePassed
      ? "pass"
      : `fail (${pass.gateFailures?.join(", ") ?? "unknown"})`;
  return [
    "# PointFlow Benchmark Summary",
    "",
    `- Timestamp: ${report.timestamp}`,
    `- Profile: ${report.profile.label} (${report.profile.id})`,
    `- Passes: ${report.passes.length}`,
    `- Last pass avg frame (ms): ${avg}`,
    `- Last pass p95 frame (ms): ${p95}`,
    `- Last pass dropped ratio (%): ${dropped}`,
    `- Gate: ${gate}`,
  ].join("\n");
}

export function buildBenchmarkArtifacts(
  profile: BenchmarkProfile,
  passes: BenchmarkPassResult[],
  multiRunSummary?: BenchmarkReport["multiRunSummary"],
  thresholds?: BenchmarkReport["thresholds"],
): BenchmarkArtifacts {
  const schema = buildBenchmarkReport(profile, passes, multiRunSummary, thresholds);
  return {
    schema,
    markdownSummary: formatBenchmarkMarkdown(schema),
  };
}

export function createPassResult(
  passIndex: number,
  durationSec: number,
  warmupSec: number,
  elapsedMs: number,
  agg: {
    samples: number;
    frameTimeSumMs: number;
    hitches50: number;
    hitches100: number;
    rollingP95Ms: number;
    maxHeapMb: number;
    peakIngestRate: number;
    peakRenderedPoints: number;
    minFps: number;
    maxFps: number;
  },
  stats: { totalPoints: number; droppedPoints: number; isUnderPressure: boolean },
  opts: {
    requestedBackend: string;
    activeBackend: string;
    fallbackActive: boolean;
    workerMode: boolean;
    frustumCulling: boolean;
    autoLod: boolean;
    heapCurrentMb: number | null;
    importanceSamplingEnabled: boolean;
  }
): BenchmarkPassResult {
  const ingested = stats.totalPoints + stats.droppedPoints;
  const droppedRatioPct = ingested > 0 ? (stats.droppedPoints / ingested) * 100 : 0;
  const avgFrameMs = agg.samples > 0 ? agg.frameTimeSumMs / agg.samples : 0;
  return {
    passIndex,
    durationSec,
    warmupSec,
    elapsedMs,
    avgFrameMs,
    rollingP95Ms: agg.rollingP95Ms,
    hitches50: agg.hitches50,
    hitches100: agg.hitches100,
    heapCurrentMb: opts.heapCurrentMb,
    heapMaxMb: agg.maxHeapMb,
    ingestPeakPtsPerSec: agg.peakIngestRate,
    ingestTotal: ingested,
    droppedPoints: stats.droppedPoints,
    droppedRatioPct,
    bufferKept: stats.totalPoints,
    pressure: stats.isUnderPressure,
    renderedPeak: agg.peakRenderedPoints,
    minFps: Number.isFinite(agg.minFps) ? agg.minFps : 0,
    maxFps: agg.maxFps,
    requestedBackend: opts.requestedBackend,
    activeBackend: opts.activeBackend,
    fallbackActive: opts.fallbackActive,
    workerMode: opts.workerMode,
    frustumCulling: opts.frustumCulling,
    autoLod: opts.autoLod,
    importanceSamplingEnabled: opts.importanceSamplingEnabled
  };
}

export function getReducedMotionDurationSec(profile: BenchmarkProfile): number {
  const reduced = Math.max(10, Math.floor(profile.durationSec * 0.5));
  return reduced;
}

export function getFixedProfileIds(): Exclude<BenchmarkProfileId, "custom">[] {
  return [...FIXED_PROFILE_IDS];
}
