/**
 * <CopcPointCloud> — M15.8 rewrite
 *
 * GPU-resident COPC LOD pipeline (C3-B-2).
 *
 * Architecture:
 *   - Renders via WebGPUCopcScene (chained dispatchWorkgroupsIndirect) or
 *     WebGLCopcScene (CPU LOD cut, same atlas backend) depending on the
 *     resolved renderer backend.
 *   - Tile fetching is RAF-driven via CopcFetchScheduler (replaces 500ms polling).
 *   - AtlasManager handles free-list + LRU eviction (O(1) alloc/free).
 *   - Screen-space LOD traversal: GPU (WebGPU) or CPU (WebGL) per frame.
 *
 * Usage:
 *   <CopcPointCloud src="/scan.copc.laz" />
 *   <CopcPointCloud src="/scan.copc.laz" lodThreshold={0.02} maxConcurrent={16} />
 */

import React, { useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo } from "react";
import { Box3, Color, Raycaster, Vector2, Vector3, WebGLRenderer } from "three";
import { WebGPURenderer } from "three/webgpu";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { CopcSource } from "../copc/copc-source";
import type { CopcSourceOptions } from "../copc/copc-source";
import type { CopcIndex } from "../copc/copc-types";
import { voxelKeyString } from "../copc/copc-types";
import {
  adaptCopcConcurrency,
  rotateCandidatesForFairness,
  selectVisibleTiles,
} from "../copc/copc-frustum";
import { resolveRenderer } from "../webgpu/capability";
import type {
  AttributePackingMode,
  CopcFileStaticMeta,
  CopcFileViewSnapshot,
  GPUPowerPreference,
  RendererBackend,
  StreamedPointCloudRenderMetrics,
} from "../core/types";
import { buildCopcFileStaticMeta } from "../copc/copc-file-static-meta";
import { CopcFileMetricsBridge } from "./CopcFileMetricsBridge";
import {
  DEFAULT_ATLAS_TIERS,
  copcAtlasRequiredWebGPULimits,
  type AtlasTierConfig,
} from "../copc/copc-atlas-manager";
import type { CopcGpuPipelineConfig } from "../copc/copc-gpu-pipeline";
import type { CopcSceneRef } from "./WebGPUCopcScene";
import type { PointFlowConfig } from "../config";
import { resolveConfigValue } from "../config";
import { CopcInnerSceneRouter } from "./copc/inner-scene-router";
import { computeTileProgress, updateLoadStats } from "./copc/copc-progress";
import { sortCandidatesByStrategy } from "./copc/scheduler-logic";

export type CopcPrefetchStrategy = "frustum-priority" | "depth-first" | "nearest" | "bandwidth-saver";

// ── Props ─────────────────────────────────────────────────────────────────

export interface CopcPointCloudProps {
  /** URL of a COPC file (*.copc.laz). */
  src: string;

  // ── COPC / LOD ─────────────────────────────────────────────────────────
  /** Memory tile cache in MB. Default: 512. */
  maxCacheMb?: number;
  /** Use OPFS for persistent tile cache. Default: false. */
  persistCache?: boolean;
  /** Max parallel tile fetches. Default: 16. */
  maxConcurrent?: number;
  /** Candidate ordering for tile prefetch. Default: "frustum-priority". */
  prefetchStrategy?: CopcPrefetchStrategy;
  /** Maximum octree depth to load. Default: 12. */
  maxDepth?: number;
  /**
   * Screen-space geometric error threshold (0–1).
   * Lower → finer detail (more tiles loaded per frame).
   * Default: 0.01.
   */
  lodThreshold?: number;

  // ── Rendering ──────────────────────────────────────────────────────────
  /** Preferred renderer backend. Default: "auto". */
  rendererBackend?: RendererBackend;
  /**
   * GPU power preference hint for the WebGPU adapter request. "high-performance"
   * asks the browser to prefer the discrete GPU on multi-GPU systems.
   * No-op on the WebGL path. Default: "high-performance".
   */
  powerPreference?: GPUPowerPreference;
  /** Attribute to colour by. */
  colorBy?: string;
  /** Enable frustum culling in the LOD traversal. Default: true. */
  frustumCulling?: boolean;
  /** Point sprite base size in screen pixels. Default: 2. */
  basePointSize?: number;
  /** Optional scalar attribute packing mode for WebGL COPC uploads. */
  attributePacking?: AttributePackingMode;

  // ── Atlas sizing ───────────────────────────────────────────────────────
  /** Override atlas tier configurations. See DEFAULT_ATLAS_TIERS. */
  atlasTiers?: AtlasTierConfig[];

  // ── Deprecated / ignored props (kept for demo compatibility) ──────────
  /** @deprecated No longer needed — rendering is now atlas-based. */
  maxPoints?: number;
  /** @deprecated Replaced by RAF-driven scheduler. */
  pollIntervalMs?: number;
  /** @deprecated Rendering is now direct WebGPU/WebGL — no worker mode. */
  workerMode?: boolean;
  /** Filled each frame for demo HUD (camera distance, drawn points, LOD depth). */
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  /** Filled each frame when `fileViewSnapshotRef` is set — full COPC file + geometry snapshot. */
  fileViewSnapshotRef?: React.MutableRefObject<CopcFileViewSnapshot | null>;
  /** Shown in reports (e.g. original filename). */
  fileSourceLabel?: string | null;
  /** Called once when the index is parsed; `count` is summed COPC node point counts (may be capped). */
  onDeclaredPointCount?: (count: number) => void;
  /** LAS/COPC attribute keys from the index (for colour-by UI). */
  onAvailableAttributes?: (attributeKeys: string[]) => void;

  // ── Callbacks ──────────────────────────────────────────────────────────
  /** Called when the COPC index has been loaded and tile fetching begins. */
  onReady?: () => void;
  /** Estimated load progress (0–1) as tiles arrive. */
  onProgress?: (progress: number) => void;
  /** Called when the active renderer backend is resolved. */
  onRendererResolved?: (backend: Exclude<RendererBackend, "auto">) => void;
  /** Called on index fetch or tile decode failure. */
  onError?: (error: Error) => void;
  onTelemetryEvent?: (event: { phase: "index_loaded" | "tile_fetched" | "tile_failed"; key?: string; progress?: number; message?: string }) => void;
  config?: PointFlowConfig;
}

// ── Progress constants ────────────────────────────────────────────────────

const PHASE_INDEX = 0.14;  // index load accounts for this fraction of progress

function CopcFocusPick({
  staticMetaRef,
  orbitControlsRef,
}: {
  staticMetaRef: React.MutableRefObject<CopcFileStaticMeta | null>;
  orbitControlsRef: React.RefObject<any>;
}) {
  const { camera, gl } = useThree();
  const raycasterRef = useRef(new Raycaster());
  const boxRef = useRef(new Box3());
  const ndcRef = useRef(new Vector2());
  const hitPointRef = useRef(new Vector3());

  useEffect(() => {
    const canvas = gl.domElement;

    const onDoubleClick = (e: MouseEvent) => {
      const meta = staticMetaRef.current;
      if (!meta) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);

      ndcRef.current.set(x, y);
      raycasterRef.current.setFromCamera(ndcRef.current, camera);

      const box = boxRef.current;
      box.min.set(meta.bboxMin[0], meta.bboxMin[1], meta.bboxMin[2]);
      box.max.set(meta.bboxMax[0], meta.bboxMax[1], meta.bboxMax[2]);

      const hit = raycasterRef.current.ray.intersectBox(box, hitPointRef.current);
      if (!hit) return;

      const controls = orbitControlsRef.current;
      if (!controls?.target) return;
      controls.target.copy(hit);
      controls.update?.();
    };

    canvas.addEventListener("dblclick", onDoubleClick);
    return () => canvas.removeEventListener("dblclick", onDoubleClick);
  }, [camera, gl, staticMetaRef, orbitControlsRef]);

  return null;
}

// ── CopcPointCloud ────────────────────────────────────────────────────────

export function CopcPointCloud(props: CopcPointCloudProps) {
  const {
    src,
    maxCacheMb,
    persistCache,
    maxConcurrent,
    prefetchStrategy,
    maxDepth,
    lodThreshold,
    rendererBackend,
    powerPreference,
    colorBy,
    frustumCulling,
    basePointSize,
    attributePacking,
    atlasTiers,
    onReady,
    onProgress,
    onRendererResolved,
    onError,
    onTelemetryEvent,
    renderMetricsRef,
    fileViewSnapshotRef,
    fileSourceLabel,
    onDeclaredPointCount,
    onAvailableAttributes,
    config,
  } = props;

  const copcConfig = config?.copc;
  const globalConfig = config?.global;
  const resolvedMaxCacheMb = resolveConfigValue(512, maxCacheMb, copcConfig?.maxCacheMb);
  const resolvedPersistCache = resolveConfigValue(false, persistCache, copcConfig?.persistCache);
  const resolvedMaxConcurrent = resolveConfigValue(16, maxConcurrent, copcConfig?.maxConcurrent);
  const resolvedPrefetchStrategy = resolveConfigValue<CopcPrefetchStrategy>("frustum-priority", prefetchStrategy, copcConfig?.prefetchStrategy);
  const resolvedMaxDepth = resolveConfigValue(12, maxDepth, copcConfig?.maxDepth);
  const resolvedLodThreshold = resolveConfigValue(0.002, lodThreshold, copcConfig?.lodThreshold);
  const resolvedRendererBackend = resolveConfigValue<RendererBackend>("auto", rendererBackend, copcConfig?.rendererBackend, globalConfig?.rendererBackend);
  const resolvedPowerPreference = resolveConfigValue<GPUPowerPreference>("high-performance", powerPreference, copcConfig?.powerPreference, globalConfig?.powerPreference);
  const resolvedColorBy = colorBy ?? copcConfig?.colorBy ?? globalConfig?.colorBy;
  const resolvedFrustumCulling = resolveConfigValue(true, frustumCulling, copcConfig?.frustumCulling, globalConfig?.frustumCulling);
  const resolvedBasePointSize = resolveConfigValue(2.0, basePointSize, copcConfig?.basePointSize);
  const resolvedAttributePacking = resolveConfigValue<AttributePackingMode>("float32", attributePacking, copcConfig?.attributePacking);

  const [index, setIndex]   = useState<CopcIndex | null>(null);
  // Resolved synchronously so the Canvas gets the correct frameloop on first render.
  const [resolvedBackend, setResolvedBackend] = useState<"webgpu" | "webgl">(
    () => resolveRenderer(resolvedRendererBackend),
  );

  const sceneRef    = useRef<CopcSceneRef | null>(null);
  const sourceRef   = useRef<CopcSource | null>(null);
  const orbitControlsRef = useRef<any>(null);
  const fetchedRef  = useRef(new Set<string>());
  const fetchingRef = useRef(new Set<string>());
  const rafRef      = useRef<number | null>(null);
  const tileCountRef = useRef(0);
  const totalTilesRef = useRef(0);
  const mountedRef  = useRef(true);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const staticMetaRef = useRef<CopcFileStaticMeta | null>(null);
  const loadStatsRef = useRef({ tilesFetched: 0, tilesTotal: 0, progress: 0 });
  const viewParamsRef = useRef<{
    vpMatrix: number[];
    cameraPos: [number, number, number];
    cameraVelocity: [number, number, number];
    frameTimeMs: number;
  } | null>(null);
  const adaptiveConcurrencyRef = useRef(resolvedMaxConcurrent);
  const overBudgetStreakRef = useRef(0);
  const underBudgetStreakRef = useRef(0);
  const fairnessCursorRef = useRef(0);

  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onDeclaredPointCountRef = useRef(onDeclaredPointCount);
  onDeclaredPointCountRef.current = onDeclaredPointCount;
  const onAvailableAttributesRef = useRef(onAvailableAttributes);
  onAvailableAttributesRef.current = onAvailableAttributes;

  useEffect(() => {
    adaptiveConcurrencyRef.current = resolvedMaxConcurrent;
    overBudgetStreakRef.current = 0;
    underBudgetStreakRef.current = 0;
  }, [resolvedMaxConcurrent]);

  const pushProgress = useCallback((p: number) => {
    updateLoadStats(loadStatsRef, tileCountRef, totalTilesRef, p);
    onProgressRef.current?.(p);
  }, []);

  useEffect(() => {
    if (!index) {
      staticMetaRef.current = null;
      return;
    }
    const meta = buildCopcFileStaticMeta(index, {
      sourceLabel: fileSourceLabel ?? null,
      sourceSrc: src,
      maxCacheMb: resolvedMaxCacheMb,
      maxConcurrent: resolvedMaxConcurrent,
      persistCache: resolvedPersistCache,
      maxDepthUser: resolvedMaxDepth,
    });
    staticMetaRef.current = meta;
    onDeclaredPointCountRef.current?.(meta.declaredTotalPoints);
  }, [index, fileSourceLabel, src, resolvedMaxCacheMb, resolvedMaxConcurrent, resolvedPersistCache, resolvedMaxDepth]);

  useEffect(() => {
    return () => {
      if (fileViewSnapshotRef) fileViewSnapshotRef.current = null;
    };
  }, [src, fileViewSnapshotRef]);

  // ── Load COPC index ─────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    fetchedRef.current.clear();
    fetchingRef.current.clear();
    tileCountRef.current  = 0;
    totalTilesRef.current = 0;
    loadStatsRef.current = { tilesFetched: 0, tilesTotal: 0, progress: 0 };
    setIndex(null);

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    sourceRef.current?.destroy();
    sourceRef.current = null;

    const opts: CopcSourceOptions = {
      maxCacheMb: resolvedMaxCacheMb,
      persistCache: resolvedPersistCache,
      maxConcurrent: resolvedMaxConcurrent,
    };
    pushProgress(0.04);

    CopcSource.create(src, opts)
      .then((source) => {
        if (!mountedRef.current) { source.destroy(); return; }
        sourceRef.current = source;
        totalTilesRef.current = source.index.nodes.size;
        loadStatsRef.current = {
          tilesFetched: 0,
          tilesTotal: totalTilesRef.current,
          progress: PHASE_INDEX,
        };
        setIndex(source.index);
        pushProgress(PHASE_INDEX);
        onAvailableAttributesRef.current?.([...source.index.lasHeader.attributeKeys]);
        onReadyRef.current?.();
        onTelemetryEvent?.({ phase: "index_loaded", progress: PHASE_INDEX });
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        const resolvedErr = err instanceof Error ? err : new Error(String(err));
        onErrorRef.current?.(resolvedErr);
        onTelemetryEvent?.({ phase: "tile_failed", message: resolvedErr.message });
      });

    return () => {
      mountedRef.current = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      sourceRef.current?.destroy();
      sourceRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, resolvedMaxCacheMb, resolvedPersistCache, resolvedMaxConcurrent]);

  // ── RAF-driven tile fetch scheduler ───────────────────────────────────

  // Starts once the scene is ready (sceneRef is set) and the index is loaded.
  const startScheduler = useCallback(() => {
    const tick = () => {
      const source = sourceRef.current;
      const scene  = sceneRef.current;
      if (!source || !scene) { rafRef.current = requestAnimationFrame(tick); return; }

      const fetching = fetchingRef.current;
      const fetched  = fetchedRef.current;

      const vp = viewParamsRef.current;
      if (vp) {
        const next = adaptCopcConcurrency(
          adaptiveConcurrencyRef.current,
          resolvedMaxConcurrent,
          vp.frameTimeMs,
          overBudgetStreakRef.current,
          underBudgetStreakRef.current,
        );
        adaptiveConcurrencyRef.current = next.next;
        overBudgetStreakRef.current = next.overBudgetStreak;
        underBudgetStreakRef.current = next.underBudgetStreak;
      } else {
        adaptiveConcurrencyRef.current = resolvedMaxConcurrent;
        overBudgetStreakRef.current = 0;
        underBudgetStreakRef.current = 0;
      }
      const candidates = vp
        ? selectVisibleTiles(
            source.index.nodes,
            source.index.info,
            vp.vpMatrix,
            vp.cameraPos,
            resolvedLodThreshold,
            resolvedMaxDepth,
          )
        : [{ depth: 0, x: 0, y: 0, z: 0 }];

      const predictedCam = vp
        ? ([
            vp.cameraPos[0] + vp.cameraVelocity[0] * 0.25,
            vp.cameraPos[1] + vp.cameraVelocity[1] * 0.25,
            vp.cameraPos[2] + vp.cameraVelocity[2] * 0.25,
          ] as [number, number, number])
        : null;
      sortCandidatesByStrategy({
        strategy: resolvedPrefetchStrategy,
        candidates,
        info: source.index.info as any,
        vpPresent: Boolean(vp),
        predictedCam,
        cameraPos: vp?.cameraPos ?? null,
      });
      const rotatedCandidates = rotateCandidatesForFairness(candidates, fairnessCursorRef.current);
      if (rotatedCandidates.length > 0) {
        fairnessCursorRef.current = (fairnessCursorRef.current + 1) % rotatedCandidates.length;
      }

      // Fill concurrent fetch slots, preferring deeper nodes for the current view.
      let slotsAvailable = adaptiveConcurrencyRef.current - fetching.size;
      for (const voxKey of rotatedCandidates) {
        if (slotsAvailable <= 0) break;
        const ks = voxelKeyString(voxKey);
        if (fetched.has(ks) || fetching.has(ks)) continue;

        const node = source.index.nodes.get(ks);
        if (!node) continue;
        if (node.byteSize === 0n || node.pointCount <= 0n) { fetched.add(ks); continue; }

        slotsAvailable--;
        fetching.add(ks);

        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), 30_000);

        source.fetchTile(voxKey, ac.signal).then((tile) => {
          clearTimeout(timeout);
          fetching.delete(ks);
          if (!tile) { fetched.add(ks); return; }

          const success = sceneRef.current?.uploadTile(ks, tile, fetching) ?? false;
          if (success) {
            fetched.add(ks);
            tileCountRef.current++;
            const p = computeTileProgress(PHASE_INDEX, tileCountRef.current, Math.max(1, totalTilesRef.current));
            pushProgress(p);
            onTelemetryEvent?.({ phase: "tile_fetched", key: ks, progress: p });
          }
          // If upload failed (no atlas slot), the tile will be retried next tick.
        }).catch(() => {
          clearTimeout(timeout);
          fetching.delete(ks);
          fetched.add(ks);  // don't retry failed tiles
          onTelemetryEvent?.({ phase: "tile_failed", key: ks });
        });
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [resolvedMaxConcurrent, resolvedMaxDepth, resolvedLodThreshold, resolvedPrefetchStrategy]);

  const handleSceneReady = useCallback((ref: CopcSceneRef) => {
    sceneRef.current = ref;
    startScheduler();
  }, [startScheduler]);

  const handleRendererResolved = useCallback((b: "webgpu" | "webgl") => {
    setResolvedBackend(b);
    onRendererResolved?.(b);
  }, [onRendererResolved]);

  const orbitTarget = useMemo(() => {
    if (!index) return [0, 0, 0] as [number, number, number];
    const c = index.info.center;
    return [c[0], c[1], c[2]] as [number, number, number];
  }, [index]);

  useLayoutEffect(() => {
    if (!index) return;
    const el = canvasWrapperRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, [index]);

  // ── Camera fit ─────────────────────────────────────────────────────────
  // Don't mount the Canvas until the index is loaded — the camera position
  // is derived from index.info.center/halfsize and R3F ignores updated
  // camera props after mount.  Rendering before the index arrives would
  // leave the camera at the origin (500 km from the UTM point cloud).
  if (!index) return null;

  const h = index.info.halfsize;
  const center = index.info.center;
  const initialOrbitRadius = Math.min(Math.max(h * 2, 50), 400);
  const initialCamPos = [
    center[0] + initialOrbitRadius,
    center[1] - initialOrbitRadius,
    center[2] + initialOrbitRadius,
  ] as [number, number, number];
  const minOrbitDistance = Math.max(1e-3, h * 1e-4);

  const tierSpec = atlasTiers ?? DEFAULT_ATLAS_TIERS;
  const pipelineConfig: CopcGpuPipelineConfig = { atlasTiers: tierSpec };

  return (
    <div
      ref={canvasWrapperRef}
      style={{ width: "100%", height: "100%", overflow: "hidden" }}
    >
      <Canvas
        key={resolvedBackend}
        style={{ width: "100%", height: "100%" }}
        frameloop={resolvedBackend === "webgpu" ? "always" : "demand"}
        onCreated={({ scene }) => {
          scene.background = new Color(0x404040);
        }}
        gl={
          resolvedBackend === "webgpu"
            ? (glProps) => {
                const { canvas } = glProps;
                if (!(canvas instanceof HTMLCanvasElement)) {
                  setResolvedBackend("webgl");
                  return new WebGLRenderer(glProps);
                }
                try {
                  return new WebGPURenderer({
                    canvas,
                    powerPreference: resolvedPowerPreference === "default" ? undefined : resolvedPowerPreference,
                    requiredLimits: copcAtlasRequiredWebGPULimits(tierSpec),
                  }) as unknown as WebGLRenderer;
                } catch {
                  setResolvedBackend("webgl");
                  return new WebGLRenderer(glProps);
                }
              }
            : { antialias: false }
        }
        camera={{
          fov: 60,
          position: initialCamPos,
          near: 0.1,
          far: Math.max(initialOrbitRadius * 80, h * 10),
        }}
      >
        <OrbitControls
          ref={orbitControlsRef}
          target={orbitTarget}
          makeDefault
          enablePan
          enableRotate
          enableZoom
          minDistance={minOrbitDistance}
          maxDistance={index.info.halfsize * 10}
          zoomSpeed={8}
          panSpeed={1.5}
          enableDamping
          dampingFactor={0.07}
        />
        <CopcFocusPick
          staticMetaRef={staticMetaRef}
          orbitControlsRef={orbitControlsRef}
        />
        <CopcFileMetricsBridge
          staticMetaRef={staticMetaRef}
          renderMetricsRef={renderMetricsRef}
          fileViewSnapshotRef={fileViewSnapshotRef}
          loadStatsRef={loadStatsRef}
          viewParamsRef={viewParamsRef}
          lodThreshold={resolvedLodThreshold}
          frustumCulling={resolvedFrustumCulling}
          basePointSize={resolvedBasePointSize}
          colorBy={resolvedColorBy}
          requestedBackend={resolvedRendererBackend}
          activeBackend={resolvedBackend}
        />
        <CopcInnerSceneRouter
          index={index}
          requestedBackend={resolvedRendererBackend}
          sceneRefCallback={handleSceneReady}
          onRendererResolved={handleRendererResolved}
          orbitControlsRef={orbitControlsRef}
          colorBy={resolvedColorBy}
          frustumCulling={resolvedFrustumCulling}
          basePointSize={resolvedBasePointSize}
          attributePacking={resolvedAttributePacking}
          lodThreshold={resolvedLodThreshold}
          maxDepth={resolvedMaxDepth}
          atlasTiers={tierSpec}
          pipelineConfig={pipelineConfig}
          renderMetricsRef={renderMetricsRef}
          minOrbitDistance={minOrbitDistance}
        />
      </Canvas>
    </div>
  );
}
