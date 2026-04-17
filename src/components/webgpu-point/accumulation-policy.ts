export function nextAccumulationState(params: {
  previousPosition: { x: number; y: number; z: number } | null;
  currentPosition: { x: number; y: number; z: number };
  deltaSec: number;
  nowMs: number;
  velocityEma: number;
  staticSinceMs: number | null;
  thresholdMs: number;
}): {
  velocityEma: number;
  staticSinceMs: number | null;
  shouldAccumulate: boolean;
} {
  const VELOCITY_EMA_ALPHA = 0.2;
  const STATIC_VELOCITY_THRESHOLD = 0.001;
  let velocityEma = params.velocityEma;

  if (params.previousPosition !== null) {
    const dx = params.currentPosition.x - params.previousPosition.x;
    const dy = params.currentPosition.y - params.previousPosition.y;
    const dz = params.currentPosition.z - params.previousPosition.z;
    const speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.max(params.deltaSec * 1000, 1);
    const alpha = Math.min(1, VELOCITY_EMA_ALPHA * params.deltaSec * 60);
    velocityEma = velocityEma * (1 - alpha) + speed * alpha;
  }

  const isStatic = velocityEma < STATIC_VELOCITY_THRESHOLD;
  const staticSinceMs = isStatic
    ? (params.staticSinceMs ?? params.nowMs)
    : null;
  const shouldAccumulate = isStatic
    && staticSinceMs !== null
    && (params.nowMs - staticSinceMs) >= params.thresholdMs;

  return { velocityEma, staticSinceMs, shouldAccumulate };
}
