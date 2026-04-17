/**
 * <PointCloud>
 *
 * Zero-config static point cloud component. Drop in a src prop pointing to a
 * PLY or XYZ file and PointFlow handles everything else: off-thread parsing,
 * progressive rendering, auto-configured maxPoints, LOD, WebGPU/WebGL backend
 * selection, and frustum culling.
 *
 * Supported formats
 *   .ply  — binary little-endian, binary big-endian, ASCII
 *   .xyz / .csv / .txt  — whitespace or comma delimited, optional header row
 *
 * Usage
 *   <PointCloud src="/scans/scene.ply" />
 *   <PointCloud src="/data/lidar.xyz" colorBy="intensity" maxPoints={2_000_000} />
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { StreamedPointCloud, type StreamedPointCloudProps, type StreamedPointCloudRef } from "./StreamedPointCloud";
import { usePointCloud, type PointCloudStatus } from "../hooks/usePointCloud";
import type { PickedPoint, PickStrategy, PointCloudLoadTelemetryEvent, RendererBackend } from "../core/types";
import type { StreamedPointCloudRenderMetrics } from "./StreamedPointCloud";
import type { PointCloudSource } from "../parsers/source-resolver";
import type { PointFlowConfig } from "../config";
import { resolveConfigValue } from "../config";


export interface PointCloudProps {
  // ── Required ───────────────────────────────────────────────────────────────
  /**
   * Source to load. Accepts:
   * - A URL string (`"/scan.ply"`, `"https://…"`)
   * - A `File` object from `<input type="file">` — no server needed
   * - A `Blob` — e.g. from a fetch response
   */
  src: PointCloudSource;

  // ── Capacity ───────────────────────────────────────────────────────────────
  /**
   * Maximum number of points to retain. Defaults to the vertex count reported
   * by the file header (PLY), or 1 000 000 for XYZ/CSV files without a header
   * count. When a file has more points than maxPoints, oldest points are evicted
   * (ring-buffer drop-oldest policy).
   */
  maxPoints?: number;

  // ── Rendering ──────────────────────────────────────────────────────────────
  /** Preferred renderer. Defaults to "auto" (WebGPU → WebGL fallback). */
  rendererBackend?: RendererBackend;
  /** Attribute name to colour by. Defaults to the first attribute in the file. */
  colorBy?: string;
  /** Enable frustum culling. Default: true. */
  frustumCulling?: boolean;
  /**
   * Enable automatic LOD. Defaults to true when maxPoints > 500 000, false
   * otherwise. Explicit value overrides the automatic inference.
   */
  autoLod?: boolean;
  /** Fixed LOD level (0 = finest). Overrides autoLod when set. */
  lodLevel?: number;
  /** Visual refresh target in Hz. Default: 8. */
  visualRefreshRateHz?: number;
  /** Throttle refresh under load. Default: false. */
  adaptiveRefresh?: boolean;
  /** Downsample ingest chunk rate under high pressure. */
  adaptiveIngest?: boolean;

  // ── Parser ─────────────────────────────────────────────────────────────────
  /** Points parsed and ingested per batch. Smaller = smoother progressive load. Default: 10 000. */
  chunkSize?: number;
  /**
   * Factory function that creates the loader worker. Defaults to the standard
   * loader (PLY / XYZ / LAS). Pass `createLazLoader` from `pointflow/laz` to
   * also support LAZ (compressed LAS) files.
   *
   * @example
   * import { createLazLoader } from "pointflow/laz";
   * <PointCloud src="/scan.laz" loaderFactory={createLazLoader} />
   */
  loaderFactory?: () => Worker;

  // ── Policy ─────────────────────────────────────────────────────────────────
  tier?: StreamedPointCloudProps["tier"];
  runtimeMode?: StreamedPointCloudProps["runtimeMode"];

  // ── Callbacks ─────────────────────────────────────────────────────────────
  /** Called when all chunks have been parsed and ingested. */
  onReady?: () => void;
  /** Called after each chunk. progress is 0–1. */
  onProgress?: (progress: number) => void;
  /** Called if the loader encounters an error. */
  onError?: (error: Error) => void;
  /** Per-frame render metrics (same shape as StreamedPointCloud). */
  onRenderMetrics?: (metrics: StreamedPointCloudRenderMetrics) => void;
  /** When set, metrics are written here each frame; omit `onRenderMetrics` from the RAF path. */
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  /** Called when the active renderer backend is resolved. */
  onRendererResolved?: (backend: Exclude<RendererBackend, "auto">) => void;
  /** Called when the user clicks a point. See StreamedPointCloud for details. */
  onPointPick?: (point: PickedPoint) => void;
  /** Pick radius in CSS pixels. Default: 8. */
  pickRadius?: number;
  /** Foveated importance boost. See StreamedPointCloud for details. */
  fovStrength?: number;
  /** Enable progressive accumulation. See StreamedPointCloud for details. */
  accumulationMode?: boolean;
  /** Static duration before accumulation activates (ms). Default: 200. */
  accumulationThresholdMs?: number;
  /** Called when accumulation state changes. */
  onAccumulationChange?: (isAccumulating: boolean) => void;
  /** Called when the file header lists available attribute keys. */
  onAvailableAttributes?: (attributeKeys: string[]) => void;
  /** Optional loader lifecycle telemetry callback. */
  onLoadTelemetry?: (event: PointCloudLoadTelemetryEvent) => void;
  /** Exposes imperative load controls (currently abort). */
  onLoadControls?: (controls: { abort: () => void }) => void;
  /** Picking strategy for stacked points. */
  pickStrategy?: PickStrategy;
  config?: PointFlowConfig;
}


/** Infer a sensible maxPoints when the caller didn't provide one. */
function resolveMaxPoints(userMax: number | undefined, detectedCount: number | null): number {
  if (userMax !== undefined) return userMax;
  if (detectedCount !== null && detectedCount > 0) return detectedCount;
  return 1_000_000;
}

/** Auto-enable LOD for large scenes when the caller hasn't set a preference. */
function resolveAutoLod(userAutoLod: boolean | undefined, maxPts: number): boolean {
  if (userAutoLod !== undefined) return userAutoLod;
  return maxPts > 500_000;
}


export function PointCloud(props: PointCloudProps) {
  const {
    src,
    maxPoints,
    rendererBackend,
    colorBy,
    frustumCulling,
    autoLod: autoLodProp,
    lodLevel,
    visualRefreshRateHz,
    adaptiveRefresh,
    adaptiveIngest,
    chunkSize,
    loaderFactory,
    tier,
    runtimeMode,
    onReady,
    onProgress,
    onError,
    onRenderMetrics,
    renderMetricsRef,
    onRendererResolved,
    onPointPick,
    pickRadius,
    fovStrength,
    accumulationMode,
    accumulationThresholdMs,
    onAccumulationChange,
    onAvailableAttributes,
    onLoadTelemetry,
    onLoadControls,
    pickStrategy,
    config,
  } = props;

  const pointCloudConfig = config?.pointCloud;
  const globalConfig = config?.global;
  const hookConfig = config?.hooks?.usePointCloud;
  const userMaxPoints = maxPoints ?? pointCloudConfig?.maxPoints;
  const resolvedRendererBackend = resolveConfigValue<RendererBackend>("auto", rendererBackend, pointCloudConfig?.rendererBackend, globalConfig?.rendererBackend);
  const resolvedColorBy = colorBy ?? pointCloudConfig?.colorBy ?? globalConfig?.colorBy;
  const resolvedFrustumCulling = resolveConfigValue(true, frustumCulling, pointCloudConfig?.frustumCulling, globalConfig?.frustumCulling);
  const userAutoLod = autoLodProp ?? pointCloudConfig?.autoLod;
  const resolvedLodLevel = lodLevel ?? pointCloudConfig?.lodLevel;
  const resolvedVisualRefreshRateHz = visualRefreshRateHz ?? pointCloudConfig?.visualRefreshRateHz;
  const resolvedAdaptiveRefresh = resolveConfigValue(false, adaptiveRefresh, pointCloudConfig?.adaptiveRefresh, globalConfig?.adaptiveRefresh);
  const resolvedAdaptiveIngest = resolveConfigValue(false, adaptiveIngest, pointCloudConfig?.adaptiveIngest, globalConfig?.adaptiveIngest);
  const resolvedChunkSize = chunkSize ?? pointCloudConfig?.chunkSize ?? hookConfig?.chunkSize;
  const resolvedLoaderFactory = loaderFactory ?? pointCloudConfig?.loaderFactory ?? hookConfig?.loaderFactory;
  const resolvedTier = tier ?? pointCloudConfig?.tier ?? globalConfig?.tier;
  const resolvedRuntimeMode = runtimeMode ?? pointCloudConfig?.runtimeMode ?? globalConfig?.runtimeMode;
  const resolvedPickRadius = (pickRadius ?? pointCloudConfig?.pickRadius) ?? globalConfig?.pickRadius;
  const resolvedPickStrategy = pickStrategy ?? pointCloudConfig?.pickStrategy ?? globalConfig?.pickStrategy;
  const resolvedFovStrength = fovStrength ?? pointCloudConfig?.fovStrength;
  const resolvedAccumulationMode = accumulationMode ?? pointCloudConfig?.accumulationMode;
  const resolvedAccumulationThresholdMs = accumulationThresholdMs ?? pointCloudConfig?.accumulationThresholdMs;

  const { status, progress, detectedPointCount, onSceneReady, abort } = usePointCloud(src, {
    chunkSize: resolvedChunkSize,
    loaderFactory: resolvedLoaderFactory,
    onProgress,
    onError,
    onAvailableAttributes,
    onTelemetry: onLoadTelemetry,
    config,
  });

  useEffect(() => {
    onLoadControls?.({ abort });
  }, [onLoadControls, abort]);

  // Report onReady when status transitions to "ready".
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    if (status === "ready") onReadyRef.current?.();
  }, [status]);

  // ── Effective maxPoints ────────────────────────────────────────────────────
  // We resolve maxPoints once we know the detected count. We DON'T remount
  // StreamedPointCloud when maxPoints changes — instead we use a stable value
  // that is at least as large as the detected count so the ring buffer fits.
  const [effectiveMaxPoints, setEffectiveMaxPoints] = useState<number>(
    resolveMaxPoints(userMaxPoints, null)
  );

  useEffect(() => {
    const next = resolveMaxPoints(userMaxPoints, detectedPointCount);
    setEffectiveMaxPoints((prev) => {
      // Only grow — never shrink while a file is loaded, to avoid ring-buffer
      // recreations mid-stream.
      return Math.max(prev, next);
    });
  }, [userMaxPoints, detectedPointCount]);

  const handleStreamReady = useCallback(onSceneReady, [onSceneReady]);

  // ── Derived visual config ─────────────────────────────────────────────────
  const autoLod    = resolveAutoLod(userAutoLod, effectiveMaxPoints);
  const lodLevels  = autoLod ? 3 : 1;

  return (
    <StreamedPointCloud
      // Capacity — key forces remount only when maxPoints grows beyond the
      // current ring size (rare; only on first detection for large files).
      key={effectiveMaxPoints}
      maxPoints={effectiveMaxPoints}
      lodLevels={lodLevels}
      // Rendering
      rendererBackend={resolvedRendererBackend}
      colorBy={resolvedColorBy}
      frustumCulling={resolvedFrustumCulling}
      autoLod={autoLod}
      lodLevel={resolvedLodLevel}
      visualRefreshRateHz={resolvedVisualRefreshRateHz}
      adaptiveRefresh={resolvedAdaptiveRefresh}
      adaptiveIngest={resolvedAdaptiveIngest}
      // Policy
      tier={resolvedTier}
      runtimeMode={resolvedRuntimeMode}
      workerMode={true}  // always use render worker for static files
      // Callbacks
      onReady={handleStreamReady}
      onRenderMetrics={onRenderMetrics}
      renderMetricsRef={renderMetricsRef}
      onRendererResolved={onRendererResolved}
      onPointPick={onPointPick}
      pickRadius={resolvedPickRadius}
      pickStrategy={resolvedPickStrategy}
      fovStrength={resolvedFovStrength}
      accumulationMode={resolvedAccumulationMode}
      accumulationThresholdMs={resolvedAccumulationThresholdMs}
      onAccumulationChange={onAccumulationChange}
      progress={progress}
      config={config}
    />
  );
}

// Re-export status type so consumers don't need a separate import.
export type { PointCloudStatus };
