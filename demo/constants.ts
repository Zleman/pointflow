import type { RendererBackend } from "pointflow";

export type AttributeProfile = "single" | "quad";

export const ROLLING_P95_SAMPLES = 120;
export const FPS_OUTLIER_MIN = 0;
export const FPS_OUTLIER_MAX = 240;
export const HITCH_50_MS = 50;
export const HITCH_100_MS = 100;
export const TAB_RESTORE_FRAME_MS = 200;
export const DEFAULT_WARMUP_MS = 5000;

export interface BenchmarkThreshold {
  maxRollingP95Ms: number;
  maxHitches50: number;
  maxHitches100: number;
  maxDroppedRatioPct: number;
  minIngestPeakPtsPerSec: number;
  minRenderedPeak: number;
}

export const BENCHMARK_BASELINES: Record<string, BenchmarkThreshold> = {
  normal: {
    maxRollingP95Ms: 28,
    maxHitches50: 20,
    maxHitches100: 3,
    maxDroppedRatioPct: 8,
    minIngestPeakPtsPerSec: 400,
    minRenderedPeak: 20_000,
  },
  heavy: {
    maxRollingP95Ms: 36,
    maxHitches50: 30,
    maxHitches100: 6,
    maxDroppedRatioPct: 12,
    minIngestPeakPtsPerSec: 1_500,
    minRenderedPeak: 28_000,
  },
  extreme: {
    maxRollingP95Ms: 48,
    maxHitches50: 40,
    maxHitches100: 10,
    maxDroppedRatioPct: 18,
    minIngestPeakPtsPerSec: 3_000,
    minRenderedPeak: 30_000,
  },
  "1M": {
    maxRollingP95Ms: 58,
    maxHitches50: 60,
    maxHitches100: 20,
    maxDroppedRatioPct: 25,
    minIngestPeakPtsPerSec: 12_000,
    minRenderedPeak: 120_000,
  },
  copc: {
    maxRollingP95Ms: 40,
    maxHitches50: 40,
    maxHitches100: 10,
    maxDroppedRatioPct: 0,
    minIngestPeakPtsPerSec: 0,
    minRenderedPeak: 20_000,
  },
};

export const ATTRIBUTE_PROFILES: Record<
  AttributeProfile,
  { label: string; keys: string[] }
> = {
  single: { label: "1 attr", keys: ["velocity"] },
  quad: { label: "4 attrs", keys: ["velocity", "intensity", "temperature", "pressure"] }
};

export const PROFILE_FORCED = {
  frustumCulling: true,
  autoLod: true,
  workerMode: true as const,
  adaptiveRefresh: false,
  workerCulling: false,
  requestedBackend: "auto" as RendererBackend,
  attributeProfile: "single" as AttributeProfile,
  colorBy: "velocity"
};
