import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { StreamedPointCloudRef, StreamedPointCloudRenderMetrics } from "pointflow";
import {
  formatBenchmarkGateDiagnostics,
  BENCHMARK_PROFILES,
  buildBenchmarkReport,
  createPassResult,
  evaluateBenchmarkPass,
  getReducedMotionDurationSec,
  type BenchmarkProfile,
  type BenchmarkProfileId,
  type BenchmarkReport,
} from "../benchmark";
import {
  ATTRIBUTE_PROFILES,
  BENCHMARK_BASELINES,
  DEFAULT_WARMUP_MS,
  FPS_OUTLIER_MAX,
  FPS_OUTLIER_MIN,
  HITCH_50_MS,
  HITCH_100_MS,
  PROFILE_FORCED,
  ROLLING_P95_SAMPLES,
  TAB_RESTORE_FRAME_MS,
} from "../constants";
import { useCanvasConfig, useCanvasConfigDispatch } from "../contexts/CanvasConfigContext";
import { useBenchmarkState, useBenchmarkDispatch } from "../contexts/BenchmarkContext";
import { useHudMetrics, useHudDispatch } from "../contexts/HudContext";
import { makeMockChunk, p95FromSorted, resetMockSequence, type MockStreamShape } from "../utils";
import {
  ATTRIBUTE_KEY_LABELS,
  INGEST_MODE_REPORT_LABELS,
  REQUESTED_BACKEND_LABELS,
  RESOLVED_BACKEND_LABELS,
  STREAM_SHAPE_REPORT_LABELS,
} from "../ui-options";
import { createInitialRunAggregate } from "./benchmark/run-lifecycle";
import { applyBenchmarkProfileSelection } from "./benchmark/profile-config";
import { buildSoakReportText } from "./benchmark/reporting";

interface MemoryPerformance extends Performance {
  memory?: { usedJSHeapSize: number };
}

export interface FeatureSnapshot {
  effectiveLodLevel: number;
  cameraDistance: number;
  oldestRetainedAgeMs: number;
  temporalWindowedCount: number;
  temporalTotalCount: number;
}

export function useBenchmarkRunner({
  apiRef,
  renderMetricsRef,
  featureSnapshotRef,
}: {
  apiRef: MutableRefObject<StreamedPointCloudRef | null>;
  renderMetricsRef: MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  featureSnapshotRef: MutableRefObject<FeatureSnapshot>;
}) {
  // ── Context reads ─────────────────────────────────────────────────────────
  const {
    maxPoints, colorBy, requestedBackend, activeBackend,
    frustumCulling, autoLod, manualLodLevel, workerMode,
    attributeProfile, importanceField, maxStalenessMs,
    importanceSamplingEnabled, apiReady,
  } = useCanvasConfig();
  const canvasConfigDispatch = useCanvasConfigDispatch();

  const {
    streaming, benchmarkRunning, benchmarkProfileId,
    customDurationSec, customMaxPoints, customPointsPerChunk, customIntervalMs,
    lastBenchmarkReport, streamShape,
  } = useBenchmarkState();
  const benchmarkDispatch = useBenchmarkDispatch();

  const {
    stats, effectiveLodLevel, cameraDistance, fps, frameTimeMs, heapMb,
    renderedPoints, runDurationSec, oldestRetainedAgeMs, rollingP95Ms,
    ingestedPoints, droppedRatio,
  } = useHudMetrics();
  const hudDispatch = useHudDispatch();

  // Always-current stats ref - avoids stale closures in benchmark timeout callbacks.
  const latestStatsRef = useRef(stats);
  latestStatsRef.current = stats;

  // ── Benchmark dispatch wrappers ───────────────────────────────────────────
  const setStreaming             = (value: boolean)                => benchmarkDispatch({ type: "SET_STREAMING", value });
  const setBenchmarkRunning     = (value: boolean)                => benchmarkDispatch({ type: "SET_BENCHMARK_RUNNING", value });
  const setLastBenchmarkReport  = (value: BenchmarkReport | null) => benchmarkDispatch({ type: "SET_LAST_BENCHMARK_REPORT", value });
  const setBenchmarkProfileIdRaw = (value: BenchmarkProfileId)    => benchmarkDispatch({ type: "SET_BENCHMARK_PROFILE_ID", value });
  const setCustomPointsPerChunk  = (value: number)                => benchmarkDispatch({ type: "SET_CUSTOM_POINTS_PER_CHUNK", value });
  const setCustomIntervalMs      = (value: number)                => benchmarkDispatch({ type: "SET_CUSTOM_INTERVAL_MS", value });
  const setCustomMaxPoints       = (value: number)                => benchmarkDispatch({ type: "SET_CUSTOM_MAX_POINTS", value });
  const setStreamShape           = (value: MockStreamShape)       => benchmarkDispatch({ type: "SET_STREAM_SHAPE", value });
  // ── Internal refs ─────────────────────────────────────────────────────────
  const intervalRef              = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingBenchmarkRef      = useRef<{ profile: BenchmarkProfile; runAt: number } | null>(null);
  const currentBenchmarkProfileRef = useRef<BenchmarkProfile | null>(null);
  const benchmarkTimeoutRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const multiRunPassesRef        = useRef<BenchmarkReport["passes"]>([]);
  const multiRunRemainingRef     = useRef(0);
  const ingestCounterRef         = useRef(0);
  const frameSamplesRef          = useRef<number[]>([]);
  const runStartedAtRef          = useRef<number | null>(null);
  const warmupMsRef              = useRef(DEFAULT_WARMUP_MS);
  const runAggRef = useRef(createInitialRunAggregate());

  // ── Derived ───────────────────────────────────────────────────────────────
  const isCustomProfile = benchmarkProfileId === "custom";
  const ingestConfig = isCustomProfile
    ? { pointsPerChunk: customPointsPerChunk, intervalMs: customIntervalMs }
    : BENCHMARK_PROFILES[benchmarkProfileId as Exclude<BenchmarkProfileId, "custom">];
  const ingestConfigLabel = isCustomProfile
    ? `${customPointsPerChunk}/${customIntervalMs}ms`
    : benchmarkProfileId;
  const attributeProfileConfig = ATTRIBUTE_PROFILES[attributeProfile];

  // ── Profile selection ─────────────────────────────────────────────────────
  const setBenchmarkProfileId = (id: BenchmarkProfileId) => {
    applyBenchmarkProfileSelection({
      id,
      setBenchmarkProfileIdRaw,
      setCustomPointsPerChunk,
      setCustomIntervalMs,
      setCustomMaxPoints,
    });
  };

  // ── Stream control ────────────────────────────────────────────────────────
  const handleStart = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    resetMockSequence();
    apiRef.current?.reset();
    runStartedAtRef.current = Date.now();
    warmupMsRef.current = DEFAULT_WARMUP_MS;
    hudDispatch({ type: "SET_RUN_DURATION_SEC", value: 0 });
    hudDispatch({ type: "RESET_HITCHES" });
    frameSamplesRef.current = [];
    runAggRef.current = createInitialRunAggregate();
    intervalRef.current = setInterval(() => {
      const chunk = makeMockChunk(ingestConfig.pointsPerChunk, attributeProfile, streamShape);
      ingestCounterRef.current += chunk.points.length;
      apiRef.current?.pushChunk(chunk);
    }, ingestConfig.intervalMs);
    setStreaming(true);
  };

  const handleStop = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (benchmarkTimeoutRef.current) {
      clearTimeout(benchmarkTimeoutRef.current);
      benchmarkTimeoutRef.current = null;
    }
    const profile = currentBenchmarkProfileRef.current;
    if (profile) {
      currentBenchmarkProfileRef.current = null;
      setTimeout(() => finishBenchmarkRun(profile), 100);
    }
    setStreaming(false);
  };

  // ── Benchmark run lifecycle ───────────────────────────────────────────────
  function getProfileForRun(): BenchmarkProfile {
    if (benchmarkProfileId === "custom") {
      return {
        id: "custom", label: "Custom",
        maxPoints: customMaxPoints,
        pointsPerChunk: customPointsPerChunk,
        intervalMs: customIntervalMs,
        durationSec: customDurationSec,
        warmupSec: 5,
      };
    }
    return BENCHMARK_PROFILES[benchmarkProfileId as Exclude<BenchmarkProfileId, "custom">];
  }

  const finishBenchmarkRun = (profile: BenchmarkProfile) => {
    const agg = runAggRef.current;
    const pass = createPassResult(
      multiRunPassesRef.current.length,
      profile.durationSec, profile.warmupSec,
      Date.now() - (runStartedAtRef.current ?? 0),
      agg, latestStatsRef.current,
      {
        requestedBackend, activeBackend,
        fallbackActive: requestedBackend === "webgpu" && activeBackend === "webgl",
        workerMode, frustumCulling, autoLod,
        heapCurrentMb: heapMb,
        importanceSamplingEnabled,
      }
    );
    const baseline = BENCHMARK_BASELINES[profile.id];
    if (baseline) {
      const gate = evaluateBenchmarkPass(pass, baseline);
      pass.baselineId = profile.id;
      pass.gatePassed = gate.passed;
      pass.gateFailures = gate.failures;
      pass.gateDiagnostics = gate.passed ? undefined : formatBenchmarkGateDiagnostics(profile.id, gate.failures);
    }
    benchmarkTimeoutRef.current = null;
    currentBenchmarkProfileRef.current = null;
    if (multiRunRemainingRef.current > 0) {
      multiRunPassesRef.current.push(pass);
      multiRunRemainingRef.current -= 1;
      if (multiRunRemainingRef.current > 0) {
        pendingBenchmarkRef.current = { profile, runAt: Date.now() };
        setBenchmarkRunning(true);
        return;
      }
      const passes = [...multiRunPassesRef.current];
      multiRunPassesRef.current = [];
      const report = buildBenchmarkReport(profile, passes, {
        runs: passes.length,
        avgFrameMsMean:   passes.reduce((s, p) => s + p.avgFrameMs, 0)   / passes.length,
        rollingP95MsMean: passes.reduce((s, p) => s + p.rollingP95Ms, 0) / passes.length,
        hitches50Total:   passes.reduce((s, p) => s + p.hitches50, 0),
        hitches100Total:  passes.reduce((s, p) => s + p.hitches100, 0),
      }, baseline ? { baselineId: profile.id, values: baseline } : undefined);
      setLastBenchmarkReport(report);
    } else {
      setLastBenchmarkReport(
        buildBenchmarkReport(profile, [pass], undefined, baseline ? { baselineId: profile.id, values: baseline } : undefined)
      );
    }
    setBenchmarkRunning(false);
  };

  const handleRunBenchmark = () => {
    if (streaming || benchmarkRunning) return;
    const profile = getProfileForRun();
    canvasConfigDispatch({ type: "SET_MAX_POINTS", value: profile.maxPoints });
    if (profile.id !== "custom") {
      const ap = PROFILE_FORCED.attributeProfile;
      canvasConfigDispatch({ type: "SET_COLOR_BY", value: PROFILE_FORCED.colorBy });
      canvasConfigDispatch({
        type: "SET_ATTRIBUTE_PROFILE",
        value: ap,
        availableKeys: ATTRIBUTE_PROFILES[ap].keys,
      });
      canvasConfigDispatch({ type: "SET_FRUSTUM_CULLING", value: PROFILE_FORCED.frustumCulling });
      canvasConfigDispatch({ type: "SET_AUTO_LOD", value: PROFILE_FORCED.autoLod });
      canvasConfigDispatch({ type: "SET_WORKER_MODE", value: PROFILE_FORCED.workerMode });
      canvasConfigDispatch({ type: "SET_ADAPTIVE_REFRESH", value: PROFILE_FORCED.adaptiveRefresh });
      canvasConfigDispatch({ type: "SET_WORKER_CULLING", value: PROFILE_FORCED.workerCulling });
      canvasConfigDispatch({ type: "SET_REQUESTED_BACKEND", value: PROFILE_FORCED.requestedBackend });
    }
    warmupMsRef.current = profile.warmupSec * 1000;
    setBenchmarkRunning(true);
    pendingBenchmarkRef.current = { profile, runAt: Date.now() };
  };

  // Fires once per benchmarkRunning→true transition after the canvas is ready.
  useEffect(() => {
    if (!benchmarkRunning || !apiReady || !pendingBenchmarkRef.current || streaming) return;
    const { profile } = pendingBenchmarkRef.current;
    pendingBenchmarkRef.current = null;
    currentBenchmarkProfileRef.current = profile;
    const durationSec =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? getReducedMotionDurationSec(profile)
        : profile.durationSec;
    handleStart();
    benchmarkTimeoutRef.current = setTimeout(() => handleStop(), durationSec * 1000);
  }, [benchmarkRunning, apiReady, streaming]);

  const handleRunBenchmark3x = () => {
    if (streaming || benchmarkRunning) return;
    multiRunPassesRef.current  = [];
    multiRunRemainingRef.current = 3;
    handleRunBenchmark();
  };

  const handleExportBenchmarkJson = () => {
    if (!lastBenchmarkReport) return;
    const json = JSON.stringify(lastBenchmarkReport, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pointflow-bench-${lastBenchmarkReport.profile.id}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── Streaming interval - restarts when ingest config or attributeProfile changes ──
  useEffect(() => {
    if (!streaming) return;
    const profile = currentBenchmarkProfileRef.current;
    const config = profile ?? ingestConfig;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const chunk = makeMockChunk(config.pointsPerChunk, attributeProfile, streamShape);
      ingestCounterRef.current += chunk.points.length;
      apiRef.current?.pushChunk(chunk);
    }, config.intervalMs);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [streaming, ingestConfig.pointsPerChunk, ingestConfig.intervalMs, attributeProfile, streamShape]);

  // ── Ingest rate + run duration + heap - 1-second tick ────────────────────
  useEffect(() => {
    const rateTimer = setInterval(() => {
      const rate = ingestCounterRef.current;
      hudDispatch({ type: "SET_INGEST_RATE", value: rate });
      runAggRef.current.peakIngestRate = Math.max(runAggRef.current.peakIngestRate, rate);
      ingestCounterRef.current = 0;
      if (streaming && runStartedAtRef.current !== null) {
        hudDispatch({ type: "SET_RUN_DURATION_SEC", value: Math.floor((Date.now() - runStartedAtRef.current) / 1000) });
      }
      const perf = performance as MemoryPerformance;
      if (perf.memory) {
        const heap = perf.memory.usedJSHeapSize / 1024 / 1024;
        hudDispatch({ type: "SET_HEAP_MB", value: heap });
        runAggRef.current.maxHeapMb = Math.max(runAggRef.current.maxHeapMb, heap);
      }
    }, 1000);
    return () => {
      clearInterval(rateTimer);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [streaming]);

  // ── Render metrics - processes each frame via the 200ms polled ref ────────
  const handleRenderMetrics = useCallback((metrics: {
    renderedPoints: number;
    effectiveLodLevel: number;
    cameraDistance: number;
    frameTimeMs: number;
    fps: number;
  }) => {
    if (document.visibilityState !== "visible") return;
    const { frameTimeMs: ft, fps: f } = metrics;
    if (f <= FPS_OUTLIER_MIN || f > FPS_OUTLIER_MAX) return;

    featureSnapshotRef.current.effectiveLodLevel = metrics.effectiveLodLevel;
    featureSnapshotRef.current.cameraDistance    = metrics.cameraDistance;
    const retainedAge = apiRef.current?.getOldestRetainedAgeMs() ?? 0;
    featureSnapshotRef.current.oldestRetainedAgeMs = retainedAge;

    const elapsed = runStartedAtRef.current !== null ? Date.now() - runStartedAtRef.current : 0;
    const pastWarmup = elapsed >= warmupMsRef.current;
    const isTabRestoreFrame = ft > TAB_RESTORE_FRAME_MS;

    if (!isTabRestoreFrame && pastWarmup) {
      frameSamplesRef.current.push(ft);
      if (frameSamplesRef.current.length > ROLLING_P95_SAMPLES) frameSamplesRef.current.shift();
      const sorted = [...frameSamplesRef.current].sort((a, b) => a - b);
      const p95 = p95FromSorted(sorted);
      runAggRef.current.samples       += 1;
      runAggRef.current.frameTimeSumMs += ft;
      runAggRef.current.rollingP95Ms   = p95;
      runAggRef.current.peakRenderedPoints = Math.max(runAggRef.current.peakRenderedPoints, metrics.renderedPoints);
      runAggRef.current.minFps = Math.min(runAggRef.current.minFps, f);
      runAggRef.current.maxFps = Math.max(runAggRef.current.maxFps, f);
      if (ft > HITCH_50_MS)  runAggRef.current.hitches50  += 1;
      if (ft > HITCH_100_MS) runAggRef.current.hitches100 += 1;
      hudDispatch({
        type: "FLUSH_RENDER_METRICS",
        renderedPoints:    metrics.renderedPoints,
        effectiveLodLevel: metrics.effectiveLodLevel,
        cameraDistance:    metrics.cameraDistance,
        fps: f, frameTimeMs: ft, rollingP95Ms: p95,
        hitches50Bump: ft > HITCH_50_MS, hitches100Bump: ft > HITCH_100_MS,
        oldestRetainedAgeMs: retainedAge,
      });
    } else {
      hudDispatch({
        type: "FLUSH_RENDER_METRICS",
        renderedPoints:    metrics.renderedPoints,
        effectiveLodLevel: metrics.effectiveLodLevel,
        cameraDistance:    metrics.cameraDistance,
        fps: f, frameTimeMs: ft,
        hitches50Bump: false, hitches100Bump: false,
        oldestRetainedAgeMs: retainedAge,
      });
    }
  }, []);

  const flushRenderMetricsRef = useRef(handleRenderMetrics);
  flushRenderMetricsRef.current = handleRenderMetrics;

  useEffect(() => {
    const id = setInterval(() => {
      const m = renderMetricsRef.current;
      if (m) flushRenderMetricsRef.current(m);
    }, 200);
    return () => clearInterval(id);
  }, []);

  // Track maxDroppedRatio for the benchmark report.
  useEffect(() => {
    const ingested = stats.totalPoints + stats.droppedPoints;
    const ratio = ingested > 0 ? (stats.droppedPoints / ingested) * 100 : 0;
    runAggRef.current.maxDroppedRatio = Math.max(runAggRef.current.maxDroppedRatio, ratio);
  }, [stats.totalPoints, stats.droppedPoints]);

  // ── Copy soak report ──────────────────────────────────────────────────────
  const copyReport = async () => {
    const agg = runAggRef.current;
    const attrKeysHuman = attributeProfileConfig.keys.map((k) => ATTRIBUTE_KEY_LABELS[k] ?? k).join(", ");
    const colorByHuman = ATTRIBUTE_KEY_LABELS[colorBy] ?? colorBy;
    const importanceHuman = ATTRIBUTE_KEY_LABELS[importanceField || ""];
    const kLookaheadLine =
      importanceField || maxStalenessMs > 0 ? "Active" : "Off (FIFO)";
    const report = buildSoakReportText({
      agg,
      ingestConfig,
      attributeProfileLabel: attributeProfileConfig.label,
      attrKeysHuman,
      colorByHuman,
      importanceHuman,
      kLookaheadLine,
      requestedBackendLabel: REQUESTED_BACKEND_LABELS[requestedBackend],
      resolvedBackendLabel: RESOLVED_BACKEND_LABELS[activeBackend],
      fallbackActive: requestedBackend === "webgpu" && activeBackend === "webgl",
      ingestModeLabel: workerMode ? INGEST_MODE_REPORT_LABELS.worker : INGEST_MODE_REPORT_LABELS.main,
      streamShapeLabel: STREAM_SHAPE_REPORT_LABELS[streamShape],
      maxPoints,
      frustumCulling,
      autoLod,
      effectiveLodLevel,
      manualLodLevel,
      runDurationSec,
      stats,
      droppedRatio,
      renderedPoints,
      cameraDistance,
      fps,
      frameTimeMs,
      heapMb,
      importanceSamplingEnabled,
      maxStalenessMs,
      oldestRetainedAgeMs,
    });
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      window.prompt("Copy metrics report:", report);
    }
  };

  return {
    // Handlers
    handleStart,
    handleStop,
    handleExportBenchmarkJson,
    setBenchmarkProfileId,
    copyReport,
    // Derived state (for slices)
    isCustomProfile,
    ingestConfig,
    ingestConfigLabel,
    attributeProfileConfig,
    // Raw benchmark state (for slices)
    streaming,
    benchmarkRunning,
    benchmarkProfileId,
    customDurationSec,
    customMaxPoints,
    customPointsPerChunk,
    customIntervalMs,
    streamShape,
    lastBenchmarkReport,
    // Dispatch wrappers
    setCustomDurationSec:  (value: number) => benchmarkDispatch({ type: "SET_CUSTOM_DURATION_SEC",  value }),
    setCustomMaxPoints:    (value: number) => benchmarkDispatch({ type: "SET_CUSTOM_MAX_POINTS",    value }),
    setCustomPointsPerChunk,
    setCustomIntervalMs,
    setStreamShape,
  };
}
