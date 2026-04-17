import { BENCHMARK_PROFILES, type BenchmarkProfileId } from "../../benchmark";

export function applyBenchmarkProfileSelection({
  id,
  setBenchmarkProfileIdRaw,
  setCustomPointsPerChunk,
  setCustomIntervalMs,
  setCustomMaxPoints,
}: {
  id: BenchmarkProfileId;
  setBenchmarkProfileIdRaw: (value: BenchmarkProfileId) => void;
  setCustomPointsPerChunk: (value: number) => void;
  setCustomIntervalMs: (value: number) => void;
  setCustomMaxPoints: (value: number) => void;
}): void {
  setBenchmarkProfileIdRaw(id);
  if (id === "custom") return;
  const profile = BENCHMARK_PROFILES[id as Exclude<BenchmarkProfileId, "custom">];
  setCustomPointsPerChunk(profile.pointsPerChunk);
  setCustomIntervalMs(profile.intervalMs);
  setCustomMaxPoints(profile.maxPoints);
}
