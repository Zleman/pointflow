import type { RunAggregate } from "./run-lifecycle";

export function buildSoakReportText(params: {
  agg: RunAggregate;
  ingestConfig: { pointsPerChunk: number; intervalMs: number };
  attributeProfileLabel: string;
  attrKeysHuman: string;
  colorByHuman: string;
  importanceHuman: string;
  kLookaheadLine: string;
  requestedBackendLabel: string;
  resolvedBackendLabel: string;
  fallbackActive: boolean;
  ingestModeLabel: string;
  streamShapeLabel: string;
  maxPoints: number;
  frustumCulling: boolean;
  autoLod: boolean;
  effectiveLodLevel: number;
  manualLodLevel: number;
  runDurationSec: number;
  stats: { totalPoints: number; droppedPoints: number; isUnderPressure: boolean };
  droppedRatio: number;
  renderedPoints: number;
  cameraDistance: number;
  fps: number;
  frameTimeMs: number;
  heapMb: number | null;
  importanceSamplingEnabled: boolean;
  maxStalenessMs: number;
  oldestRetainedAgeMs: number;
}): string {
  const {
    agg,
    ingestConfig,
    attributeProfileLabel,
    attrKeysHuman,
    colorByHuman,
    importanceHuman,
    kLookaheadLine,
    requestedBackendLabel,
    resolvedBackendLabel,
    fallbackActive,
    ingestModeLabel,
    streamShapeLabel,
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
  } = params;
  const avgFrameMs = agg.samples > 0 ? agg.frameTimeSumMs / agg.samples : 0;
  const minFpsStr = Number.isFinite(agg.minFps) ? agg.minFps.toFixed(1) : "N/A";
  const targetPtsPerSec = Math.round((1000 * ingestConfig.pointsPerChunk) / ingestConfig.intervalMs);
  return [
    "PointFlow Demo Soak Report",
    `Renderer: requested ${requestedBackendLabel} | active ${resolvedBackendLabel}${fallbackActive ? " | fallback active" : ""}`,
    `Ingest mode: ${ingestModeLabel} | attributes: ${attributeProfileLabel} (${attrKeysHuman}) | Color by ${colorByHuman}`,
    `Shape: ${streamShapeLabel}`,
    `Ingest: ${ingestConfig.pointsPerChunk} pts/chunk, ${ingestConfig.intervalMs} ms interval (~${targetPtsPerSec.toLocaleString()} pts/s target) | Max buffer: ${maxPoints.toLocaleString()}`,
    `Frustum culling: ${frustumCulling ? "ON" : "OFF"}`,
    `LOD: ${autoLod ? `Auto (${effectiveLodLevel})` : `Manual (${manualLodLevel})`}`,
    `Duration: ${runDurationSec}s | Ingest peak: ${agg.peakIngestRate} pts/s`,
    `Buffer: ${stats.totalPoints} kept | ${stats.droppedPoints} dropped (${droppedRatio.toFixed(2)}%) | pressure: ${stats.isUnderPressure ? "Yes" : "No"}`,
    `Render: ${renderedPoints} pts (peak ${agg.peakRenderedPoints}) | LOD ${effectiveLodLevel} | camera ${Number.isFinite(cameraDistance) ? cameraDistance.toFixed(1) : "?"}`,
    `FPS: ${fps.toFixed(1)} (min ${minFpsStr} max ${agg.maxFps.toFixed(1)})`,
    `Frame ms: ${frameTimeMs.toFixed(2)} current | ${avgFrameMs.toFixed(2)} avg | ${agg.rollingP95Ms.toFixed(2)} rolling p95`,
    `Hitches: >50ms ${agg.hitches50} | >100ms ${agg.hitches100}`,
    `Heap: ${heapMb === null ? "N/A" : `${heapMb.toFixed(1)} MB`} current | ${agg.maxHeapMb > 0 ? `${agg.maxHeapMb.toFixed(1)} MB` : "N/A"} max`,
    `Importance: field=${importanceHuman} | staleness=${maxStalenessMs > 0 ? `${(maxStalenessMs / 1000).toFixed(1)}s half-life` : "Off"} | GPU sampling=${importanceSamplingEnabled ? "On" : "Off"} | K-lookahead=${kLookaheadLine}`,
    ...(maxStalenessMs > 0 || importanceHuman !== ""
      ? [`Oldest retained point: ${oldestRetainedAgeMs < 1000 ? `${oldestRetainedAgeMs}ms` : `${(oldestRetainedAgeMs / 1000).toFixed(1)}s`}`]
      : []),
  ].join("\n");
}
