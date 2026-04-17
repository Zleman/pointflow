import type { StreamedPointCloudRef } from "pointflow";
import type { MutableRefObject } from "react";
import {
  isValidCompareIntervalMs,
  isValidComparePointsPerChunk,
} from "../compare-input";
import { makeMockChunk, resetMockSequence } from "../utils";

function devInvariant(condition: boolean, message: string): void {
  if (condition) return;
  if (import.meta.env.DEV) {
    throw new Error(message);
  }
}

export function startCompareLoop(params: {
  pointsPerChunk: number;
  intervalMs: number;
  compareIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  compareIngestCounterRef: MutableRefObject<number>;
  compareLeftApiRef: MutableRefObject<StreamedPointCloudRef | null>;
  compareRightApiRef: MutableRefObject<StreamedPointCloudRef | null>;
  setCompareStreaming: (value: boolean) => void;
}): void {
  const {
    pointsPerChunk,
    intervalMs,
    compareIntervalRef,
    compareIngestCounterRef,
    compareLeftApiRef,
    compareRightApiRef,
    setCompareStreaming,
  } = params;
  if (compareIntervalRef.current) return;
  const validPointsPerChunk = isValidComparePointsPerChunk(pointsPerChunk);
  const validIntervalMs = isValidCompareIntervalMs(intervalMs);
  devInvariant(validPointsPerChunk, `[CompareContext] startCompare received invalid pointsPerChunk: ${pointsPerChunk}`);
  devInvariant(validIntervalMs, `[CompareContext] startCompare received invalid intervalMs: ${intervalMs}`);
  if (!validPointsPerChunk || !validIntervalMs) return;

  resetMockSequence();
  compareLeftApiRef.current?.reset();
  compareRightApiRef.current?.reset();
  compareIngestCounterRef.current = 0;
  compareIntervalRef.current = setInterval(() => {
    const chunk = makeMockChunk(pointsPerChunk, "single");
    compareIngestCounterRef.current += chunk.points.length;
    compareLeftApiRef.current?.pushChunk(chunk);
    compareRightApiRef.current?.pushChunk(chunk);
  }, intervalMs);
  setCompareStreaming(true);
}

export function stopCompareLoop(params: {
  compareIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  setCompareStreaming: (value: boolean) => void;
}): void {
  const { compareIntervalRef, setCompareStreaming } = params;
  if (compareIntervalRef.current) {
    clearInterval(compareIntervalRef.current);
    compareIntervalRef.current = null;
  }
  setCompareStreaming(false);
}

export function restartCompareLoop(params: {
  compareStreaming: boolean;
  stopCompare: () => void;
  startCompare: () => void;
}): void {
  const { compareStreaming, stopCompare, startCompare } = params;
  if (!compareStreaming) return;
  stopCompare();
  setTimeout(() => startCompare(), 50);
}
