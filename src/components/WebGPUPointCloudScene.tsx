import React, { useEffect, useRef } from "react";
import { Matrix4, Plane, Vector3 } from "three";
import { useThree } from "@react-three/fiber";
import type { PackedAttributeChannel, StreamedPointCloudRenderMetrics, TemporalStats } from "../core/types";
import { createFrustumCullPool, updateFrustumPool, type FrustumCullPool } from "../core/frustum-culling";
import { getDeviceFromRenderer, getCanvasContextFromRenderer } from "../webgpu/device";
import { createPointBuffers, writeIncrementalChunk, uploadFullData, clearGpuBuffers, type WebGPUPointBuffers } from "../webgpu/buffers";
import { createUniformBuffer, writeUniforms } from "../webgpu/uniforms";
import { createComputePipeline, type ComputePipeline } from "../webgpu/compute-pipeline";
import { createRenderPipeline, type RenderPipeline } from "../webgpu/point-pipeline";
import { submitFrame, createTimestampCtx, destroyTimestampCtx, type FrameTimestampCtx } from "../webgpu/render-pass";
import { computeEffectiveRefreshIntervalMs } from "./refresh-cadence";
import { nextAccumulationState } from "./webgpu-point/accumulation-policy";
import {
  STATS_REFRESH_MIN_MS,
  TEMPORAL_STATS_UI_MIN_MS,
  shouldRunThrottled,
  writeRenderMetrics,
} from "./scene-metrics";
import { runDeferredRefresh } from "./scene-refresh";

const WEBGPU_POINT_SIZE_PX = 4;
const WEBGPU_LOD_FAR_DIST  = 200;
/** Canvas clear color (replaces Three.js background clear on the WebGPU path). */
const GPU_CLEAR_COLOR: GPUColorDict = { r: 64 / 255, g: 64 / 255, b: 64 / 255, a: 1 };
const WEBGPU_UNAVAILABLE_FALLBACK_MS = 1200;

function hexToGpuColor(hex: string): GPUColorDict {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: 1,
  };
}
const WEBGPU_UNAVAILABLE_FALLBACK_FRAMES = 24;

function renderFallbackThree(
  gl: { render(s: unknown, c: unknown): void; renderAsync?(s: unknown, c: unknown): Promise<unknown> },
  scene: unknown,
  camera: unknown
): void {
  if (typeof gl.renderAsync === "function") {
    void gl.renderAsync(scene, camera);
  } else {
    gl.render(scene, camera);
  }
}

// Six open-halfspace planes that pass all points (used when frustumCulling=false).
const IDENTITY_PLANES: Plane[] = Array.from({ length: 6 }, () => new Plane(new Vector3(0, 1, 0), 1e9));

// Scratch VP matrix — allocated once, reused every frame.
const _vpMatrix = new Matrix4();

interface WebGPUSceneState {
  device: GPUDevice;
  canvasContext: GPUCanvasContext;
  gpuBuffers: WebGPUPointBuffers;
  uniformBuffer: GPUBuffer;
  computePipeline: ComputePipeline;
  renderPipeline: RenderPipeline;
  /** Depth texture + cached view; recreated when canvas is resized. */
  depthTexture: GPUTexture | null;
  depthView: GPUTextureView | null;
  depthTextureSize: [number, number];
  /** Timestamp query context; null when feature unavailable. */
  tsCtx: FrameTimestampCtx | null;
}

interface PendingIngestChunk {
  xyz: Float32Array;
  attributes: PackedAttributeChannel[] | undefined;
  count: number;
  nowRelEpoch: number;
}

export interface WebGPUPointCloudSceneProps {
  copySoAForGPU: (
    posOut: Float32Array,
    attrOut: Float32Array,
    colorBy: string | undefined
  ) => { count: number; attrMin: number; attrMax: number };
  onRefresh: () => void;
  colorBy: string | undefined;
  frustumCulling: boolean;
  totalPoints: number;
  maxCapacity: number;
  visualRefreshRateHz: number;
  policyCadenceMs: number;
  expensivePassesEnabled: boolean;
  onRenderMetrics?: (metrics: StreamedPointCloudRenderMetrics) => void;
  /**
   * When set, metrics are written here every RAF tick (no React). Prefer this over
   * `onRenderMetrics` for UI updates so setState never runs inside the frame loop.
   */
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  getBufferCapacity: () => number;
  isDynamicAlloc: boolean;
  adaptiveRefresh: boolean;
  /**
   * Ref set by the parent so onRawIngest can write directly to GPU buffers.
   * WebGPUPointCloudScene assigns the handler in its useEffect.
   */
  rawIngestCallbackRef: React.MutableRefObject<
    ((xyz: Float32Array, attributes: PackedAttributeChannel[] | undefined, count: number) => void) | null
  >;
  importanceSamplingEnabled: boolean;
  fovStrength: number;
  /** Written each frame with the current VP matrix elements (for CPU picking). */
  vpRef: React.MutableRefObject<Float32Array | null>;
  accumulationMode: boolean;
  accumulationThresholdMs: number;
  onAccumulationChange?: (isAccumulating: boolean) => void;
  /** Epoch origin of the CPU ring buffer (Date.now() at construction). */
  bufferEpochMs: number;
  /** Time window for rendering (ms). 0 = show all. */
  timeWindowMs: number;
  /** Temporal stats for the buffer (throttled ~4 Hz; not every RAF). */
  onTemporalStats?: (stats: TemporalStats) => void;
  /** Returns temporal stats from the CPU ring. */
  getTemporalStats: (nowMs: number, windowMs?: number) => TemporalStats;
  onWebGPUDeviceLost?: () => void;
  cameraFit?: { halfsize: number };
  /** Increments each time usePointFlow.reset() is called. Triggers GPU buffer + pending-chunk clear. */
  resetVersion?: number;
  background?: string;
}

export function WebGPUPointCloudScene(props: WebGPUPointCloudSceneProps) {
  const get = useThree((s) => s.get);
  const getRef = useRef(get);
  getRef.current = get;

  const propsRef = useRef(props);
  propsRef.current = props;

  const gpuStateRef          = useRef<WebGPUSceneState | null>(null);
  const initFailedRef        = useRef(false);
  const gpuInitializedRef    = useRef(false);
  const posVec4Ref           = useRef<Float32Array | null>(null);
  const attrFlatRef          = useRef<Float32Array | null>(null);
  const frustumPoolRef       = useRef<FrustumCullPool>(createFrustumCullPool());
  const lastStatsRefreshRef       = useRef(0);
  const lastMetricsEmitRef        = useRef(0);
  const lastTemporalStatsEmitRef  = useRef(0);
  const gpuAttrMinRef        = useRef(Infinity);
  const gpuAttrMaxRef        = useRef(-Infinity);
  const newDataSinceDispatch = useRef(false);
  const pendingIngestChunksRef = useRef<PendingIngestChunk[]>([]);
  const prevCamPosRef        = useRef<{ x: number; y: number; z: number } | null>(null);
  const camVelocityEmaRef    = useRef(Infinity);
  const staticSinceRef       = useRef<number | null>(null);
  const isAccumulatingRef    = useRef(false);
  const lastVisibleCountRef  = useRef(0);
  const frameTimeMsEmaRef    = useRef(16.67);
  const lastSubmitAtRef      = useRef(0);
  const cancelledRef             = useRef(false);
  const deviceLostSubscribedRef  = useRef(false);
  const firstUnavailableAtRef    = useRef<number | null>(null);
  const unavailableFramesRef     = useRef(0);
  const fallbackRequestedRef     = useRef(false);
  const lastSeenResetVersionRef  = useRef(0);
  const prevColorByForUploadRef  = useRef<string | undefined>(undefined);

  useEffect(() => {
    // ── Incremental ingest callback ──────────────────────────────────────
    // Written to by StreamedPointCloud when new data arrives off the worker.
    // Runs synchronously inside the caller's tick, not inside the RAF.
    props.rawIngestCallbackRef.current = (
      xyz: Float32Array,
      attributes: PackedAttributeChannel[] | undefined,
      count: number
    ) => {
      if (count <= 0) return;
      pendingIngestChunksRef.current.push({
        xyz,
        attributes,
        count,
        nowRelEpoch: Date.now() - propsRef.current.bufferEpochMs,
      });
    };

    // ── GPU device acquisition ────────────────────────────────────────────
    // Called once per RAF tick until the WebGPU context is ready.
    // Returns the new state or null if the renderer isn't ready yet.
    const acquireGpuState = (
      gl: ReturnType<typeof getRef.current>["gl"],
      p: WebGPUPointCloudSceneProps,
    ): WebGPUSceneState | null => {
      const device        = getDeviceFromRenderer(gl);
      const canvasContext = getCanvasContextFromRenderer(gl);
      if (!device || !canvasContext) return null;
      const cap             = p.isDynamicAlloc ? p.getBufferCapacity() : p.maxCapacity;
      const gpuBuffers      = createPointBuffers(device, cap);
      const uniformBuffer   = createUniformBuffer(device);
      const canvasFormat    = navigator.gpu.getPreferredCanvasFormat();
      const computePipeline = createComputePipeline(device, gpuBuffers, uniformBuffer);
      const renderPipeline  = createRenderPipeline(device, gpuBuffers, uniformBuffer, canvasFormat);
      const tsCtx           = createTimestampCtx(device);
      return {
        device, canvasContext, gpuBuffers, uniformBuffer,
        computePipeline, renderPipeline,
        depthTexture: null, depthView: null, depthTextureSize: [0, 0],
        tsCtx,
      };
    };

    // ── Device-lost subscription ──────────────────────────────────────────
    // Subscribes once per physical device. Captures the state object so
    // destroy() runs on the exact buffers alive at the time of loss, even if
    // gpuStateRef.current has been cleared by then.
    const subscribeDeviceLost = (state: WebGPUSceneState): void => {
      if (deviceLostSubscribedRef.current) return;
      deviceLostSubscribedRef.current = true;
      state.device.lost.then((info) => {
        if (cancelledRef.current) return; // Clean unmount — don't switch backends
        console.warn("[PointFlow] WebGPU device lost:", info.reason, info.message, "— falling back to WebGL");
        initFailedRef.current = true;
        state.gpuBuffers.destroy();
        state.uniformBuffer.destroy();
        state.depthTexture?.destroy();
        if (state.tsCtx) destroyTimestampCtx(state.tsCtx);
        gpuStateRef.current = null;
        propsRef.current.onWebGPUDeviceLost?.();
      }).catch((e: unknown) => {
        console.error("[PointFlow] device-lost cleanup error:", e);
      });
    };

    // ── Initial data upload ───────────────────────────────────────────────
    // Runs once on the first frame that gpuStateRef is valid: copies the CPU
    // ring buffer contents to GPU buffers so existing data is visible immediately.
    const uploadInitialData = (state: WebGPUSceneState, p: WebGPUPointCloudSceneProps): void => {
      const effectiveColorBy = p.expensivePassesEnabled ? p.colorBy : undefined;
      const cap = p.isDynamicAlloc ? p.getBufferCapacity() : p.maxCapacity;
      if (posVec4Ref.current === null || posVec4Ref.current.length < cap * 4) {
        posVec4Ref.current  = new Float32Array(cap * 4);
        attrFlatRef.current = new Float32Array(Math.max(cap, 1));
      }
      const { count, attrMin, attrMax } = p.copySoAForGPU(
        posVec4Ref.current, attrFlatRef.current!, effectiveColorBy
      );
      if (count > 0) {
        uploadFullData(state.device, state.gpuBuffers, posVec4Ref.current, attrFlatRef.current!, count);
        gpuAttrMinRef.current        = attrMin;
        gpuAttrMaxRef.current        = attrMax;
        newDataSinceDispatch.current = true;
      }
      gpuInitializedRef.current = true;
    };

    // ── Accumulation mode update ──────────────────────────────────────────
    // Tracks camera velocity EMA and fires onAccumulationChange when the
    // camera transitions between moving and static.
    const updateAccumulationMode = (
      p: WebGPUPointCloudSceneProps,
      cam: { position: { x: number; y: number; z: number } },
      delta: number,
      now: number,
    ): void => {
      const result = nextAccumulationState({
        previousPosition: prevCamPosRef.current,
        currentPosition: cam.position,
        deltaSec: delta,
        nowMs: now,
        velocityEma: camVelocityEmaRef.current,
        staticSinceMs: staticSinceRef.current,
        thresholdMs: p.accumulationThresholdMs,
      });
      prevCamPosRef.current = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      camVelocityEmaRef.current = result.velocityEma;
      staticSinceRef.current = result.staticSinceMs;
      const shouldAccumulate = result.shouldAccumulate;

      if (shouldAccumulate !== isAccumulatingRef.current) {
        isAccumulatingRef.current = shouldAccumulate;
        p.onAccumulationChange?.(shouldAccumulate);
        if (shouldAccumulate) newDataSinceDispatch.current = true;
      }
    };

    // ── RAF frame loop ────────────────────────────────────────────────────
    let rafId: number;
    let lastTimestamp = performance.now();

    const frame = (timestamp: number) => {
      rafId = requestAnimationFrame(frame);
      if (initFailedRef.current) return;

      const delta   = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      const now     = timestamp;
      const p       = propsRef.current;
      const { gl: currentGl, scene: currentScene, camera: cam } = getRef.current();

      // Lazy GPU init — device may not be available on early frames.
      if (gpuStateRef.current === null) {
        try {
          const newState = acquireGpuState(currentGl, p);
          if (!newState) {
            if (firstUnavailableAtRef.current === null) {
              firstUnavailableAtRef.current = now;
            }
            unavailableFramesRef.current += 1;
            const elapsedUnavailableMs = now - firstUnavailableAtRef.current;
            const exceededThreshold =
              elapsedUnavailableMs >= WEBGPU_UNAVAILABLE_FALLBACK_MS
              || unavailableFramesRef.current >= WEBGPU_UNAVAILABLE_FALLBACK_FRAMES;
            if (exceededThreshold && !fallbackRequestedRef.current) {
              fallbackRequestedRef.current = true;
              initFailedRef.current = true;
              p.onWebGPUDeviceLost?.();
            }
            renderFallbackThree(currentGl, currentScene, cam);
            return;
          }
          firstUnavailableAtRef.current = null;
          unavailableFramesRef.current = 0;
          gpuStateRef.current = newState;
          subscribeDeviceLost(newState);
        } catch (e) {
          console.warn("[PointFlow] WebGPU pipeline init failed:", e);
          initFailedRef.current = true;
          renderFallbackThree(currentGl, currentScene, cam);
          return;
        }
      }

      const state = gpuStateRef.current;
      const { device, canvasContext, gpuBuffers, uniformBuffer, computePipeline, renderPipeline } = state;

      // First-frame data upload.
      if (!gpuInitializedRef.current) uploadInitialData(state, p);

      // Reset handshake: when resetVersion ticks, discard stale pending chunks and
      // zero GPU counters so the ring appears empty to the next frame's compute pass.
      const currentResetVersion = propsRef.current.resetVersion ?? 0;
      if (currentResetVersion !== lastSeenResetVersionRef.current) {
        pendingIngestChunksRef.current.length = 0;
        clearGpuBuffers(state.gpuBuffers);
        gpuAttrMinRef.current = Infinity;
        gpuAttrMaxRef.current = -Infinity;
        newDataSinceDispatch.current = false;
        lastSeenResetVersionRef.current = currentResetVersion;
      }

      if (pendingIngestChunksRef.current.length > 0) {
        const pending = pendingIngestChunksRef.current.splice(0, pendingIngestChunksRef.current.length);
        for (const chunk of pending) {
          const { attrMin, attrMax } = writeIncrementalChunk(
            state.device,
            state.gpuBuffers,
            chunk.xyz,
            chunk.attributes,
            chunk.count,
            chunk.nowRelEpoch,
            propsRef.current.colorBy,
          );
          if (attrMin < gpuAttrMinRef.current) gpuAttrMinRef.current = attrMin;
          if (attrMax > gpuAttrMaxRef.current) gpuAttrMaxRef.current = attrMax;
        }
        prevColorByForUploadRef.current = propsRef.current.colorBy;
        newDataSinceDispatch.current = true;
      } else if (
        gpuInitializedRef.current &&
        p.expensivePassesEnabled &&
        p.colorBy !== prevColorByForUploadRef.current
      ) {
        prevColorByForUploadRef.current = p.colorBy;
        const cap = p.isDynamicAlloc ? p.getBufferCapacity() : p.maxCapacity;
        if (posVec4Ref.current === null || posVec4Ref.current.length < cap * 4) {
          posVec4Ref.current  = new Float32Array(cap * 4);
          attrFlatRef.current = new Float32Array(Math.max(cap, 1));
        }
        const { count, attrMin, attrMax } = p.copySoAForGPU(
          posVec4Ref.current, attrFlatRef.current!, p.colorBy
        );
        if (count > 0) {
          uploadFullData(state.device, state.gpuBuffers, posVec4Ref.current, attrFlatRef.current!, count);
          gpuAttrMinRef.current = attrMin;
          gpuAttrMaxRef.current = attrMax;
          newDataSinceDispatch.current = true;
        }
      }

      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      _vpMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      p.vpRef.current = _vpMatrix.elements as unknown as Float32Array;

      if (p.accumulationMode) updateAccumulationMode(p, cam, delta, now);
      frameTimeMsEmaRef.current = frameTimeMsEmaRef.current * 0.85 + delta * 1000 * 0.15;

      const totalCount = gpuBuffers.gpuTotalCount;
      const colorTex   = canvasContext.getCurrentTexture();

      // Recreate depth texture on resize.
      if (
        !state.depthTexture ||
        state.depthTextureSize[0] !== colorTex.width ||
        state.depthTextureSize[1] !== colorTex.height
      ) {
        state.depthTexture?.destroy();
        state.depthTexture = device.createTexture({
          size:   [colorTex.width, colorTex.height],
          format: "depth24plus",
          usage:  GPUTextureUsage.RENDER_ATTACHMENT,
        });
        state.depthView        = state.depthTexture.createView();
        state.depthTextureSize = [colorTex.width, colorTex.height];
      }

      // Write uniforms and submit.
      if (totalCount > 0) {
        if (p.frustumCulling) {
          updateFrustumPool(frustumPoolRef.current, cam.projectionMatrix, cam.matrixWorldInverse);
        }
        const planes = p.frustumCulling ? frustumPoolRef.current.frustum.planes : IDENTITY_PLANES;
        const rawColorBy = p.expensivePassesEnabled ? p.colorBy : undefined;
        const colorMode: 0 | 1 | 2 = (rawColorBy === "rgb" || rawColorBy === "classification") ? 2 : (rawColorBy !== undefined && rawColorBy !== "none") ? 1 : 0;
        const nowRelEpoch = Date.now() - p.bufferEpochMs;
        writeUniforms(
          device, uniformBuffer, _vpMatrix, planes,
          totalCount,
          gpuAttrMinRef.current, gpuAttrMaxRef.current,
          colorMode,
          WEBGPU_POINT_SIZE_PX,
          colorTex.width, colorTex.height,
          WEBGPU_LOD_FAR_DIST,
          cam.position,
          (p.importanceSamplingEnabled && !isAccumulatingRef.current) ? 1 : 0,
          // Seed changes every 500 ms — stable enough to avoid flicker.
          (Math.floor(now / 500)) >>> 0,
          gpuAttrMinRef.current,
          gpuAttrMaxRef.current,
          p.fovStrength,
          nowRelEpoch,
          p.timeWindowMs,
        );
      }

      const effectiveIntervalMs = computeEffectiveRefreshIntervalMs(
        p.adaptiveRefresh,
        p.visualRefreshRateHz,
        p.policyCadenceMs,
        frameTimeMsEmaRef.current,
      );
      const shouldRunCompute = totalCount > 0 && (
        (now - lastSubmitAtRef.current >= effectiveIntervalMs)
        || newDataSinceDispatch.current
      );

      const clearColor = propsRef.current.background
        ? hexToGpuColor(propsRef.current.background)
        : GPU_CLEAR_COLOR;
      submitFrame(
        device, canvasContext, gpuBuffers, computePipeline, renderPipeline,
        totalCount, state.depthView, clearColor, state.tsCtx,
        shouldRunCompute,
        (visibleCount) => { lastVisibleCountRef.current = visibleCount; }
      );

      if (shouldRunCompute) {
        lastSubmitAtRef.current = now;
        newDataSinceDispatch.current = false;
      }

      // Throttled stats / metrics.
      if (now - lastStatsRefreshRef.current >= STATS_REFRESH_MIN_MS) {
        lastStatsRefreshRef.current = now;
        const refresh = p.onRefresh;
        runDeferredRefresh(refresh);
      }

      if (document.visibilityState === "visible") {
        const metrics: StreamedPointCloudRenderMetrics = {
          renderedPoints:    lastVisibleCountRef.current,
          effectiveLodLevel: 0,
          cameraDistance:    cam.position.length(),
          frameTimeMs:       delta * 1000,
          fps:               delta > 0 ? 1 / delta : 0,
          gpuComputeMs:      state.tsCtx?.lastComputeMs,
          gpuRenderMs:       state.tsCtx?.lastRenderMs,
        };
        lastMetricsEmitRef.current = writeRenderMetrics({
          metrics,
          renderMetricsRef: p.renderMetricsRef,
          onRenderMetrics: p.onRenderMetrics,
          now,
          lastEmitAt: lastMetricsEmitRef.current,
        });
      }

      if (p.onTemporalStats && totalCount > 0) {
        if (shouldRunThrottled(now, lastTemporalStatsEmitRef.current, TEMPORAL_STATS_UI_MIN_MS)) {
          lastTemporalStatsEmitRef.current = now;
          const getTs = p.getTemporalStats;
          const tw    = p.timeWindowMs || undefined;
          const cb    = p.onTemporalStats;
          runDeferredRefresh(() => { cb(getTs(Date.now(), tw)); });
        }
      }
    };

    rafId = requestAnimationFrame(frame);
    return () => {
      cancelledRef.current = true;
      cancelAnimationFrame(rafId);
      props.rawIngestCallbackRef.current = null;
      if (gpuStateRef.current) {
        gpuStateRef.current.depthTexture?.destroy();
        if (gpuStateRef.current.tsCtx) destroyTimestampCtx(gpuStateRef.current.tsCtx);
        gpuStateRef.current.gpuBuffers.destroy();
        gpuStateRef.current = null;
      }
    };
    // All prop access is via propsRef.current (synced on every render above this effect).
    // Empty dep array: re-running would destroy in-flight GPU state and cause a black frame.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
