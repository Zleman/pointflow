import React from "react";
import type { PackedAttributeChannel, StreamedPointCloudRenderMetrics, TemporalStats } from "../../core/types";
import { WebGLPointCloudScene } from "../WebGLPointCloudScene";
import { WebGPUPointCloudScene } from "../WebGPUPointCloudScene";

export function StreamBackendSceneRouter(props: {
  resolvedRendererBackend: "webgl" | "webgpu";
  maxPoints: number;
  copySoAForGPU: (
    posOut: Float32Array,
    attrOut: Float32Array,
    cbBy: string | undefined
  ) => { count: number; attrMin: number; attrMax: number };
  rawIngestCallbackRef: React.MutableRefObject<
    ((xyz: Float32Array, attributes: PackedAttributeChannel[] | undefined, count: number) => void) | null
  >;
  state: {
    refreshStats: () => void;
    totalPoints: number;
    activePolicy: { updateCadenceMs: number; expensivePassesEnabled: boolean };
    getBufferCapacity: () => number;
    renderIntoBuffers: (
      positions: Float32Array,
      colors: Float32Array,
      lodStep: number,
      colorBy: string | undefined,
      isVisible?: (x: number, y: number, z: number) => boolean
    ) => number;
    setWorkerFrustum: (planes: Float32Array) => void;
    resetVersion: number;
  };
  colorBy: string | undefined;
  frustumCulling: boolean;
  visualRefreshRateHz: number;
  dynamicAlloc: unknown;
  adaptiveRefresh: boolean;
  importanceSamplingEnabled: boolean;
  fovStrength: number;
  vpRef: React.MutableRefObject<Float32Array | null>;
  accumulationMode: boolean;
  accumulationThresholdMs: number;
  onAccumulationChange?: (isAccumulating: boolean) => void;
  bufferEpochMs: number;
  timeWindowMs?: number;
  onTemporalStats?: (stats: TemporalStats) => void;
  getTemporalStats: (nowMs: number, windowMs?: number) => TemporalStats;
  setResolvedRendererBackend: (value: "webgl" | "webgpu") => void;
  renderWorkerIngestRef: React.MutableRefObject<
    ((xyz: Float32Array, attr: Float32Array | null, count: number, isRgb?: boolean) => void) | null
  >;
  manualLodLevel: number;
  autoLod: boolean;
  lodLevels: number;
  workerCulling: boolean;
  workerMode: boolean;
  onRenderMetrics?: (metrics: StreamedPointCloudRenderMetrics) => void;
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  effectiveHalfsize: number;
  background?: string;
}) {
  const {
    resolvedRendererBackend,
    maxPoints,
    copySoAForGPU,
    rawIngestCallbackRef,
    state,
    colorBy,
    frustumCulling,
    visualRefreshRateHz,
    dynamicAlloc,
    adaptiveRefresh,
    importanceSamplingEnabled,
    fovStrength,
    vpRef,
    accumulationMode,
    accumulationThresholdMs,
    onAccumulationChange,
    bufferEpochMs,
    timeWindowMs,
    onTemporalStats,
    getTemporalStats,
    setResolvedRendererBackend,
    renderWorkerIngestRef,
    manualLodLevel,
    autoLod,
    lodLevels,
    workerCulling,
    workerMode,
    onRenderMetrics,
    renderMetricsRef,
    effectiveHalfsize,
    background,
  } = props;

  if (resolvedRendererBackend === "webgpu") {
    return (
      <WebGPUPointCloudScene
        key={maxPoints}
        copySoAForGPU={copySoAForGPU}
        rawIngestCallbackRef={rawIngestCallbackRef}
        onRefresh={state.refreshStats}
        colorBy={colorBy}
        frustumCulling={frustumCulling}
        totalPoints={state.totalPoints}
        maxCapacity={maxPoints}
        visualRefreshRateHz={visualRefreshRateHz}
        policyCadenceMs={state.activePolicy.updateCadenceMs}
        expensivePassesEnabled={state.activePolicy.expensivePassesEnabled}
        onRenderMetrics={renderMetricsRef ? undefined : onRenderMetrics}
        renderMetricsRef={renderMetricsRef}
        getBufferCapacity={state.getBufferCapacity}
        isDynamicAlloc={dynamicAlloc !== undefined}
        adaptiveRefresh={adaptiveRefresh}
        importanceSamplingEnabled={importanceSamplingEnabled}
        fovStrength={fovStrength}
        vpRef={vpRef}
        accumulationMode={accumulationMode}
        accumulationThresholdMs={accumulationThresholdMs}
        onAccumulationChange={onAccumulationChange}
        bufferEpochMs={bufferEpochMs}
        timeWindowMs={timeWindowMs ?? 0}
        onTemporalStats={onTemporalStats}
        getTemporalStats={getTemporalStats}
        onWebGPUDeviceLost={() => setResolvedRendererBackend("webgl")}
        cameraFit={effectiveHalfsize > 0 ? { halfsize: effectiveHalfsize } : undefined}
        resetVersion={state.resetVersion}
        background={background}
      />
    );
  }

  return (
    <WebGLPointCloudScene
      key={maxPoints}
      renderIntoBuffers={state.renderIntoBuffers}
      onRefresh={state.refreshStats}
      manualLodLevel={manualLodLevel}
      colorBy={colorBy}
      autoLod={autoLod}
      frustumCulling={frustumCulling}
      totalPoints={state.totalPoints}
      lodLevels={lodLevels}
      maxCapacity={maxPoints}
      visualRefreshRateHz={visualRefreshRateHz}
      policyCadenceMs={state.activePolicy.updateCadenceMs}
      expensivePassesEnabled={state.activePolicy.expensivePassesEnabled}
      onRenderMetrics={renderMetricsRef ? undefined : onRenderMetrics}
      renderMetricsRef={renderMetricsRef}
      getBufferCapacity={state.getBufferCapacity}
      isDynamicAlloc={dynamicAlloc !== undefined}
      adaptiveRefresh={adaptiveRefresh}
      workerCulling={workerCulling && workerMode}
      setWorkerFrustum={state.setWorkerFrustum}
      renderWorkerIngestRef={renderWorkerIngestRef}
      vpRef={vpRef}
      onTemporalStats={onTemporalStats}
      getTemporalStats={getTemporalStats}
      timeWindowMs={timeWindowMs}
      pointSize={effectiveHalfsize > 0 ? effectiveHalfsize / 50 : 1.0}
      cameraFit={effectiveHalfsize > 0 ? { halfsize: effectiveHalfsize } : undefined}
    />
  );
}
