import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Color, WebGLRenderer } from "three";
import { WebGPURenderer } from "three/webgpu";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { usePointFlow, type UsePointFlowOptions } from "../hooks/usePointFlow";
import type { GPUPowerPreference, PackedAttributeChannel, PickedPoint, PickStrategy, PointChunk, RendererBackend, StreamedPointCloudRenderMetrics, TemporalStats } from "../core/types";
import { detectWebGPUSupport, resolveRenderer } from "../webgpu/capability";
import { VISUAL_REFRESH_HZ_MIN, VISUAL_REFRESH_HZ_MAX, VISUAL_REFRESH_HZ_DEFAULT } from "./WebGLPointCloudScene";
import type { PointFlowConfig } from "../config";
import { resolveConfigValue } from "../config";
import { AutoFrameCamera, CameraFitEffect, CameraFitFromPoints } from "./streamed/camera-fit";
import { packRgbInterleaved } from "./streamed/attribute-packing";
import { StreamBackendSceneRouter } from "./streamed/backend-scene-router";

export type { RendererBackend };
export type { StreamedPointCloudRenderMetrics } from "../core/types";

/** A single attribute channel from a dense (non-sparse) source such as a parsed file. */
export interface DenseAttributeChannel {
  key: string;
  values: Float32Array;
}

type OrbitControlsHandle = React.ComponentRef<typeof OrbitControls>;

export interface StreamedPointCloudRef {
  pushChunk: (chunk: PointChunk) => void;
  /**
   * Push pre-packed SoA data directly into the pipeline, bypassing the
   * PointRecord object layer. Intended for file loaders that already have
   * typed-array data (PLY, XYZ). Each attribute channel must be dense
   * (all values present); the bridge generates the presence bitmap internally.
   */
  pushBinary: (xyz: Float32Array, attributes: DenseAttributeChannel[], count: number) => void;
  reset: () => void;
  /**
   * Returns the age in milliseconds of the oldest point currently in the buffer.
   * Useful for verifying the temporal staleness guarantee when maxStalenessMs is set.
   * Returns 0 if the buffer is empty.
   */
  getOldestRetainedAgeMs: () => number;
}

export interface StreamedPointCloudProps extends UsePointFlowOptions {
  /** Human-readable label for this source, used in metrics/debug output. */
  sourceName?: string;
  /** Fixed LOD level override (0 = coarsest). Only used when `autoLod` is false. Default: 0. */
  lodLevel?: number;
  /** Attribute key to use for point colour mapping (e.g. "intensity", "classification"). */
  colorBy?: string;
  /** Automatically select LOD level based on camera distance. Default: false. */
  autoLod?: boolean;
  /** Target visual refresh rate in Hz. Frames are skipped when the renderer is faster. Default: 60. */
  visualRefreshRateHz?: number;
  /** Enable frustum culling — discard points outside the camera frustum before upload. Default: true. */
  frustumCulling?: boolean;
  /** Reduce upload rate when the frame time is long (adaptive refresh). Default: false. */
  adaptiveRefresh?: boolean;
  /** Adaptive ingest downsampling under high pressure. */
  adaptiveIngest?: boolean;
  /** Called each frame with buffer fill and backpressure stats. */
  onStats?: (stats: { totalPoints: number; droppedPoints: number; isUnderPressure: boolean }) => void;
  /** Called each frame with render timing metrics (draw calls, point count, GPU time). */
  onRenderMetrics?: (metrics: StreamedPointCloudRenderMetrics) => void;
  onIngestTelemetry?: UsePointFlowOptions["onTelemetryEvent"];
  /**
   * Latest metrics written every frame (WebGPU RAF / WebGL useFrame). When set,
   * `onRenderMetrics` is not called from the frame loop (unless you omit this ref).
   * Use a separate timer in React to read the ref and call setState.
   */
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  /** Called once after the GPU pipeline is initialised and the first frame has been submitted. */
  onReady?: (api: StreamedPointCloudRef) => void;
  /**
   * Preferred renderer backend. Defaults to "auto" (WebGPU when the browser supports
   * it, else WebGL). Pass "webgl" to force WebGL; "webgpu" requests WebGPU with
   * automatic WebGL fallback when unsupported.
   */
  rendererBackend?: RendererBackend;
  /**
   * GPU power preference hint for the WebGPU adapter request. "high-performance"
   * asks the browser to prefer the discrete GPU on multi-GPU systems.
   * No-op on the WebGL path. Default: "high-performance".
   */
  powerPreference?: GPUPowerPreference;
  /** Called once with the resolved backend ("webgpu" or "webgl") after the renderer is initialised. */
  onRendererResolved?: (backend: Exclude<RendererBackend, "auto">) => void;
  /**
   * When true, enables GPU stochastic importance sampling in the WebGPU compute
   * shader. Points with higher attribute values (as specified by importanceField)
   * are sampled more frequently. No-op on the WebGL path. Default: false.
   */
  importanceSamplingEnabled?: boolean;
  /**
   * Called when the user clicks inside the canvas and a point is found within
   * `pickRadius` of the click position. Returns the highest-importance point
   * within the radius (stacked-point tiebreaker).
   */
  onPointPick?: (point: PickedPoint) => void;
  /** Pick radius in CSS pixels. Default: 8. */
  pickRadius?: number;
  /** Picking strategy used when multiple points qualify. */
  pickStrategy?: PickStrategy;
  /**
   * Foveated importance boost. Points near screen centre are sampled more
   * frequently. 0 = off (default), 1 = moderate, 3 = strong.
   * Only active on the WebGPU path when importanceSamplingEnabled is true.
   */
  fovStrength?: number;
  /**
   * Enable progressive accumulation. When the camera has been static for
   * ≥ accumulationThresholdMs, all buffered points are rendered (stochastic
   * sampling gate disabled). Resumes sampling immediately on camera movement.
   * Only active on the WebGPU path. Default: false.
   */
  accumulationMode?: boolean;
  /**
   * Duration (ms) the camera must be stationary before switching to
   * full-detail accumulation mode. Default: 200.
   */
  accumulationThresholdMs?: number;
  /**
   * Called when accumulation state changes.
   * true = accumulating (camera static, full detail active).
   * false = streaming (camera moving, stochastic sampling active).
   */
  onAccumulationChange?: (isAccumulating: boolean) => void;
  /**
   * Called each frame with temporal statistics for the current buffer.
   * Delivers oldest/newest point ages and windowed vs total count.
   * Only fired when the buffer is non-empty.
   */
  onTemporalStats?: (stats: TemporalStats) => void;
  /** Fit camera near/far planes and orbit max distance to a dataset bounding halfsize. Set after loading a large file. */
  cameraFit?: { halfsize: number };
  /** Loading progress (0-1). AutoFrameCamera waits for full load before framing. */
  progress?: number;
  config?: PointFlowConfig;
  /** Canvas clear colour as a CSS hex string (e.g. "#111111"). Defaults to "#404040". */
  background?: string;
}

function SceneBackground({ color }: { color: string }) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.background = new Color(color);
  }, [scene, color]);
  return null;
}

export function StreamedPointCloud(props: StreamedPointCloudProps) {
  const streamedConfig = props.config?.streamed;
  const hookConfig = props.config?.hooks?.usePointFlow;
  const globalConfig = props.config?.global;
  const maxPoints = resolveConfigValue(50_000, props.maxPoints, streamedConfig?.maxPoints, hookConfig?.maxPoints, globalConfig?.maxPoints);
  const lodLevels = resolveConfigValue(3, props.lodLevels, streamedConfig?.lodLevels, hookConfig?.lodLevels);
  const mode = resolveConfigValue("drop-oldest", props.mode, streamedConfig?.mode, hookConfig?.mode);
  const workerMode = resolveConfigValue(false, props.workerMode, streamedConfig?.workerMode, hookConfig?.workerMode);
  const tier = props.tier ?? streamedConfig?.tier ?? hookConfig?.tier ?? globalConfig?.tier;
  const runtimeMode = props.runtimeMode ?? streamedConfig?.runtimeMode ?? hookConfig?.runtimeMode ?? globalConfig?.runtimeMode;
  const constraints = props.constraints ?? streamedConfig?.constraints ?? hookConfig?.constraints ?? globalConfig?.constraints;
  const legacyMode = resolveConfigValue(false, props.legacyMode, streamedConfig?.legacyMode, hookConfig?.legacyMode);
  const dynamicAlloc = props.dynamicAlloc ?? streamedConfig?.dynamicAlloc ?? hookConfig?.dynamicAlloc;
  const spatialCulling = resolveConfigValue(true, props.spatialCulling, streamedConfig?.spatialCulling, hookConfig?.spatialCulling);
  const workerCulling = resolveConfigValue(false, props.workerCulling, streamedConfig?.workerCulling, hookConfig?.workerCulling);
  const importanceField = props.importanceField ?? streamedConfig?.importanceField ?? hookConfig?.importanceField;
  const maxStalenessMs = props.maxStalenessMs ?? streamedConfig?.maxStalenessMs ?? hookConfig?.maxStalenessMs;
  const adaptiveIngest = resolveConfigValue(false, props.adaptiveIngest, streamedConfig?.adaptiveIngest, hookConfig?.adaptiveIngest, globalConfig?.adaptiveIngest);
  const autoTunePolicy = resolveConfigValue(false, props.autoTunePolicy, streamedConfig?.autoTunePolicy, hookConfig?.autoTunePolicy, globalConfig?.autoTunePolicy);
  const colorBy = props.colorBy ?? streamedConfig?.colorBy ?? globalConfig?.colorBy;
  const manualLodLevel = resolveConfigValue(0, props.lodLevel, streamedConfig?.lodLevel);
  const autoLod = resolveConfigValue(false, props.autoLod, streamedConfig?.autoLod);
  const frustumCulling = resolveConfigValue(true, props.frustumCulling, streamedConfig?.frustumCulling, globalConfig?.frustumCulling);
  const adaptiveRefresh = resolveConfigValue(false, props.adaptiveRefresh, streamedConfig?.adaptiveRefresh, globalConfig?.adaptiveRefresh);
  const rendererBackend = resolveConfigValue<RendererBackend>("auto", props.rendererBackend, streamedConfig?.rendererBackend, globalConfig?.rendererBackend);
  const powerPreference = resolveConfigValue<GPUPowerPreference>("high-performance", props.powerPreference, streamedConfig?.powerPreference, globalConfig?.powerPreference);
  const pickRadius = resolveConfigValue(8, props.pickRadius, streamedConfig?.pickRadius, globalConfig?.pickRadius);
  const pickStrategy = props.pickStrategy ?? streamedConfig?.pickStrategy ?? globalConfig?.pickStrategy;
  const importanceSamplingEnabled = resolveConfigValue(false, props.importanceSamplingEnabled, streamedConfig?.importanceSamplingEnabled);
  const fovStrength = resolveConfigValue(0, props.fovStrength, streamedConfig?.fovStrength);
  const accumulationMode = resolveConfigValue(false, props.accumulationMode, streamedConfig?.accumulationMode);
  const accumulationThresholdMs = resolveConfigValue(200, props.accumulationThresholdMs, streamedConfig?.accumulationThresholdMs);
  const timeWindowMs = props.timeWindowMs ?? streamedConfig?.timeWindowMs ?? hookConfig?.timeWindowMs;
  const background = props.background;
  const progress = props.progress ?? 0;
  const [memoryPointBudgetCap, setMemoryPointBudgetCap] = useState<number | undefined>(undefined);
  const highPressureStreakRef = useRef(0);
  const lowPressureStreakRef = useRef(0);
  const lastMemoryCapAdjustAtRef = useRef(0);
  const effectiveConstraints = memoryPointBudgetCap === undefined
    ? constraints
    : {
        ...(constraints ?? {}),
        pointBudgetCap: constraints?.pointBudgetCap !== undefined
          ? Math.min(constraints.pointBudgetCap, memoryPointBudgetCap)
          : memoryPointBudgetCap,
      };

  useEffect(() => {
    const timer = setInterval(() => {
      const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
      if (!perf.memory || maxPoints <= 0) return;
      const limit = perf.memory.jsHeapSizeLimit;
      if (limit <= 0) return;
      const ratio = perf.memory.usedJSHeapSize / limit;
      const now = Date.now();
      const canAdjust = now - lastMemoryCapAdjustAtRef.current >= 4000;
      if (ratio > 0.88) {
        highPressureStreakRef.current += 1;
        lowPressureStreakRef.current = 0;
      } else if (ratio < 0.65) {
        lowPressureStreakRef.current += 1;
        highPressureStreakRef.current = 0;
      } else {
        highPressureStreakRef.current = 0;
        lowPressureStreakRef.current = 0;
      }

      if (highPressureStreakRef.current >= 2 && canAdjust) {
        setMemoryPointBudgetCap((prev) => {
          const current = prev ?? maxPoints;
          return Math.max(50_000, Math.floor(current * 0.9));
        });
        lastMemoryCapAdjustAtRef.current = now;
        highPressureStreakRef.current = 0;
      } else if (lowPressureStreakRef.current >= 3 && canAdjust) {
        setMemoryPointBudgetCap((prev) => {
          if (prev === undefined) return undefined;
          const next = Math.min(maxPoints, Math.floor(prev * 1.05));
          return next >= maxPoints ? undefined : next;
        });
        lastMemoryCapAdjustAtRef.current = now;
        lowPressureStreakRef.current = 0;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [maxPoints]);

  const rawIngestCallbackRef = useRef<
    ((xyz: Float32Array, attributes: PackedAttributeChannel[] | undefined, count: number) => void) | null
  >(null);

  const renderWorkerIngestRef = useRef<
    ((xyz: Float32Array, attr: Float32Array | null, count: number, isRgb?: boolean) => void) | null
  >(null);

  const vpRef = useRef<Float32Array | null>(null);

  const colorByWorkerRef = useRef(colorBy);
  colorByWorkerRef.current = colorBy;

  // Forward packed data to the render worker.
  const forwardToRenderWorker = (
    xyz: Float32Array,
    attrs: { key: string; values: Float32Array }[] | undefined,
    count: number,
  ): void => {
    const renderWorkerIngest = renderWorkerIngestRef.current;
    if (!renderWorkerIngest) return;
    const rgb = attrs ? packRgbInterleaved(attrs, count) : null;
    if (rgb !== null) {
      renderWorkerIngest(xyz, rgb, count, true);
    } else {
      const key = colorByWorkerRef.current;
      const channel = (key && key !== "none")
        ? (attrs?.find((a) => a.key === key) ?? attrs?.[0])
        : null;
      renderWorkerIngest(xyz, channel?.values ?? null, count, false);
    }
  };

  const state = usePointFlow({
    maxPoints,
    lodLevels,
    mode,
    reactivePush:     false,
    workerMode,
    tier,
    runtimeMode,
    constraints: effectiveConstraints,
    legacyMode,
    dynamicAlloc,
    spatialCulling,
    workerCulling,
    importanceField,
    maxStalenessMs,
    onRawIngest: (xyz, attributes, count) => {
      rawIngestCallbackRef.current?.(xyz, attributes, count);
      forwardToRenderWorker(xyz, attributes, count);
    },
    adaptiveIngest,
    autoTunePolicy,
    onTelemetryEvent: props.onIngestTelemetry,
    config: props.config,
  });

  const requestedVisualRefreshRateHz = Math.min(
    VISUAL_REFRESH_HZ_MAX,
    Math.max(VISUAL_REFRESH_HZ_MIN, (props.visualRefreshRateHz ?? streamedConfig?.visualRefreshRateHz) ?? VISUAL_REFRESH_HZ_DEFAULT)
  );
  const policyRefreshRateHz = 1000 / Math.max(1, state.activePolicy.updateCadenceMs);
  const visualRefreshRateHz = Math.min(requestedVisualRefreshRateHz, policyRefreshRateHz);

  // Explicit "webgl"/"webgpu" resolves synchronously (no flash).
  // "auto"/undefined starts as "webgl" (safe default) until the async adapter check resolves.
  const [resolvedRendererBackend, setResolvedRendererBackend] =
    useState<Exclude<RendererBackend, "auto">>(() => {
      const req = rendererBackend;
      if (req === "webgl")  return "webgl";
      if (req === "webgpu") return resolveRenderer("webgpu");
      return resolveRenderer(undefined);
    });

  useEffect(() => {
    const req = rendererBackend;
    if (req === "webgl")  { setResolvedRendererBackend("webgl"); return; }
    if (req === "webgpu") { setResolvedRendererBackend(resolveRenderer("webgpu")); return; }
    let cancelled = false;
    detectWebGPUSupport().then((supported) => {
      if (!cancelled) setResolvedRendererBackend(supported ? "webgpu" : "webgl");
    });
    return () => { cancelled = true; };
  }, [rendererBackend]);

  const onRendererResolvedRef = useRef(props.onRendererResolved);
  onRendererResolvedRef.current = props.onRendererResolved;
  useLayoutEffect(() => {
    onRendererResolvedRef.current?.(resolvedRendererBackend);
  }, [resolvedRendererBackend]); // ref pattern — stable regardless of callback identity

  const pushChunkRef = useRef(state.pushChunk);
  const resetRef     = useRef(state.reset);
  pushChunkRef.current = state.pushChunk;
  resetRef.current     = state.reset;

  const bufferRef = state._bufferRef;

  useEffect(() => {
    props.onReady?.({
      pushChunk: (chunk) => pushChunkRef.current(chunk),
      pushBinary: (xyz, attrs, count) => {
        const buf = bufferRef.current;
        if (!buf) return;
        const packed: PackedAttributeChannel[] = attrs.map((a) => ({
          key:     a.key,
          values:  a.values,
          present: new Uint8Array(count).fill(1),
        }));
        buf.ingestFromBinary(xyz, packed, count);
        rawIngestCallbackRef.current?.(xyz, packed, count);
        forwardToRenderWorker(xyz, packed, count);
      },
      reset: () => resetRef.current(),
      getOldestRetainedAgeMs: () => bufferRef.current?.getOldestRetainedAgeMs() ?? 0,
    });
  // pushChunkRef, resetRef, bufferRef, rawIngestCallbackRef, renderWorkerIngestRef are refs —
  // .current accesses are stable and safe without listing. props.onReady is the only real dep.
  }, [props.onReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const statsRef = useRef({ totalPoints: 0, droppedPoints: 0, isUnderPressure: false });
  statsRef.current = {
    totalPoints:     state.totalPoints,
    droppedPoints:   state.droppedPoints,
    isUnderPressure: state.isUnderPressure,
  };
  useEffect(() => {
    props.onStats?.(statsRef.current);
  }, [props.onStats, state.totalPoints, state.droppedPoints, state.isUnderPressure]);

  const onPointPickRef = useRef(props.onPointPick);
  onPointPickRef.current = props.onPointPick;
  const handlePointerDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!onPointPickRef.current) return;
    const vp     = vpRef.current;
    const buffer = bufferRef.current;
    if (!vp || !buffer) return;
    const rect   = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const result = buffer.pickNearest(vp, clickX, clickY, rect.width, rect.height, pickRadius, pickStrategy);
    if (!result) return;
    onPointPickRef.current({
      x:          result.x,
      y:          result.y,
      z:          result.z,
      attributes: result.attributes,
      slotIndex:  result.slotIndex,
      screenDist: result.screenDist,
      confidence: Math.max(0, 1 - (result.screenDist / Math.max(1e-6, pickRadius))),
    });
  // onPointPickRef, vpRef, bufferRef are refs — .current accesses are stable without listing.
  }, [pickRadius, pickStrategy]); // eslint-disable-line react-hooks/exhaustive-deps

  const copySoAForGPU = useCallback(
    (posOut: Float32Array, attrOut: Float32Array, cbBy: string | undefined) =>
      bufferRef.current!.copySoAForGPU(posOut, attrOut, cbBy),
    []
  );
  const [cameraFitHalfsize, setCameraFitHalfsize] = useState<number>(0);
  const handleHalfsizeReady = useCallback((halfsize: number) => {
    setCameraFitHalfsize(halfsize);
  }, []);
  const orbitControlsRef = useRef<OrbitControlsHandle | null>(null);
  const getTemporalStats = (nowMs: number, windowMs?: number) =>
    bufferRef.current!.getTemporalStats(nowMs, windowMs);
  const effectiveHalfsize = props.cameraFit?.halfsize ?? (cameraFitHalfsize > 0 ? cameraFitHalfsize : 0);
  const canvasInitialCamera = effectiveHalfsize > 0
    ? { position: [effectiveHalfsize, effectiveHalfsize * 0.5, effectiveHalfsize] as [number, number, number] }
    : undefined;

  return (
    <div
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      onPointerDown={props.onPointPick ? handlePointerDown : undefined}
    >
      <Canvas
        key={resolvedRendererBackend}
        frameloop={resolvedRendererBackend === "webgpu" ? "never" : "demand"}
        camera={canvasInitialCamera}
        gl={
          resolvedRendererBackend === "webgpu"
            ? (defaults) => {
                try {
                  const opts = { ...(defaults as Record<string, unknown>) };
                  opts.powerPreference = powerPreference === "default" ? undefined : powerPreference;
                  return new WebGPURenderer(opts) as unknown as WebGLRenderer;
                } catch {
                  setResolvedRendererBackend("webgl");
                  return new WebGLRenderer(defaults);
                }
              }
            : undefined
        }
      >
        <SceneBackground color={background ?? "#404040"} />
        <StreamBackendSceneRouter
          resolvedRendererBackend={resolvedRendererBackend}
          maxPoints={maxPoints}
          copySoAForGPU={copySoAForGPU}
          rawIngestCallbackRef={rawIngestCallbackRef}
          state={state}
          colorBy={colorBy}
          frustumCulling={frustumCulling}
          visualRefreshRateHz={visualRefreshRateHz}
          dynamicAlloc={dynamicAlloc}
          adaptiveRefresh={adaptiveRefresh}
          importanceSamplingEnabled={importanceSamplingEnabled}
          fovStrength={fovStrength}
          vpRef={vpRef}
          accumulationMode={accumulationMode}
          accumulationThresholdMs={accumulationThresholdMs}
          onAccumulationChange={props.onAccumulationChange}
          bufferEpochMs={bufferRef.current?.epochMs ?? Date.now()}
          timeWindowMs={timeWindowMs}
          onTemporalStats={props.onTemporalStats}
          getTemporalStats={getTemporalStats}
          setResolvedRendererBackend={setResolvedRendererBackend}
          renderWorkerIngestRef={renderWorkerIngestRef}
          manualLodLevel={manualLodLevel}
          autoLod={autoLod}
          lodLevels={lodLevels}
          workerCulling={workerCulling}
          workerMode={workerMode}
          onRenderMetrics={props.onRenderMetrics}
          renderMetricsRef={props.renderMetricsRef}
          effectiveHalfsize={effectiveHalfsize}
          background={background}
        />
        <OrbitControls
          ref={orbitControlsRef}
          makeDefault
          enablePan
          enableRotate
          enableZoom
          maxDistance={effectiveHalfsize > 0 ? effectiveHalfsize * 3 : undefined}
        />
        <AutoFrameCamera
          totalPoints={state.totalPoints}
          maxCapacity={maxPoints}
          colorBy={colorBy}
          copySoAForGPU={copySoAForGPU}
          orbitControlsRef={orbitControlsRef}
          progress={progress}
        />
        <CameraFitFromPoints
          totalPoints={state.totalPoints}
          maxCapacity={maxPoints}
          colorBy={colorBy}
          copySoAForGPU={copySoAForGPU}
          onHalfsizeReady={handleHalfsizeReady}
          progress={progress}
        />
        {effectiveHalfsize > 0 && <CameraFitEffect halfsize={effectiveHalfsize} />}
      </Canvas>
    </div>
  );
}
