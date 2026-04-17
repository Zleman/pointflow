import type { PointRecord } from "./types";

/**
 * Return every `step`-th point from `points` (step=1 → full detail, step=2 → half, etc.).
 * The first point is always included. Allocates a new array.
 */
export function sampleByStep(points: PointRecord[], step: number): PointRecord[] {
  if (step <= 1) {
    return [...points];
  }

  const out: PointRecord[] = [];
  for (let i = 0; i < points.length; i += step) {
    out.push(points[i]);
  }
  return out;
}

/**
 * Build `levels` LOD buckets from `points`, doubling the stride at each level.
 * Level 0 = full detail (stride 1), level 1 = half (stride 2), level N = stride 2^N.
 *
 * @throws If `levels` is less than 1.
 */
export function buildLodBuckets(points: PointRecord[], levels: number): PointRecord[][] {
  if (levels < 1) {
    throw new Error("levels must be >= 1");
  }

  const buckets: PointRecord[][] = [];
  for (let level = 0; level < levels; level++) {
    const step = 2 ** level;
    buckets.push(sampleByStep(points, step));
  }
  return buckets;
}
