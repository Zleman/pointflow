import type React from "react";

export function computeTileProgress(phaseIndex: number, fetched: number, total: number): number {
  if (total <= 0) return phaseIndex;
  return phaseIndex + (fetched / total) * (1 - phaseIndex);
}

export function updateLoadStats(
  loadStatsRef: React.MutableRefObject<{ tilesFetched: number; tilesTotal: number; progress: number }>,
  tileCountRef: React.MutableRefObject<number>,
  totalTilesRef: React.MutableRefObject<number>,
  progress: number,
): void {
  loadStatsRef.current = {
    tilesFetched: tileCountRef.current,
    tilesTotal: totalTilesRef.current,
    progress,
  };
}
