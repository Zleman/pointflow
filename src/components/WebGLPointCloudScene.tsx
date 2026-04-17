import React, { useEffect, useRef } from "react";
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Matrix4, PointsMaterial } from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { StreamedPointCloudRenderMetrics, TemporalStats } from "../core/types";
import { isResetTransition } from "./reset-cadence";
import { computeEffectiveRefreshIntervalMs } from "./refresh-cadence";
import { createFrustumCullPool, updateFrustumPool, type FrustumCullPool } from "../core/frustum-culling";
import { createRenderWorkerBridge, type RenderWorkerBridge } from "../worker/render-worker-bridge";
import { hasCameraMoved, lodLevelFromCameraDistance } from "./webgl-point/scan-policy";
import {
  STATS_REFRESH_MIN_MS,
  TEMPORAL_STATS_UI_MIN_MS,
  writeRenderMetrics,
  shouldRunThrottled,
} from "./scene-metrics";
import { runDeferredRefresh } from "./scene-refresh";

export const VISUAL_REFRESH_HZ_MIN     = 4;
export const VISUAL_REFRESH_HZ_MAX     = 8;
export const VISUAL_REFRESH_HZ_DEFAULT = 6;

const _glVpMatrix = new Matrix4();

export interface WebGLPointCloudSceneProps {
  renderIntoBuffers: (
    positions: Float32Array,
    colors: Float32Array,
    lodStep: number,
    colorBy: string | undefined,
    isVisible?: (x: number, y: number, z: number) => boolean
  ) => number;
  onRefresh: () => void;
  manualLodLevel: number;
  colorBy: string | undefined;
  autoLod: boolean;
  frustumCulling: boolean;
  totalPoints: number;
  lodLevels: number;
  maxCapacity: number;
  visualRefreshRateHz: number;
  policyCadenceMs: number;
  expensivePassesEnabled: boolean;
  onRenderMetrics?: (metrics: StreamedPointCloudRenderMetrics) => void;
  /**
   * When set, metrics are written every useFrame tick. Prefer over `onRenderMetrics`
   * so React state is not updated synchronously inside the R3F frame loop.
   */
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  getBufferCapacity: () => number;
  isDynamicAlloc: boolean;
  adaptiveRefresh: boolean;
  workerCulling: boolean;
  setWorkerFrustum: (planes: Float32Array) => void;
  renderWorkerIngestRef: React.MutableRefObject<
    ((xyz: Float32Array, attr: Float32Array | null, count: number) => void) | null
  >;
  /** Written each frame with the current VP matrix elements (for CPU picking). */
  vpRef: React.MutableRefObject<Float32Array | null>;
  onTemporalStats?: (stats: TemporalStats) => void;
  getTemporalStats?: (nowMs: number, windowMs?: number) => TemporalStats;
  timeWindowMs?: number;
  /**
   * World-space point diameter for gl.POINTS rendering.
   * With sizeAttenuation=true, screen size = pointSize * focalLength / cameraDistance.
   * Default 0.02 works for synthetic ~1-unit scenes; use halfsize/50 for large LiDAR datasets.
   */
  pointSize?: number;
  cameraFit?: { halfsize: number };
}

export function WebGLPointCloudScene({
  renderIntoBuffers,
  onRefresh,
  manualLodLevel,
  colorBy,
  autoLod,
  frustumCulling,
  totalPoints,
  lodLevels,
  maxCapacity,
  visualRefreshRateHz,
  policyCadenceMs,
  expensivePassesEnabled,
  onRenderMetrics,
  renderMetricsRef,
  getBufferCapacity,
  isDynamicAlloc,
  adaptiveRefresh,
  workerCulling,
  setWorkerFrustum,
  renderWorkerIngestRef,
  vpRef,
  onTemporalStats,
  getTemporalStats,
  timeWindowMs,
  pointSize = 0.02,
}: WebGLPointCloudSceneProps) {
  const positionsRef = useRef<Float32Array | null>(null);
  const colorsRef    = useRef<Float32Array | null>(null);
  if (positionsRef.current === null) {
    // Always pre-allocate at maxCapacity for the main-thread render buffers.
    // In worker mode the render worker returns up to maxCapacity visible points per scan,
    // so a smaller initial alloc would require a costly BufferAttribute rebind on first
    // large scan result. Pre-allocating once avoids any rebind regardless of dynamicAlloc.
    positionsRef.current = new Float32Array(maxCapacity * 3);
  }
  if (colorsRef.current === null) {
    colorsRef.current = new Float32Array(maxCapacity * 3);
  }

  const frustumPoolRef = useRef<FrustumCullPool | null>(null);
  if (frustumPoolRef.current === null) {
    frustumPoolRef.current = createFrustumCullPool();
  }

  const renderWorkerBridgeRef          = useRef<RenderWorkerBridge | null>(null);

  // ── Round-disc PointsMaterial (onBeforeCompile injects gl_PointCoord disc clip) ──
  const matRef = useRef<PointsMaterial | null>(null);
  if (matRef.current === null) {
    const mat = new PointsMaterial({ size: pointSize, sizeAttenuation: true, vertexColors: true });
    mat.onBeforeCompile = (shader) => {
      // Inject early-discard disc clip after clipping-plane test.
      // dot(cxy, cxy) > 1.0 → outside unit circle → discard the square corner pixel.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <clipping_planes_fragment>",
        [
          "#include <clipping_planes_fragment>",
          "vec2 _pfCxy = 2.0 * gl_PointCoord - 1.0;",
          "if (dot(_pfCxy, _pfCxy) > 1.0) discard;",
        ].join("\n")
      );
    };
    matRef.current = mat;
  }

  const geoRef       = useRef<BufferGeometry | null>(null);
  const posAttrRef   = useRef<BufferAttribute | null>(null);
  const colorAttrRef = useRef<BufferAttribute | null>(null);
  if (geoRef.current === null) {
    const geo       = new BufferGeometry();
    const posAttr   = new BufferAttribute(positionsRef.current, 3);
    const colorAttr = new BufferAttribute(colorsRef.current, 3);
    posAttr.setUsage(DynamicDrawUsage);
    colorAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute("position", posAttr);
    geo.setAttribute("color", colorAttr);
    geo.setDrawRange(0, 0);
    geoRef.current     = geo;
    posAttrRef.current = posAttr;
    colorAttrRef.current = colorAttr;
  }

  useEffect(() => {
    // Ping-pong buffers are always allocated at maxCapacity so they can hold
    // a full-ring scan at stride 1 regardless of dynamic-alloc growth.
    const bridge = createRenderWorkerBridge(maxCapacity);
    renderWorkerBridgeRef.current = bridge;
    if (bridge) {
      renderWorkerIngestRef.current = (xyz, attr, count, isRgb = false) => {
        bridge.ingestSoA(xyz, attr, count, isRgb);
        // Demand frameloop: kick a frame so bridge.scan picks up newly ingested data.
        // Without this, streaming chunks arrive but useFrame never runs (totalPoints
        // stays 0 with reactivePush:false, so the totalPoints useEffect never fires).
        invalidateRef.current();
      };
    } else {
      // No worker bridge — main-thread scan in useFrame reads the CPU ring directly.
      // Still need to kick a frame when streaming data arrives.
      renderWorkerIngestRef.current = () => { invalidateRef.current(); };
    }
    return () => {
      renderWorkerIngestRef.current = null;
      bridge?.terminate();
      renderWorkerBridgeRef.current = null;
      geoRef.current?.dispose();
      matRef.current?.dispose();
    };
    // maxCapacity is fixed at mount; a change triggers a full remount via key={maxPoints} upstream.
    // renderWorkerIngestRef and invalidateRef are refs — .current access is safe without listing.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync pointSize prop into the live material (cameraFit may arrive after mount).
  useEffect(() => {
    if (matRef.current) matRef.current.size = pointSize;
  }, [pointSize]);

  const lastRenderMetricsEmitRef = useRef(0);
  const lastTemporalStatsEmitRef = useRef(0);
  const lastVisualUpdateRef      = useRef(0);
  const lastStatsRefreshRef      = useRef(0);
  const displayLodLevelRef       = useRef(-1);
  const displayColorByRef        = useRef<string | undefined>(colorBy);
  const pointCountRef            = useRef(0);
  const prevTotalPointsRef       = useRef(totalPoints);
  const onRefreshRef             = useRef(onRefresh);
  onRefreshRef.current           = onRefresh;
  const renderIntoBuffersRef     = useRef(renderIntoBuffers);
  renderIntoBuffersRef.current   = renderIntoBuffers;
  const intervalMs               = Math.max(1000 / Math.max(0.1, visualRefreshRateHz), policyCadenceMs);
  const frameTimeMsRef           = useRef(intervalMs);
  const workerFrustumPlanesRef   = useRef(new Float32Array(24));

  // Camera-dirty tracking: skip scan + GPU upload when camera and data are unchanged.
  const lastCamRef = useRef({ x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }); // qw=1 matches default Three.js identity quaternion
  const scanEverDoneRef = useRef(false);

  // In frameloop="demand" mode, R3F only renders when invalidate() is called.
  // Store the function in a ref so async callbacks (scan result onmessage) can call it.
  const { invalidate } = useThree();
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;

  // Trigger a render whenever totalPoints or colorBy changes so newly-ingested data
  // and colorBy switches are reflected even in demand mode with a static camera.
  useEffect(() => { invalidate(); }, [totalPoints, colorBy, invalidate]);

  useFrame(({ camera }, delta) => {
    const distance = camera.position.length();
    const now      = performance.now();

    _glVpMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    vpRef.current = _glVpMatrix.elements as unknown as Float32Array;

    const FRAME_EMA = 0.15;
    if (adaptiveRefresh && delta > 0) {
      frameTimeMsRef.current = frameTimeMsRef.current * (1 - FRAME_EMA) + delta * 1000 * FRAME_EMA;
    }
    const effectiveIntervalMs = computeEffectiveRefreshIntervalMs(
      adaptiveRefresh,
      visualRefreshRateHz,
      policyCadenceMs,
      frameTimeMsRef.current,
    );

    const desiredLevel   = autoLod ? lodLevelFromCameraDistance(distance) : manualLodLevel;
    const effectiveLevel = Math.max(0, Math.min(desiredLevel, lodLevels - 1));
    const effectiveColorBy    = expensivePassesEnabled ? colorBy : undefined;
    const levelOrColorChanged =
      effectiveLevel !== displayLodLevelRef.current || effectiveColorBy !== displayColorByRef.current;
    const throttleElapsed = now - lastVisualUpdateRef.current >= effectiveIntervalMs;
    const resetSignal     = isResetTransition(prevTotalPointsRef.current, totalPoints);

    // Camera-dirty check: detect movement via position + quaternion delta.
    // All four quaternion components (x, y, z, w) must be compared — a rotation
    // that only changes w (e.g. 180° flip) would be missed if w is excluded.
    const cp = camera.position, cq = camera.quaternion;
    const lc = lastCamRef.current;
    const cameraMoved = hasCameraMoved({
      x: cp.x,
      y: cp.y,
      z: cp.z,
      qx: cq.x,
      qy: cq.y,
      qz: cq.z,
      qw: cq.w,
    }, lc);
    const newDataArrived  = totalPoints !== prevTotalPointsRef.current;
    // Allow scan to proceed when there is something new to show. For fully-static scenes
    // with no camera movement, this eliminates repeated bufferSubData calls that stall
    // the GPU pipeline on integrated GPUs.
    const sceneChanged = cameraMoved || newDataArrived || levelOrColorChanged || resetSignal || !scanEverDoneRef.current;

    // Extract frustum planes once into a shared buffer — reused by both workerCulling
    // (setWorkerFrustum) and the render worker bridge scan. Avoids two identical 6-plane
    // extraction loops per frame when both paths are active.
    let extractedFrustumPlanes: Float32Array | null = null;
    if (frustumCulling || workerCulling) {
      updateFrustumPool(frustumPoolRef.current!, camera.projectionMatrix, camera.matrixWorldInverse);
      const planes  = workerFrustumPlanesRef.current;
      const fPlanes = frustumPoolRef.current!.frustum.planes;
      for (let i = 0; i < 6; i++) {
        const p = fPlanes[i];
        planes[i * 4]     = p.normal.x;
        planes[i * 4 + 1] = p.normal.y;
        planes[i * 4 + 2] = p.normal.z;
        planes[i * 4 + 3] = p.constant;
      }
      extractedFrustumPlanes = planes;
      if (workerCulling) setWorkerFrustum(planes);
    }

    if ((throttleElapsed || levelOrColorChanged || resetSignal) && sceneChanged) {
      lc.x = cp.x; lc.y = cp.y; lc.z = cp.z;
      lc.qx = cq.x; lc.qy = cq.y; lc.qz = cq.z; lc.qw = cq.w;
      scanEverDoneRef.current = true;
      const stride = 1 << effectiveLevel;

      if (resetSignal) {
        renderWorkerBridgeRef.current?.reset();
      }

      const bridge = renderWorkerBridgeRef.current;
      if (bridge) {
        const frustumPlanes = frustumCulling ? extractedFrustumPlanes : null;
        const colorMode = effectiveColorBy === "rgb" ? 2
          : (effectiveColorBy !== undefined && effectiveColorBy !== "none") ? 0
          : 1;
        const accepted = bridge.scan(frustumPlanes, stride, colorMode, (positions, colors, count) => {
          // Copy only the visible slice into main-thread buffers to avoid uploading
          // the full capacity buffer when only a fraction contains new data.
          // positionsRef is pre-allocated at maxCapacity so no rebind is ever needed.
          const visCount3 = count * 3;

          positionsRef.current!.set(positions.subarray(0, visCount3));
          colorsRef.current!.set(colors.subarray(0, visCount3));

          posAttrRef.current!.updateRanges[0]   = { start: 0, count: visCount3 };
          colorAttrRef.current!.updateRanges[0] = { start: 0, count: visCount3 };
          posAttrRef.current!.needsUpdate   = true;
          colorAttrRef.current!.needsUpdate = true;

          geoRef.current!.setDrawRange(0, count);
          pointCountRef.current = count;
          // In frameloop="demand", geometry updates in onmessage don't auto-render —
          // explicitly request a frame so the new geometry becomes visible.
          invalidateRef.current();
        });
        if (!accepted) return;
      } else {
        let isVisible: ((x: number, y: number, z: number) => boolean) | undefined;
        if (frustumCulling && !workerCulling) {
          isVisible = frustumPoolRef.current!.predicate;
        }

        const n = renderIntoBuffersRef.current(
          positionsRef.current!,
          colorsRef.current!,
          stride,
          effectiveColorBy,
          isVisible
        );

        const visibleCount3 = n * 3;
        posAttrRef.current!.updateRanges[0] = { start: 0, count: visibleCount3 };
        colorAttrRef.current!.updateRanges[0] = { start: 0, count: visibleCount3 };
        posAttrRef.current!.needsUpdate   = true;
        colorAttrRef.current!.needsUpdate = true;
        geoRef.current!.setDrawRange(0, n);
        pointCountRef.current = n;
        invalidateRef.current();
      }

      lastVisualUpdateRef.current  = now;
      displayLodLevelRef.current   = effectiveLevel;
      displayColorByRef.current    = effectiveColorBy;

      if (now - lastStatsRefreshRef.current >= STATS_REFRESH_MIN_MS) {
        lastStatsRefreshRef.current = now;
        const r = onRefreshRef.current;
        runDeferredRefresh(r);
      }
    }

    prevTotalPointsRef.current = totalPoints;

    if (document.visibilityState === "visible") {
      const metrics: StreamedPointCloudRenderMetrics = {
        renderedPoints: pointCountRef.current,
        effectiveLodLevel: displayLodLevelRef.current,
        cameraDistance: distance,
        frameTimeMs: delta * 1000,
        fps: delta > 0 ? 1 / delta : 0,
      };
      lastRenderMetricsEmitRef.current = writeRenderMetrics({
        metrics,
        renderMetricsRef,
        onRenderMetrics,
        now,
        lastEmitAt: lastRenderMetricsEmitRef.current,
      });
    }

    if (onTemporalStats && getTemporalStats && totalPoints > 0) {
      if (shouldRunThrottled(now, lastTemporalStatsEmitRef.current, TEMPORAL_STATS_UI_MIN_MS)) {
        lastTemporalStatsEmitRef.current = now;
        const tw = timeWindowMs || undefined;
        runDeferredRefresh(() => {
          onTemporalStats(getTemporalStats(Date.now(), tw));
        });
      }
    }
  });

  return (
    <points>
      <primitive object={geoRef.current} attach="geometry" />
      <primitive object={matRef.current} attach="material" />
    </points>
  );
}
