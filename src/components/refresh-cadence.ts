export function computeEffectiveRefreshIntervalMs(
  adaptiveRefresh: boolean,
  visualRefreshRateHz: number,
  policyCadenceMs: number,
  frameTimeMsEma: number,
): number {
  const baseIntervalMs = Math.max(1000 / Math.max(0.1, visualRefreshRateHz), policyCadenceMs);
  if (!adaptiveRefresh) return baseIntervalMs;
  return Math.min(200, Math.max(policyCadenceMs, frameTimeMsEma * 2));
}
