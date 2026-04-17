export const COMPARE_POINTS_PER_CHUNK_MIN = 10;
export const COMPARE_POINTS_PER_CHUNK_MAX = 10_000;
export const COMPARE_INTERVAL_MS_MIN = 10;
export const COMPARE_INTERVAL_MS_MAX = 2_000;

export function isValidComparePointsPerChunk(value: number): boolean {
  return Number.isFinite(value)
    && Number.isInteger(value)
    && value >= COMPARE_POINTS_PER_CHUNK_MIN
    && value <= COMPARE_POINTS_PER_CHUNK_MAX;
}

export function isValidCompareIntervalMs(value: number): boolean {
  return Number.isFinite(value)
    && Number.isInteger(value)
    && value >= COMPARE_INTERVAL_MS_MIN
    && value <= COMPARE_INTERVAL_MS_MAX;
}

export function parseCompareBoundedInt(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (normalized < min || normalized > max) return null;
  return normalized;
}
