export interface PointRecord {
  x: number;
  y: number;
  z: number;
  attributes?: Record<string, number>;
  timestamp?: number;
}

export interface PointChunk {
  points: PointRecord[];
  sourceId?: string;
  receivedAt?: number;
}

export interface PackedAttributeChannel {
  key: string;
  values: Float32Array;
  present: Uint8Array;
}

export interface DynamicAllocOptions {
  /**
   * Initial buffer capacity. Must be >= 1 and <= maxPoints.
   * Defaults to min(1024, maxPoints).
   */
  initialCapacity?: number;
  /**
   * Multiplicative growth factor applied when the buffer is full and below
   * the maximum. Must be > 1. Defaults to 2 (double each time).
   */
  growthFactor?: number;
}

export interface BackpressurePolicy {
  maxPoints: number;
  mode: "drop-oldest" | "drop-newest";
  /**
   * When set, enables dynamic buffer allocation. Buffers start at
   * `initialCapacity` and grow toward `maxPoints` as points are ingested.
   * When omitted (default), all buffers are pre-allocated to `maxPoints`
   * upfront (original behavior).
   */
  dynamicAlloc?: DynamicAllocOptions;
  /**
   * Internal/test-only opt-out for deferred growth.
   * When false, _grow() is called synchronously inside ingest()/ingestFromBinary()
  * Default: true (growth is deferred off the ingest hot path).
   * Only relevant when dynamicAlloc is set.
   */
  deferGrowth?: boolean;
  /**
   * When true (default), a persistent spatial index is maintained on ingest so that
   * copyToTypedArrays can iterate only points in visible cells. When false, no
   * index is maintained and the legacy per-point path is used.
   */
  spatialCulling?: boolean;
  /**
  * Attribute key to use as the importance signal for K-lookahead eviction
   * and GPU stochastic sampling. When omitted, all points have equal importance (1.0).
   */
  importanceField?: string;
  /**
  * Half-life (ms) for recency decay. A point this many ms old has half the
   * recency weight of a freshly ingested point. When omitted (0 or undefined), no
   * recency decay is applied (recency = 1.0 for all points).
   */
  maxStalenessMs?: number;
  /**
   * Density weighting mode for the importance score.
   * Requires spatialCulling to be enabled (forced on automatically when set).
   */
  densityWeight?: DensityWeight;
  /**
   * Maps integer classification values (e.g. LAS classification codes) to
   * importance scalars. Overrides importanceField for matched points.
   * Unrecognised classifications default to 1.0.
   * Example: { 2: 0.1, 6: 0.8 }  // ground=0.1, building=0.8
   */
  classificationWeights?: Record<number, number>;
  /**
   * Which attribute key holds the integer classification value.
   * Defaults to "classification" when classificationWeights is set.
   */
  classificationField?: string;
}

/**
 * How spatial cell density attenuates a point's importance score.
 * "none" — no density term (default).
 * "inverse" — score × (1 / cellDensity); rare points are preserved more aggressively.
 * "sqrt_inverse" — score × (1 / √cellDensity); softer variant.
 */
export type DensityWeight = "none" | "inverse" | "sqrt_inverse";

export interface BufferStats {
  totalPoints: number;
  droppedPoints: number;
  isUnderPressure: boolean;
}

/**
 * Per-frame temporal statistics delivered via `onTemporalStats`.
 * All ages are in milliseconds relative to the current frame time.
 */
export interface TemporalStats {
  /** Age of the oldest currently buffered point in ms. 0 if buffer is empty. */
  oldestPointAgeMs: number;
  /** Age of the newest currently buffered point in ms. ~0 for live feeds. */
  newestPointAgeMs: number;
  /**
   * Number of points within the active `timeWindowMs`.
   * Equal to `totalCount` when no time window is set.
   */
  windowedCount: number;
  /** Total number of points currently in the ring buffer. */
  totalCount: number;
}

/** Per-frame render metrics delivered via `onRenderMetrics`. */
export interface StreamedPointCloudRenderMetrics {
  renderedPoints: number;
  effectiveLodLevel: number;
  cameraDistance: number;
  frameTimeMs: number;
  fps: number;
  /** GPU compute pass duration in ms. Only populated when timestamp-query is supported. */
  gpuComputeMs?: number;
  /** GPU render pass duration in ms. Only populated when timestamp-query is supported. */
  gpuRenderMs?: number;
}

/** Octree coverage stats derived from the loaded COPC index (child keys in `nodes`). */
export interface CopcHierarchyCompleteness {
  totalNodes: number;
  nodesWithChildren: number;
  nodesWithoutChildren: number;
  /** Data nodes with point count above max atlas slot and no child entries in the index. */
  nodesOversizeNoChildren: number;
  /** `nodesWithChildren / totalNodes` */
  completenessRatio: number;
  maxDepthFound: number;
  nodesByDepth: Record<number, number>;
}

/**
 * COPC index–level metadata for file-view reports (stable for the lifetime of
 * the loaded index). Bounding box is derived from `CopcInfo.center` ± `halfsize`
 * (COPC root cube).
 */
export interface CopcFileStaticMeta {
  sourceLabel: string | null;
  sourceSrc: string;
  indexNodeCount: number;
  maxTreeDepth: number;
  /** Sum of `pointCount` across leaf/data nodes; may be capped for JS number safety. */
  declaredTotalPoints: number;
  /** True when the true total exceeded `Number.MAX_SAFE_INTEGER`. */
  declaredTotalPointsCapped: boolean;
  copcSpacing: number;
  copcHalfsize: number;
  center: [number, number, number];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  bboxHalfDiagonalM: number;
  bboxCubeSpaceDiagonalM: number;
  gpsMin: number;
  gpsMax: number;
  lasPointFormat: number;
  lasPointRecLen: number;
  lasAttributeKeys: string[];
  maxCacheMb: number;
  maxConcurrent: number;
  persistCache: boolean;
  maxDepthUser: number;
  hierarchyCompleteness?: CopcHierarchyCompleteness;
}

/** Per-frame file / camera / view metrics for COPC static viewing. */
export interface CopcFileFrameMetrics {
  cameraToCenterM: number;
  orbitToCameraM: number;
  cameraToBboxClosestM: number;
  cameraToBboxFarthestM: number;
  cameraInsideDatasetBbox: boolean;
  /** `cameraToCenterM - cameraToBboxClosestM` (negative if closer to hull than to center). */
  centerDistanceMinusClosestM: number;
  /** `orbitToCameraM - cameraToBboxClosestM` (orbit radius vs distance to dataset hull). */
  orbitDistanceMinusClosestM: number;
  frustumIntersectsBbox: boolean;
  /**
   * Crude “full bbox width as if at orbit distance” — misleading when the camera is inside the bbox.
   * NaN in that case; use `cameraHorizontalFovDeg` and the report note instead.
   */
  bboxAngularWidthHorizDeg: number;
  /** Perspective camera horizontal field of view (viewport aspect), degrees. */
  cameraHorizontalFovDeg: number;
  pixelsPerMeterAtOrbitTarget: number;
  viewportCssWidth: number;
  viewportCssHeight: number;
  cameraFovDeg: number;
  cameraNear: number;
  cameraFar: number;
  lodThreshold: number;
  frustumCulling: boolean;
  basePointSize: number;
  colorBy: string;
  renderedPoints: number;
  effectiveLodLevel: number;
  fps: number;
  frameTimeMs: number;
  tilesFetched: number;
  tilesTotal: number;
  loadProgress: number;
  requestedBackend: string;
  activeBackend: string;
}

/** Full snapshot for clipboard reports and HUD polling (COPC file mode). */
export interface CopcFileViewSnapshot {
  capturedAtIso: string;
  static: CopcFileStaticMeta;
  frame: CopcFileFrameMetrics;
}

export type ColorPalette = "blue-red" | "grayscale";

/** Preferred renderer backend. "auto" → WebGPU when supported, else WebGL. */
export type RendererBackend = "webgl" | "webgpu" | "auto";
export type AttributePackingMode = "float32" | "unorm16";
/**
 * GPU power preference hint passed to the WebGPU adapter request.
 * "high-performance" asks the browser to prefer the discrete GPU on
 * multi-GPU systems. "low-power" prefers the integrated GPU.
 * The browser may ignore the hint; for a hard guarantee use OS-level
 * GPU assignment (Windows Graphics Settings or NVIDIA/AMD control panel).
 * Default: "high-performance".
 */
export type GPUPowerPreference = "default" | "high-performance" | "low-power";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Data returned by the `onPointPick` callback.
 *
 * Coordinates are in the same world space as the ingested points.
 * `slotIndex` is the internal ring-buffer slot — stable until the next eviction.
 * `screenDist` is the distance from the click to the projected point center, in
 * CSS pixels — useful for visualising the pick radius.
 */
export interface PickedPoint {
  x: number;
  y: number;
  z: number;
  attributes: Record<string, number>;
  slotIndex: number;
  /** Distance from click position to projected point center in CSS pixels. */
  screenDist: number;
  /** 0-1 confidence derived from pick radius proximity. */
  confidence?: number;
}

export type PickStrategy = "highestImportance" | "nearest" | "recentFirst";

export interface PointCloudLoadTelemetryEvent {
  phase: "start" | "header" | "chunk" | "done" | "error" | "abort";
  sourceKind: "url" | "request" | "file" | "blob";
  progress?: number;
  chunkCount?: number;
  message?: string;
}
