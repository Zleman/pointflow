import React, { createContext, useCallback, useContext, useMemo, useRef } from "react";
import type {
  CopcFileViewSnapshot,
  StreamedPointCloudRef,
  RendererBackend,
  RuntimeMode,
  StreamedPointCloudRenderMetrics,
} from "pointflow";
import { useFileState } from "./contexts/FileContext";
import { collectGpuReportLines, formatCopcFileReportLines } from "./copc-file-report";
import {
  BENCHMARK_PROFILES,
  getFixedProfileIds,
} from "./benchmark";
import { useCanvasConfig, useCanvasConfigDispatch } from "./contexts/CanvasConfigContext";
import { useCompareMode } from "./contexts/CompareContext";
import { useHudMetrics } from "./contexts/HudContext";
import { useBenchmarkRunner } from "./hooks/useBenchmarkRunner";
import type { DemoCanvas, DemoHud } from "./demo-types";
import { createDemoCanvasActions } from "./demo-canvas-actions";

const CanvasCtx = createContext<DemoCanvas | null>(null);
const HudCtx    = createContext<DemoHud    | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const fileState = useFileState();

  // ── Canvas config ────────────────────────────────────────────────────────
  const {
    demoMode, maxPoints, colorBy, requestedBackend, activeBackend,
    frustumCulling, autoLod, manualLodLevel, workerMode, adaptiveRefresh,
    workerCulling, attributeProfile, runtimeMode, importanceField,
    maxStalenessMs, importanceSamplingEnabled, useDynamicAlloc, timeWindowMs,
    apiReady,
  } = useCanvasConfig();
  const canvasConfigDispatch = useCanvasConfigDispatch();

  const {
    setDemoMode,
    setColorBy,
    setRequestedBackend,
    setActiveBackend,
    setFrustumCulling,
    setAutoLod,
    setManualLodLevel,
    setWorkerMode,
    setAdaptiveRefresh,
    setWorkerCulling,
    setAttributeProfile,
    setRuntimeMode,
    setImportanceField,
    setMaxStalenessMs,
    setImportanceSamplingEnabled,
    setUseDynamicAlloc,
    setTimeWindowMs,
    setApiReady,
  } = createDemoCanvasActions({
    dispatch: canvasConfigDispatch as unknown as (action: Record<string, unknown>) => void,
    frustumCulling,
    autoLod,
    workerMode,
    adaptiveRefresh,
    workerCulling,
  });

  // ── Compare mode ─────────────────────────────────────────────────────────
  const {
    compareStreaming, compareLeftReady, compareRightReady,
    compareColorBy, compareMaxPoints,
    compareImportanceField, compareMaxStalenessMs, compareImportanceSamplingEnabled,
    comparePointsPerChunk, compareIntervalMs,
    setCompareStreaming, setCompareLeftReady, setCompareRightReady,
    setCompareColorBy, setCompareMaxPoints,
    setCompareImportanceField, setCompareMaxStalenessMs, setCompareImportanceSamplingEnabled,
    setComparePointsPerChunk, setCompareIntervalMs,
    compareLeftApiRef, compareRightApiRef,
    compareLeftRenderMetricsRef, compareRightRenderMetricsRef,
    compareIngestRate,
    compareLeftRenderedPoints, compareRightRenderedPoints,
    compareLeftFps, compareRightFps,
    compareLeftStats, setCompareLeftStats,
    compareRightStats, setCompareRightStats,
    handleCompareStart, handleCompareStop,
    copyCompareReport,
  } = useCompareMode();

  // ── HUD metrics ───────────────────────────────────────────────────────────
  const {
    renderedPoints, effectiveLodLevel, cameraDistance,
    fps, frameTimeMs, rollingP95Ms,
    hitches50, hitches100, heapMb,
    stats, ingestRate, runDurationSec,
    oldestRetainedAgeMs, temporalStats,
    ingestedPoints, droppedRatio,
    hudDispatch, setStats,
  } = useHudMetrics();

  const setTemporalStats = useCallback((s: {
    oldestPointAgeMs: number;
    newestPointAgeMs: number;
    windowedCount: number;
    totalCount: number;
  } | null) => {
    featureSnapshotRef.current.temporalWindowedCount = s?.windowedCount ?? 0;
    featureSnapshotRef.current.temporalTotalCount    = s?.totalCount    ?? 0;
    hudDispatch({ type: "SET_TEMPORAL_STATS", stats: s });
  }, [hudDispatch]);

  // ── Shared refs ───────────────────────────────────────────────────────────
  const apiRef           = useRef<StreamedPointCloudRef | null>(null);
  const renderMetricsRef = useRef<StreamedPointCloudRenderMetrics | null>(null);
  const fileViewSnapshotRef = useRef<CopcFileViewSnapshot | null>(null);
  const featureSnapshotRef = useRef({
    effectiveLodLevel: 0, cameraDistance: 0, oldestRetainedAgeMs: 0,
    temporalWindowedCount: 0, temporalTotalCount: 0,
  });
  // ── Benchmark runner ──────────────────────────────────────────────────────
  const {
    handleStart, handleStop,
    handleExportBenchmarkJson,
    setBenchmarkProfileId, copyReport,
    isCustomProfile, ingestConfig, ingestConfigLabel, attributeProfileConfig,
    streaming, benchmarkRunning, benchmarkProfileId,
    customDurationSec, customMaxPoints, customPointsPerChunk, customIntervalMs,
    streamShape, lastBenchmarkReport,
    setCustomDurationSec, setCustomMaxPoints, setCustomPointsPerChunk, setCustomIntervalMs,
    setStreamShape,
  } = useBenchmarkRunner({ apiRef, renderMetricsRef, featureSnapshotRef });

  // ── Slices ────────────────────────────────────────────────────────────────

  const hud: DemoHud = useMemo(() => ({
    runDurationSec, ingestRate, renderedPoints, effectiveLodLevel, cameraDistance,
    fps, frameTimeMs, rollingP95Ms, hitches50, hitches100, heapMb, stats,
    ingestedPoints, droppedRatio, oldestRetainedAgeMs, temporalStats,
    compareIngestRate, compareLeftRenderedPoints, compareRightRenderedPoints,
    compareLeftFps, compareRightFps, compareLeftStats, compareRightStats,
  }), [
    runDurationSec, ingestRate, renderedPoints, effectiveLodLevel, cameraDistance,
    fps, frameTimeMs, rollingP95Ms, hitches50, hitches100, heapMb, stats,
    ingestedPoints, droppedRatio, oldestRetainedAgeMs, temporalStats,
    compareIngestRate, compareLeftRenderedPoints, compareRightRenderedPoints,
    compareLeftFps, compareRightFps, compareLeftStats, compareRightStats,
  ]);

  const copyFileReport = useCallback(async () => {
    const gpuLines = await collectGpuReportLines();
    const lines = formatCopcFileReportLines(fileViewSnapshotRef.current, {
      fileLabel: fileState.label,
      fileProgress: fileState.progress,
      heapMb,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      gpuLines,
    });
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copy file report:", text);
    }
  }, [fileState.label, fileState.progress, heapMb]);

  const canvas: DemoCanvas = useMemo(() => ({
    demoMode, setDemoMode, apiRef, apiReady, setApiReady, setActiveBackend, setStats,
    streaming, maxPoints, benchmarkProfileId, setBenchmarkProfileId,
    customDurationSec, setCustomDurationSec, customMaxPoints, setCustomMaxPoints,
    customPointsPerChunk, setCustomPointsPerChunk, customIntervalMs, setCustomIntervalMs,
    streamShape, setStreamShape,
    useDynamicAlloc, setUseDynamicAlloc, ingestConfig, ingestConfigLabel,
    benchmarkRunning, lastBenchmarkReport, isCustomProfile,
    workerMode, setWorkerMode, adaptiveRefresh, setAdaptiveRefresh,
    workerCulling, setWorkerCulling, attributeProfile, setAttributeProfile,
    attributeProfileConfig, colorBy, setColorBy, requestedBackend, setRequestedBackend,
    activeBackend, frustumCulling, setFrustumCulling, autoLod, setAutoLod,
    manualLodLevel, setManualLodLevel, runtimeMode, setRuntimeMode,
    importanceField, setImportanceField, maxStalenessMs, setMaxStalenessMs,
    importanceSamplingEnabled, setImportanceSamplingEnabled,
    timeWindowMs, setTimeWindowMs, setTemporalStats,
    handleStart, handleStop,
    handleExportBenchmarkJson, renderMetricsRef, fileViewSnapshotRef,
    compareLeftRenderMetricsRef, compareRightRenderMetricsRef,
    copyReport, getFixedProfileIds, BENCHMARK_PROFILES,
    compareLeftApiRef, compareRightApiRef,
    compareStreaming, compareLeftReady, setCompareLeftReady,
    compareRightReady, setCompareRightReady, compareColorBy, setCompareColorBy,
    compareMaxPoints, setCompareMaxPoints, compareImportanceField, setCompareImportanceField,
    compareMaxStalenessMs, setCompareMaxStalenessMs,
    compareImportanceSamplingEnabled, setCompareImportanceSamplingEnabled,
    comparePointsPerChunk, setComparePointsPerChunk,
    compareIntervalMs, setCompareIntervalMs,
    handleCompareStart, handleCompareStop, setCompareLeftStats, setCompareRightStats,
    copyCompareReport,
    copyFileReport,
  }), [
    demoMode, apiReady, streaming, maxPoints, benchmarkProfileId,
    customDurationSec, customMaxPoints, customPointsPerChunk, customIntervalMs,
    streamShape,
    useDynamicAlloc, benchmarkRunning, lastBenchmarkReport,
    workerMode, adaptiveRefresh, workerCulling, attributeProfile, attributeProfileConfig,
    colorBy, requestedBackend, activeBackend, frustumCulling, autoLod, manualLodLevel,
    runtimeMode, importanceField, maxStalenessMs, importanceSamplingEnabled, timeWindowMs,
    compareStreaming, compareLeftReady, compareRightReady, compareColorBy, compareMaxPoints,
    compareImportanceField, compareMaxStalenessMs, compareImportanceSamplingEnabled,
    comparePointsPerChunk, compareIntervalMs,
    ingestConfig, ingestConfigLabel, isCustomProfile,
    copyFileReport,
  ]);

  return (
    <CanvasCtx.Provider value={canvas}>
      <HudCtx.Provider value={hud}>{children}</HudCtx.Provider>
    </CanvasCtx.Provider>
  );
}

// ─── Consumer hooks ───────────────────────────────────────────────────────────

export function useDemoCanvas(): DemoCanvas {
  const c = useContext(CanvasCtx);
  if (!c) throw new Error("useDemoCanvas must be used within DemoProvider");
  return c;
}

export function useDemoHud(): DemoHud {
  const h = useContext(HudCtx);
  if (!h) throw new Error("useDemoHud must be used within DemoProvider");
  return h;
}
