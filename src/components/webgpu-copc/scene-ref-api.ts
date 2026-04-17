import type { CopcGpuPipeline } from "../../copc/copc-gpu-pipeline";
import type { TileData } from "../../copc/copc-source";

export interface UploadMetricsTracker {
  totalUploadAttempts: number;
  totalUploadFailures: number;
  tierFailures: number[];
  nodeIdMissingFailures: number;
  allocOversizeFailures: number;
  allocAtlasFullFailures: number;
}

export function recordMissingNode(metrics: UploadMetricsTracker): void {
  metrics.totalUploadFailures++;
  metrics.nodeIdMissingFailures++;
}

export function recordAllocationFailure(
  metrics: UploadMetricsTracker,
  pointCount: number,
  maxPointsPerSlot: number,
  pipeline: CopcGpuPipeline
): void {
  metrics.totalUploadFailures++;
  if (pointCount > maxPointsPerSlot) {
    metrics.allocOversizeFailures++;
    return;
  }
  metrics.allocAtlasFullFailures++;
  for (let i = 0; i < pipeline.atlas.tiers.length; i++) {
    if (pointCount <= pipeline.atlas.tiers[i].pointsPerSlot) {
      if (i < metrics.tierFailures.length) metrics.tierFailures[i]++;
      break;
    }
  }
}

export function sampleAttributeRange(params: {
  colorBy: string | undefined;
  tile: TileData;
  attrStats: { min: number; max: number; samples: number };
}): void {
  const { colorBy, tile, attrStats } = params;
  if (!colorBy || colorBy === "rgb" || colorBy === "classification" || attrStats.samples >= 64) {
    return;
  }
  const attrChannel = tile.attributes.find((attribute) => attribute.key === colorBy) ?? tile.attributes[0];
  if (!attrChannel || attrChannel.values.length === 0) return;
  const sampleCount = Math.min(512, attrChannel.values.length);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < sampleCount; i++) {
    const value = attrChannel.values[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (Number.isFinite(min) && Number.isFinite(max)) {
    attrStats.min = Math.min(attrStats.min, min);
    attrStats.max = Math.max(attrStats.max, max);
    attrStats.samples++;
  }
}
