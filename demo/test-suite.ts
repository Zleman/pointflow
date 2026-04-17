import type { RendererBackend } from "pointflow";
import type { AttributeProfile } from "./constants";
import type { BenchmarkPassResult } from "./benchmark";

// ── Profile definition ────────────────────────────────────────────────────────

export interface TestProfile {
  id: string;
  label: string;
  description: string;
  durationSec: number;
  warmupSec: number;
  // Ingest / buffer
  maxPoints: number;
  pointsPerChunk: number;
  intervalMs: number;
  // Renderer and LOD
  autoLod: boolean;
  frustumCulling: boolean;
  requestedBackend: RendererBackend;
  // Attributes
  attributeProfile: AttributeProfile;
  colorBy: string;
  // Importance engine
  importanceField: string;
  maxStalenessMs: number;
  importanceSamplingEnabled: boolean;
  // Temporal filter
  timeWindowMs: number;
  /**
   * When true the master runner pauses at this step and waits for the user
   * to perform a manual action before continuing. The result is captured
   * via the "Continue" button rather than the automatic benchmark flow.
   */
  manual?: true;
  manualInstructions?: string;
}

export const TEST_PROFILES: readonly TestProfile[] = [
  // ── 50K group (9 profiles, zero GPU context changes between them) ────────────
  {
    id: "sub-capacity-stream",
    label: "Sub-capacity stream",
    description: "Ring buffer well below threshold - pure append path, no eviction firing.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 50, intervalMs: 100,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  {
    id: "at-capacity-stream",
    label: "At-capacity stream",
    description: "Eviction fires continuously - importance scoring active on the hot path.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 500, intervalMs: 50,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  {
    id: "stress-backpressure",
    label: "Stress - backpressure",
    description: "Ingest far exceeds capacity - backpressure ceiling, maximum drop ratio.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 2000, intervalMs: 16,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  {
    id: "temporal-2s-window",
    label: "Temporal - 2s window",
    description: "Only points ingested in the last 2s render. windowedCount should be < totalCount.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 500, intervalMs: 100,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 2000,
  },
  {
    id: "temporal-10s-window",
    label: "Temporal - 10s window",
    description: "10s temporal window - most points visible, gradual fade of oldest.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 500, intervalMs: 100,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 10_000,
  },
  {
    id: "importance-velocity",
    label: "Importance - velocity field",
    description: "Importance field=velocity + GPU sampling. High-velocity points retained over low.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 500, intervalMs: 50,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "velocity", maxStalenessMs: 0, importanceSamplingEnabled: true, timeWindowMs: 0,
  },
  {
    id: "importance-staleness",
    label: "Importance - staleness decay",
    description: "3s staleness half-life. Points older than ~3s score near zero and evict first.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 500, intervalMs: 50,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 3000, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  {
    id: "multi-attribute",
    label: "Multi-attribute (4 attrs)",
    description: "Quad attribute profile - velocity, intensity, temperature, pressure.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 500, intervalMs: 50,
    attributeProfile: "quad", colorBy: "intensity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  {
    id: "webgl-forced",
    label: "Renderer - WebGL forced",
    description: "WebGL backend forced. Same API - no quality or metric regression expected.",
    durationSec: 30, warmupSec: 15,
    maxPoints: 50_000, pointsPerChunk: 500, intervalMs: 50,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "webgl",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  // ── 500K group (1 GPU context remount from 50K) ───────────────────────────
  {
    id: "scale-500k",
    label: "Scale - 500K pts",
    description: "500K retained points - crossover zone for comparative measurement.",
    durationSec: 45, warmupSec: 8,
    maxPoints: 500_000, pointsPerChunk: 500, intervalMs: 28,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  // ── 1M group (1 GPU context remount from 500K, zero between them) ─────────
  {
    id: "scale-1m",
    label: "Scale - 1M pts",
    description: "1M retained points - upper streaming scale target.",
    durationSec: 60, warmupSec: 8,
    maxPoints: 1_000_000, pointsPerChunk: 500, intervalMs: 28,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  {
    id: "lod-auto",
    label: "LOD - auto",
    description: "Auto-LOD active. LOD step increases with camera distance.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 1_000_000, pointsPerChunk: 500, intervalMs: 28,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  {
    id: "lod-disabled",
    label: "LOD - disabled",
    description: "LOD off - full point count at all distances. Higher frame time expected vs auto.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 1_000_000, pointsPerChunk: 500, intervalMs: 28,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: false, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
  },
  {
    id: "compare-fifo-vs-importance",
    label: "FIFO vs Importance",
    description: "Side-by-side: pure FIFO (left) vs K=16 importance engine (right), same stream.",
    durationSec: 30, warmupSec: 5,
    maxPoints: 50_000, pointsPerChunk: 500, intervalMs: 100,
    attributeProfile: "single", colorBy: "velocity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "velocity", maxStalenessMs: 5000, importanceSamplingEnabled: true, timeWindowMs: 0,
    manual: true,
    manualInstructions: "Switch to Compare mode. Set importance field=velocity, staleness=5s, GPU sampling=on. Start streaming and let it run for 30s. Click Continue to record metrics.",
  },
  {
    id: "copc-autzen",
    label: "COPC - static file load",
    description: "COPC tile streaming via range requests. Time to first tile, FPS at full load.",
    durationSec: 60, warmupSec: 0,
    maxPoints: 500_000, pointsPerChunk: 0, intervalMs: 0,
    attributeProfile: "single", colorBy: "intensity",
    autoLod: true, frustumCulling: true, requestedBackend: "auto",
    importanceField: "", maxStalenessMs: 0, importanceSamplingEnabled: false, timeWindowMs: 0,
    manual: true,
    manualInstructions: "Switch to File mode. Load a COPC or LAS file. Wait until it is fully rendered (no further tile loading visible). Click Continue to capture metrics.",
  },
] as const;

// ── Result types ──────────────────────────────────────────────────────────────

export interface SuiteFeatureMetrics {
  /** windowedCount / totalCount at end of run. Only meaningful for temporal profiles. */
  windowedCount?: number;
  totalCount?: number;
  windowedRatio?: number;
  /** Oldest retained point age in ms at end of run. Only meaningful for importance/staleness profiles. */
  oldestRetainedAgeMs?: number;
  /** LOD level active at end of run. Camera-distance-dependent. */
  effectiveLodLevel?: number;
  cameraDistance?: number;
}

export interface SuiteProfileResult {
  profileId: string;
  profileLabel: string;
  profileDescription: string;
  /** Full benchmark pass data - same shape as a single benchmark run. */
  passResult: BenchmarkPassResult;
  featureMetrics: SuiteFeatureMetrics;
  capturedAt: string;
  /** Set when the profile was skipped (suite stopped before reaching it). */
  skipped?: true;
}

export interface SuiteReport {
  schemaVersion: 1;
  suiteName: "PointFlow M14 Stage 0";
  timestamp: string;
  environment: {
    userAgent: string;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
  };
  /** Total automated duration in seconds (manual profiles excluded). */
  totalAutomatedDurationSec: number;
  profileResults: SuiteProfileResult[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function buildSuiteReport(results: SuiteProfileResult[]): SuiteReport {
  const automated = TEST_PROFILES.filter(p => !p.manual);
  const totalSec = automated.reduce((s, p) => s + p.durationSec, 0);
  return {
    schemaVersion: 1,
    suiteName: "PointFlow M14 Stage 0",
    timestamp: new Date().toISOString(),
    environment: {
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      viewportWidth: typeof window !== "undefined" ? window.innerWidth : 0,
      viewportHeight: typeof window !== "undefined" ? window.innerHeight : 0,
      devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    },
    totalAutomatedDurationSec: totalSec,
    profileResults: results,
  };
}

/** Total estimated wall-clock time in seconds for the automated profiles. */
export function estimatedSuiteDurationSec(): number {
  const TRANSITION_OVERHEAD_SEC = 8; // remount + warmup buffer per profile
  return TEST_PROFILES
    .filter(p => !p.manual)
    .reduce((s, p) => s + p.durationSec + TRANSITION_OVERHEAD_SEC, 0);
}
