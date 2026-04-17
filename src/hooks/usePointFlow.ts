// File size exception (~426 lines): usePointFlow is a single React hook whose length comes from
// sequential useEffect blocks for policy sync, worker lifecycle, and dynamic-alloc tracking.
// Each effect block is independent and clearly scoped; splitting into sub-hooks would force
// artificial state-lifting and complicate the public API.
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { PointBuffer } from "../core/backpressure";
import { buildLodBuckets } from "../core/lod";
import type { BackpressurePolicy, DynamicAllocOptions, PackedAttributeChannel, PointChunk, PointRecord } from "../core/types";
import {
  computeActivePolicy,
  detectTierFromEnvironment,
  type ActivePolicy,
  type RuntimeMode,
  type TierLevel,
  type UserConstraints,
} from "../core/runtime-policy";
import { createWorkerBridge, type WorkerBridge } from "../worker/worker-bridge";
import type { PointFlowConfig } from "../config";
import { resolveConfigValue } from "../config";

export interface UsePointFlowOptions {
  maxPoints?: number;
  lodLevels?: number;
  mode?: BackpressurePolicy["mode"];
  /**
   * When true (default), pushChunk updates React state immediately.
   * StreamedPointCloud uses false to decouple ingest from render cadence.
   */
  reactivePush?: boolean;
  /**
   * When true, chunk preprocessing is delegated to a Web Worker. Typed-array
   * payloads are Transferred (zero-copy) across the thread boundary.
   * Falls back silently to the main-thread ingest path if Worker creation
   * fails (e.g. test environment, restrictive CSP).
   * Default: false.
   */
  workerMode?: boolean;


  /**
   * Hardware capability tier. Drives point budget and update cadence defaults.
   * When omitted, tier is detected from WebGL capability signals at mount.
   * Can be overridden at any time — change takes effect on next render cycle.
   */
  tier?: TierLevel;

  /**
   * Runtime operating mode.
   * - eco: lower point budget and update cadence; conservative thermal profile.
   * - balanced (default): stable interactive workload target.
   * - max_throughput: full tier budget, highest update cadence.
   * - custom: full budget; apply userConstraints to shape behavior precisely.
   */
  runtimeMode?: RuntimeMode;

  /**
   * Hard ceilings for automatic policy decisions.
   * User constraints always take precedence over mode defaults.
   * Policy may not exceed these values under any mode, including Max Throughput.
   */
  constraints?: UserConstraints;

  /**
   * When true, disables all tier/mode/policy logic and reverts to
   * legacy behavior (maxPoints as the render budget, fixed cadence).
   * Default: false.
   */
  legacyMode?: boolean;
  /**
   * When set, enables dynamic buffer allocation. Buffers start at
   * `initialCapacity` (default: min(1024, maxPoints)) and grow toward
   * `maxPoints` as points are ingested, using `growthFactor` (default: 2).
   * When omitted (default), all buffers are pre-allocated to `maxPoints`
   * upfront. See README for tradeoffs.
   */
  dynamicAlloc?: DynamicAllocOptions;
  /**
   * When true (default), a uniform-grid spatial index is used inside
   * copyToTypedArrays to skip frustum-visibility tests for entire regions
   * of the point cloud, reducing per-frame CPU work when many points are
   * outside the frustum. Only active when frustum culling is also on and
   * LOD stride is 1 (full-detail renders).
   * Set to false to restore the original per-point isVisible behavior.
   */
  spatialCulling?: boolean;
  /**
   * When true and workerMode is also true, each chunk is sent to the ingest
   * worker together with the current camera frustum. The worker filters out
   * points outside the frustum before returning pre-packed data; only visible
   * points are ingested into the ring buffer. Reduces both buffer occupancy and
   * copyToTypedArrays iteration cost when the camera views a small subset of
   * the incoming stream.
   * Trade-off: points ingested while outside the frustum are permanently
   * discarded — the buffer does not accumulate a full-history view.
   * Default: false.
   */
  workerCulling?: boolean;
  /**
   * Attribute key used as the per-point importance signal for K-lookahead
   * eviction and GPU stochastic sampling. When omitted, all points are equally important.
   *
   * Pass `"auto"` to have PointFlow pick the field automatically from the first
   * ingest chunk: prefers `"intensity"` if present, otherwise uses the first
   * available attribute channel. The field is locked in after the first chunk
   * and does not change with subsequent data.
   */
  importanceField?: string;
  /**
  * Half-life (ms) for recency decay in the importance score.
   * A point this many ms old has recency weight 0.5. Default: no decay (recency = 1).
   */
  maxStalenessMs?: number;
  /**
   * Temporal time window for rendering. When set (> 0), only points
   * ingested within the last `timeWindowMs` milliseconds are rendered.
   * The buffer still retains all points up to `maxPoints` — this only
   * affects which points pass through the render stage.
   * 0 or undefined = show all points (no window).
   * WebGPU: enforced in the compute shader. WebGL: enforced in copyToTypedArrays.
   */
  timeWindowMs?: number;
  /**
   * Called immediately after each chunk is ingested, on the main thread.
   * Receives the raw xyz positions (Float32Array, stride 3), packed attribute
   * channels, and the chunk point count. Use this to write new points directly
   * to GPU storage buffers without the O(ring-size) full scan.
   * Fired in both worker and non-worker ingest paths.
   */
  onRawIngest?: (
    xyz: Float32Array,
    attributes: PackedAttributeChannel[] | undefined,
    count: number
  ) => void;
  /** Enable adaptive downsampling of incoming chunks when pressure is high. */
  adaptiveIngest?: boolean;
  /** Optional telemetry callback for ingest lifecycle diagnostics. */
  onTelemetryEvent?: (event: { phase: "chunk_ingested" | "chunk_throttled"; inputCount: number; outputCount: number; pressureRatio: number }) => void;
  autoTunePolicy?: boolean;
  config?: PointFlowConfig;
}

export interface UsePointFlowState {
  points: PointRecord[];
  lodBuckets: PointRecord[][];
  totalPoints: number;
  droppedPoints: number;
  isUnderPressure: boolean;
  pushChunk: (chunk: PointChunk) => void;
  reset: () => void;
  /**
   * Direct access to the underlying PointBuffer ref for WebGPU SoA upload.
   * Prefixed with underscore to signal internal/advanced use.
   */
  _bufferRef: MutableRefObject<PointBuffer | null>;
  /**
   * Pull the latest buffer state into React. Called by the controlled render
   * cadence in PointCloudScene; also available for tests and advanced use.
   */
  refresh: () => void;
  /** Read the current buffer contents without triggering a React update. */
  getSnapshot: () => PointRecord[];
  /** Pull only aggregate stats into React without rebuilding points/LOD arrays. */
  refreshStats: () => void;
  /**
   * Write the current buffer directly into caller-owned typed arrays at the
   * given LOD stride. O(size/stride) — far-camera levels are cheaper.
   * Returns the number of points written. Does not trigger a React update.
   *
  * @param isVisible Optional frustum predicate. When provided, only points
   *                  for which isVisible(x, y, z) returns true are written.
   */
  renderIntoBuffers: (
    positions: Float32Array,
    colors: Float32Array,
    lodStep: number,
    colorBy: string | undefined,
    isVisible?: (x: number, y: number, z: number) => boolean
  ) => number;
  /**
   * Current active policy (tier, mode, effective budgets).
   * Useful for telemetry, debugging, and benchmark evidence.
   */
  activePolicy: ActivePolicy;
  /**
  * Returns the current allocated capacity of the ring buffer.
   * Equals maxPoints in pre-alloc mode; in dynamic mode, grows from
   * initialCapacity toward maxPoints as points are ingested.
   */
  getBufferCapacity: () => number;
  /**
   * Update the frustum planes used by the ingest worker for worker-side
   * culling. Called each frame by PointCloudScene when workerCulling is true.
   * No-op when workerMode is false or the worker bridge is unavailable.
   */
  setWorkerFrustum: (planes: Float32Array) => void;
  /** Increments each time reset() is called. Used by WebGPUPointCloudScene to clear GPU state. */
  resetVersion: number;
}

function applyAdaptiveIngest(
  points: PointRecord[],
  pressureRatio: number,
): PointRecord[] {
  if (pressureRatio < 0.95 || points.length < 2) return points;
  const stride = pressureRatio >= 0.985 ? 4 : 2;
  const out: PointRecord[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  return out;
}

function filterFinitePoints(points: PointRecord[]): PointRecord[] {
  let firstInvalidIdx = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      firstInvalidIdx = i;
      break;
    }
  }
  if (firstInvalidIdx < 0) return points;

  const filtered: PointRecord[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      filtered.push(p);
    }
  }
  return filtered;
}

function createPolicy(options: {
  maxPoints: number;
  mode: BackpressurePolicy["mode"];
  dynamicAlloc?: DynamicAllocOptions;
  spatialCulling: boolean;
  importanceField?: string;
  maxStalenessMs?: number;
}): BackpressurePolicy {
  return {
    maxPoints: options.maxPoints,
    mode: options.mode,
    dynamicAlloc: options.dynamicAlloc,
    spatialCulling: options.spatialCulling,
    // "auto" is resolved at runtime — start with no field so the buffer uses
    // uniform importance until the first chunk arrives.
    importanceField: options.importanceField === "auto" ? undefined : options.importanceField,
    maxStalenessMs: options.maxStalenessMs,
  };
}

const LEGACY_POLICY: ActivePolicy = {
  pointBudget: Infinity,
  updateCadenceMs: 167,
  expensivePassesEnabled: true,
  mode: "balanced",
  tier: "M",
};

function resolveConstraints(
  explicit: UserConstraints | undefined,
  hookDefaults: UserConstraints | undefined,
  streamedDefaults: UserConstraints | undefined,
  globalDefaults: UserConstraints | undefined,
): UserConstraints {
  return {
    pointBudgetCap: explicit?.pointBudgetCap
      ?? hookDefaults?.pointBudgetCap
      ?? streamedDefaults?.pointBudgetCap
      ?? globalDefaults?.pointBudgetCap,
    updateCadenceMinMs: explicit?.updateCadenceMinMs
      ?? hookDefaults?.updateCadenceMinMs
      ?? streamedDefaults?.updateCadenceMinMs
      ?? globalDefaults?.updateCadenceMinMs,
  };
}

export function usePointFlow(options: UsePointFlowOptions): UsePointFlowState {
  const hookConfig = options.config?.hooks?.usePointFlow;
  const streamedConfig = options.config?.streamed;
  const globalConfig = options.config?.global;
  const maxPoints = resolveConfigValue(
    50_000,
    options.maxPoints,
    hookConfig?.maxPoints,
    streamedConfig?.maxPoints,
    globalConfig?.maxPoints,
  );
  const lodLevels = resolveConfigValue(3, options.lodLevels, hookConfig?.lodLevels, streamedConfig?.lodLevels);
  const mode = resolveConfigValue<BackpressurePolicy["mode"]>("drop-oldest", options.mode, hookConfig?.mode, streamedConfig?.mode);
  const reactivePush = resolveConfigValue(true, options.reactivePush, hookConfig?.reactivePush, streamedConfig?.reactivePush);
  const workerMode = resolveConfigValue(false, options.workerMode, hookConfig?.workerMode, streamedConfig?.workerMode);
  const tier = options.tier ?? hookConfig?.tier ?? streamedConfig?.tier ?? globalConfig?.tier;
  const runtimeMode = options.runtimeMode ?? hookConfig?.runtimeMode ?? streamedConfig?.runtimeMode ?? globalConfig?.runtimeMode;
  const constraints = resolveConstraints(options.constraints, hookConfig?.constraints, streamedConfig?.constraints, globalConfig?.constraints);
  const legacyMode = resolveConfigValue(false, options.legacyMode, hookConfig?.legacyMode, streamedConfig?.legacyMode);
  const dynamicAlloc = options.dynamicAlloc ?? hookConfig?.dynamicAlloc ?? streamedConfig?.dynamicAlloc;
  const spatialCulling = resolveConfigValue(true, options.spatialCulling, hookConfig?.spatialCulling, streamedConfig?.spatialCulling);
  const workerCulling = resolveConfigValue(false, options.workerCulling, hookConfig?.workerCulling, streamedConfig?.workerCulling);
  const importanceField = options.importanceField ?? hookConfig?.importanceField ?? streamedConfig?.importanceField;
  const maxStalenessMs = options.maxStalenessMs ?? hookConfig?.maxStalenessMs ?? streamedConfig?.maxStalenessMs;
  const timeWindowMs = options.timeWindowMs ?? hookConfig?.timeWindowMs ?? streamedConfig?.timeWindowMs;
  const adaptiveIngest = resolveConfigValue(false, options.adaptiveIngest, hookConfig?.adaptiveIngest, streamedConfig?.adaptiveIngest, globalConfig?.adaptiveIngest);
  const autoTunePolicy = resolveConfigValue(false, options.autoTunePolicy, hookConfig?.autoTunePolicy, streamedConfig?.autoTunePolicy, globalConfig?.autoTunePolicy);

  const [pointsVersion, setPointsVersion] = useState(0);
  const [statsVersion,  setStatsVersion]  = useState(0);
  const [resetVersion,  setResetVersion]  = useState(0);
  const bufferRef = useRef<PointBuffer | null>(null);
  const policyRef = useRef(createPolicy({
    maxPoints,
    mode,
    dynamicAlloc,
    spatialCulling,
    importanceField,
    maxStalenessMs,
  }));
  const workerBridgeRef = useRef<WorkerBridge | null>(null);
  const nextRequestIdRef = useRef(0);
  const lastResetRequestIdRef = useRef(0);
  const resolvedTierRef = useRef<TierLevel>(tier ?? detectTierFromEnvironment());
  const autoImportanceResolvedRef = useRef(false);

  const resolvedTier = tier ?? resolvedTierRef.current;

  const [activePolicy, setActivePolicy] = useState<ActivePolicy>(() => {
    if (legacyMode) return LEGACY_POLICY;
    return computeActivePolicy(resolvedTier, runtimeMode ?? "balanced", constraints);
  });

  if (bufferRef.current === null) {
    bufferRef.current = new PointBuffer(policyRef.current!);
  }

  useEffect(() => {
    const next = createPolicy({
      maxPoints,
      mode,
      dynamicAlloc,
      spatialCulling,
      importanceField,
      maxStalenessMs,
    });
    const prev = policyRef.current;
    const sameDynamic =
      (prev.dynamicAlloc === undefined) === (next.dynamicAlloc === undefined) &&
      prev.dynamicAlloc?.initialCapacity === next.dynamicAlloc?.initialCapacity &&
      prev.dynamicAlloc?.growthFactor === next.dynamicAlloc?.growthFactor;
    const sameSpatial = (prev.spatialCulling !== false) === (next.spatialCulling !== false);
    const sameImportance =
      prev.importanceField === next.importanceField &&
      prev.maxStalenessMs === next.maxStalenessMs;
    if (prev.maxPoints === next.maxPoints && prev.mode === next.mode && sameDynamic && sameSpatial && sameImportance) {
      return;
    }
    policyRef.current = next;
    bufferRef.current = new PointBuffer(next);
    autoImportanceResolvedRef.current = false;
    setPointsVersion((v: number) => v + 1);
    setStatsVersion((v: number) => v + 1);
  }, [maxPoints, mode, dynamicAlloc?.initialCapacity, dynamicAlloc?.growthFactor, dynamicAlloc !== undefined, spatialCulling, importanceField, maxStalenessMs]);

  useEffect(() => {
    if (legacyMode) {
      setActivePolicy(LEGACY_POLICY);
      return;
    }
    const nextPolicy = computeActivePolicy(resolvedTier, runtimeMode ?? "balanced", constraints);
    setActivePolicy((prev) => (
      prev.pointBudget === nextPolicy.pointBudget &&
      prev.updateCadenceMs === nextPolicy.updateCadenceMs &&
      prev.expensivePassesEnabled === nextPolicy.expensivePassesEnabled &&
      prev.mode === nextPolicy.mode &&
      prev.tier === nextPolicy.tier
    ) ? prev : nextPolicy);
  }, [
    legacyMode,
    resolvedTier,
    runtimeMode,
    constraints.pointBudgetCap,
    constraints.updateCadenceMinMs,
  ]);

  useEffect(() => {
    if (!autoTunePolicy || legacyMode) return;
    const id = setInterval(() => {
      const basePolicy = computeActivePolicy(resolvedTier, runtimeMode ?? "balanced", constraints);
      const stats = bufferRef.current!.getStats();
      setActivePolicy((prev) => {
        let pointBudget = prev.pointBudget;
        let updateCadenceMs = prev.updateCadenceMs;
        if (stats.isUnderPressure) {
          const minBudget = Math.max(1, Math.floor(basePolicy.pointBudget * 0.5));
          const maxCadence = Math.max(basePolicy.updateCadenceMs + 120, Math.round(basePolicy.updateCadenceMs * 2));
          pointBudget = Math.max(minBudget, Math.floor(prev.pointBudget * 0.92));
          updateCadenceMs = Math.min(maxCadence, Math.round(prev.updateCadenceMs * 1.12));
        } else {
          pointBudget = Math.min(basePolicy.pointBudget, Math.round(prev.pointBudget * 1.03));
          updateCadenceMs = Math.max(basePolicy.updateCadenceMs, Math.round(prev.updateCadenceMs * 0.95));
        }
        if (pointBudget === prev.pointBudget && updateCadenceMs === prev.updateCadenceMs) {
          return prev;
        }
        return { ...prev, pointBudget, updateCadenceMs };
      });
    }, 1200);
    return () => clearInterval(id);
  }, [autoTunePolicy, legacyMode, resolvedTier, runtimeMode, constraints.pointBudgetCap, constraints.updateCadenceMinMs]);

  const resolveAutoImportance = (attributes: PackedAttributeChannel[] | undefined): void => {
    if (importanceField !== "auto" || autoImportanceResolvedRef.current) return;
    if (!attributes || attributes.length === 0) return;
    const key = attributes.find((ch) => ch.key === "intensity")?.key ?? attributes[0].key;
    bufferRef.current!.setImportanceField(key);
    autoImportanceResolvedRef.current = true;
  };

  useEffect(() => {
    if (!workerMode) {
      return;
    }
    let bridge: WorkerBridge | null = null;
    try {
      bridge = createWorkerBridge(
        (xyz, attributes, count, requestId, rangeHints) => {
          if (requestId < lastResetRequestIdRef.current) return;
          bufferRef.current!.ingestFromBinary(xyz, attributes as PackedAttributeChannel[] | undefined, count, rangeHints);
          resolveAutoImportance(attributes as PackedAttributeChannel[] | undefined);
          options.onRawIngest?.(xyz, attributes as PackedAttributeChannel[] | undefined, count);
          if (reactivePush) {
            setPointsVersion((v: number) => v + 1);
            setStatsVersion((v: number) => v + 1);
          }
        },
        nextRequestIdRef,
        workerCulling
      );
      workerBridgeRef.current = bridge;
    } catch {
      workerBridgeRef.current = null;
    }
    return () => {
      bridge?.terminate();
      workerBridgeRef.current = null;
    };
  }, [workerMode, reactivePush, workerCulling]);

  const points = useMemo(() => bufferRef.current!.snapshot(), [pointsVersion]);
  const lodBuckets = useMemo(() => buildLodBuckets(points, lodLevels), [points, lodLevels]);
  const stats = useMemo(() => bufferRef.current!.getStats(), [statsVersion]);

  const pushChunk = (chunk: PointChunk): void => {
    const currentCapacity = bufferRef.current!.currentCapacity();
    const currentStats = bufferRef.current!.getStats();
    const pressureRatio = currentCapacity > 0 ? currentStats.totalPoints / currentCapacity : 0;
    const adaptivePoints = adaptiveIngest
      ? applyAdaptiveIngest(chunk.points, pressureRatio)
      : chunk.points;
    const safePoints = filterFinitePoints(adaptivePoints);
    const effectiveChunk = safePoints === chunk.points ? chunk : { ...chunk, points: safePoints };
    options.onTelemetryEvent?.({
      phase: effectiveChunk.points.length === chunk.points.length ? "chunk_ingested" : "chunk_throttled",
      inputCount: chunk.points.length,
      outputCount: effectiveChunk.points.length,
      pressureRatio,
    });

    const bridge = workerBridgeRef.current;
    if (bridge !== null) {
      bridge.post(effectiveChunk);
    } else {
      bufferRef.current!.ingest(effectiveChunk.points);
      // Fire onRawIngest for non-worker mode so GPU ring gets incremental updates.
      if (effectiveChunk.points.length > 0) {
        const pts = effectiveChunk.points;
        const n   = pts.length;
        const xyz = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          xyz[i * 3]     = pts[i].x;
          xyz[i * 3 + 1] = pts[i].y;
          xyz[i * 3 + 2] = pts[i].z;
        }
        let attrs: PackedAttributeChannel[] | undefined;
        if (pts[0].attributes) {
          const keys = Object.keys(pts[0].attributes);
          if (keys.length > 0) {
            attrs = keys.map((k) => ({
              key: k,
              values:  new Float32Array(pts.map((p) => p.attributes?.[k] ?? 0)),
              present: new Uint8Array(pts.map((p) => (p.attributes?.[k] !== undefined ? 1 : 0))),
            }));
          }
        }
        resolveAutoImportance(attrs);
        options.onRawIngest?.(xyz, attrs, n);
      }
      if (reactivePush) {
        setPointsVersion((v: number) => v + 1);
        setStatsVersion((v: number) => v + 1);
      }
    }
  };

  const refresh = (): void => {
    setPointsVersion((v: number) => v + 1);
    setStatsVersion((v: number) => v + 1);
  };

  const refreshStats = (): void => {
    setStatsVersion((v: number) => v + 1);
  };

  const getSnapshot = (): PointRecord[] => {
    return bufferRef.current!.snapshot();
  };

  const workerCullingActive = workerCulling && workerBridgeRef.current !== null;

  const renderIntoBuffers = (
    positions: Float32Array,
    colors: Float32Array,
    lodStep: number,
    colorBy: string | undefined,
    isVisible?: (x: number, y: number, z: number) => boolean
  ): number => {
    const budget = activePolicy.pointBudget;
    // When worker-side culling is active, points in the buffer are already
    // pre-culled by the worker; skip the main-thread per-point isVisible pass.
    const effectiveIsVisible = workerCullingActive ? undefined : isVisible;
    let timeWindowCutoff: number | undefined;
    if (timeWindowMs && timeWindowMs > 0) {
      const nowRel = Date.now() - bufferRef.current!.epochMs;
      timeWindowCutoff = nowRel - timeWindowMs;
    }
    return bufferRef.current!.copyToTypedArrays(
      positions, colors, lodStep, colorBy,
      isFinite(budget) ? budget : undefined,
      effectiveIsVisible,
      spatialCulling,
      timeWindowCutoff
    );
  };

  const setWorkerFrustum = (planes: Float32Array): void => {
    workerBridgeRef.current?.setFrustum(planes);
  };

  const reset = (): void => {
    lastResetRequestIdRef.current = nextRequestIdRef.current;
    workerBridgeRef.current?.reset(lastResetRequestIdRef.current);
    bufferRef.current!.reset();
    setPointsVersion((v: number) => v + 1);
    setStatsVersion((v: number) => v + 1);
    setResetVersion((v: number) => v + 1);
  };

  const getBufferCapacity = (): number => bufferRef.current!.currentCapacity();

  return {
    points,
    lodBuckets,
    totalPoints: stats.totalPoints,
    droppedPoints: stats.droppedPoints,
    isUnderPressure: stats.isUnderPressure,
    pushChunk,
    reset,
    refresh,
    getSnapshot,
    refreshStats,
    renderIntoBuffers,
    activePolicy,
    getBufferCapacity,
    setWorkerFrustum,
    resetVersion,
    _bufferRef: bufferRef,
  };
}
