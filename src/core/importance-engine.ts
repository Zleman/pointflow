import type { DensityWeight } from "./types";

/**
 * Compute the composite importance score for a single ring slot.
 * Pure function — all state supplied by the caller (PointBuffer).
 *
 * Score = importanceValue × recencyDecay × densityAttenuation
 *
 * @param importanceValue  Raw importance value stored for the slot (default 1.0).
 * @param slotTimestampMs  Epoch-relative ingest timestamp for the slot (ms).
 * @param nowRelEpoch      Current time relative to the buffer epoch (ms).
 * @param recencyLambda    λ = ln(2) / maxStalenessMs, or 0 when decay is disabled.
 * @param densityWeight    How spatial density attenuates the score.
 * @param cellDensity      Number of points sharing the slot's spatial cell (≥ 1).
 */
export function importanceScore(
  importanceValue: number,
  slotTimestampMs: number,
  nowRelEpoch: number,
  recencyLambda: number,
  densityWeight: DensityWeight,
  cellDensity: number,
): number {
  let score = importanceValue;
  if (recencyLambda > 0) {
    const ageMs = Math.max(0, nowRelEpoch - slotTimestampMs);
    score *= Math.exp(-recencyLambda * ageMs);
  }
  if (densityWeight !== "none" && cellDensity > 1) {
    score *= densityWeight === "inverse" ? 1 / cellDensity : 1 / Math.sqrt(cellDensity);
  }
  return score;
}
