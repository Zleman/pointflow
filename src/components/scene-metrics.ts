import type React from "react";
import type { StreamedPointCloudRenderMetrics } from "../core/types";

export const STATS_REFRESH_MIN_MS = 800;
export const TEMPORAL_STATS_UI_MIN_MS = 250;
export const RENDER_METRICS_EMIT_MIN_MS = 200;

export function shouldRunThrottled(now: number, lastAt: number, minMs: number): boolean {
  return now - lastAt >= minMs;
}

export function writeRenderMetrics(params: {
  metrics: StreamedPointCloudRenderMetrics;
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  onRenderMetrics?: (metrics: StreamedPointCloudRenderMetrics) => void;
  now: number;
  lastEmitAt: number;
}): number {
  const { metrics, renderMetricsRef, onRenderMetrics, now, lastEmitAt } = params;
  if (renderMetricsRef) {
    renderMetricsRef.current = metrics;
    return lastEmitAt;
  }
  if (onRenderMetrics && shouldRunThrottled(now, lastEmitAt, RENDER_METRICS_EMIT_MIN_MS)) {
    onRenderMetrics(metrics);
    return now;
  }
  return lastEmitAt;
}
