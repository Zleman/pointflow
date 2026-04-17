import type {
  CopcFileViewSnapshot,
  RendererBackend,
  RuntimeMode,
  StreamedPointCloudRef,
  StreamedPointCloudRenderMetrics,
} from "pointflow";
import type React from "react";
import type { BenchmarkPassResult, BenchmarkProfileId } from "./benchmark";
import type { AttributeProfile } from "./constants";
import type { MockStreamShape } from "./utils";

type FixedBenchmarkProfileId = Exclude<BenchmarkProfileId, "custom">;

type AttributeProfileConfig = {
  label: string;
  keys: string[];
};

type BenchmarkProfilesMap = Record<FixedBenchmarkProfileId, { label: string; durationSec: number }>;

export type DemoCanvas = {
  demoMode: "stream" | "file" | "compare";
  setDemoMode: (mode: "stream" | "file" | "compare") => void;
  apiRef: React.MutableRefObject<StreamedPointCloudRef | null>;
  apiReady: boolean;
  setApiReady: (value: boolean) => void;
  setActiveBackend: (value: "webgl" | "webgpu") => void;
  setStats: (stats: { totalPoints: number; droppedPoints: number; isUnderPressure: boolean }) => void;
  streaming: boolean;
  maxPoints: number;
  benchmarkProfileId: BenchmarkProfileId;
  setBenchmarkProfileId: (value: BenchmarkProfileId) => void;
  customDurationSec: number;
  setCustomDurationSec: (value: number) => void;
  customMaxPoints: number;
  setCustomMaxPoints: (value: number) => void;
  customPointsPerChunk: number;
  setCustomPointsPerChunk: (value: number) => void;
  customIntervalMs: number;
  setCustomIntervalMs: (value: number) => void;
  streamShape: MockStreamShape;
  setStreamShape: (value: MockStreamShape) => void;
  useDynamicAlloc: boolean;
  setUseDynamicAlloc: (value: boolean) => void;
  ingestConfig: { pointsPerChunk: number; intervalMs: number };
  ingestConfigLabel: string;
  benchmarkRunning: boolean;
  lastBenchmarkReport: {
    passes: BenchmarkPassResult[];
    multiRunSummary?: {
      avgFrameMsMean: number;
      rollingP95MsMean: number;
      hitches50Total: number;
      hitches100Total: number;
    };
  } | null;
  isCustomProfile: boolean;
  workerMode: boolean;
  setWorkerMode: (value: boolean | ((prev: boolean) => boolean)) => void;
  adaptiveRefresh: boolean;
  setAdaptiveRefresh: (value: boolean | ((prev: boolean) => boolean)) => void;
  workerCulling: boolean;
  setWorkerCulling: (value: boolean | ((prev: boolean) => boolean)) => void;
  attributeProfile: string;
  setAttributeProfile: (value: AttributeProfile) => void;
  attributeProfileConfig: AttributeProfileConfig;
  colorBy: string;
  setColorBy: (value: string) => void;
  requestedBackend: RendererBackend;
  setRequestedBackend: (value: RendererBackend) => void;
  activeBackend: "webgl" | "webgpu";
  frustumCulling: boolean;
  setFrustumCulling: (value: boolean | ((prev: boolean) => boolean)) => void;
  autoLod: boolean;
  setAutoLod: (value: boolean | ((prev: boolean) => boolean)) => void;
  manualLodLevel: number;
  setManualLodLevel: (value: number) => void;
  runtimeMode: RuntimeMode;
  setRuntimeMode: (value: RuntimeMode) => void;
  importanceField: string;
  setImportanceField: (value: string) => void;
  maxStalenessMs: number;
  setMaxStalenessMs: (value: number) => void;
  importanceSamplingEnabled: boolean;
  setImportanceSamplingEnabled: (value: boolean) => void;
  timeWindowMs: number;
  setTimeWindowMs: (value: number) => void;
  setTemporalStats: (stats: {
    oldestPointAgeMs: number;
    newestPointAgeMs: number;
    windowedCount: number;
    totalCount: number;
  } | null) => void;
  handleStart: () => void;
  handleStop: () => void;
  handleExportBenchmarkJson: () => void;
  renderMetricsRef: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  fileViewSnapshotRef: React.MutableRefObject<CopcFileViewSnapshot | null>;
  compareLeftRenderMetricsRef: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  compareRightRenderMetricsRef: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  copyReport: () => Promise<void>;
  getFixedProfileIds: () => FixedBenchmarkProfileId[];
  BENCHMARK_PROFILES: BenchmarkProfilesMap;
  compareLeftApiRef: React.MutableRefObject<StreamedPointCloudRef | null>;
  compareRightApiRef: React.MutableRefObject<StreamedPointCloudRef | null>;
  compareStreaming: boolean;
  compareLeftReady: boolean;
  setCompareLeftReady: (value: boolean) => void;
  compareRightReady: boolean;
  setCompareRightReady: (value: boolean) => void;
  compareColorBy: string;
  setCompareColorBy: (value: string) => void;
  compareMaxPoints: number;
  setCompareMaxPoints: (value: number) => void;
  compareImportanceField: string;
  setCompareImportanceField: (value: string) => void;
  compareMaxStalenessMs: number;
  setCompareMaxStalenessMs: (value: number) => void;
  compareImportanceSamplingEnabled: boolean;
  setCompareImportanceSamplingEnabled: (value: boolean) => void;
  comparePointsPerChunk: number;
  setComparePointsPerChunk: (value: number) => void;
  compareIntervalMs: number;
  setCompareIntervalMs: (value: number) => void;
  handleCompareStart: () => void;
  handleCompareStop: () => void;
  setCompareLeftStats: React.Dispatch<React.SetStateAction<{ totalPoints: number; droppedPoints: number }>>;
  setCompareRightStats: React.Dispatch<React.SetStateAction<{ totalPoints: number; droppedPoints: number }>>;
  copyCompareReport: () => Promise<void>;
  copyFileReport: () => Promise<void>;
};

export type DemoHud = {
  runDurationSec: number;
  ingestRate: number;
  renderedPoints: number;
  effectiveLodLevel: number;
  cameraDistance: number;
  fps: number;
  frameTimeMs: number;
  rollingP95Ms: number;
  hitches50: number;
  hitches100: number;
  heapMb: number | null;
  stats: {
    droppedPoints: number;
    totalPoints: number;
    isUnderPressure: boolean;
  };
  ingestedPoints: number;
  droppedRatio: number;
  oldestRetainedAgeMs: number;
  temporalStats: {
    oldestPointAgeMs: number;
    newestPointAgeMs: number;
    windowedCount: number;
    totalCount: number;
  } | null;
  compareIngestRate: number;
  compareLeftRenderedPoints: number;
  compareRightRenderedPoints: number;
  compareLeftFps: number;
  compareRightFps: number;
  compareLeftStats: {
    droppedPoints: number;
    totalPoints: number;
    isUnderPressure?: boolean;
  };
  compareRightStats: {
    droppedPoints: number;
    totalPoints: number;
    isUnderPressure?: boolean;
  };
};
