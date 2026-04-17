import { createContext, use, useReducer, type Dispatch, type ReactNode } from "react";
import type { BenchmarkProfileId, BenchmarkReport } from "../benchmark";
import type { MockStreamShape } from "../utils";

export interface BenchmarkState {
  streaming: boolean;
  benchmarkRunning: boolean;
  benchmarkProfileId: BenchmarkProfileId;
  customDurationSec: number;
  customMaxPoints: number;
  customPointsPerChunk: number;
  customIntervalMs: number;
  lastBenchmarkReport: BenchmarkReport | null;
  streamShape: MockStreamShape;
}

const initialState: BenchmarkState = {
  streaming: false,
  benchmarkRunning: false,
  benchmarkProfileId: "normal",
  customDurationSec: 30,
  customMaxPoints: 50_000,
  customPointsPerChunk: 500,
  customIntervalMs: 100,
  lastBenchmarkReport: null,
  streamShape: "lorenz",
};

export type BenchmarkAction =
  | { type: "SET_STREAMING"; value: boolean }
  | { type: "SET_BENCHMARK_RUNNING"; value: boolean }
  | { type: "SET_BENCHMARK_PROFILE_ID"; value: BenchmarkProfileId }
  | { type: "SET_CUSTOM_DURATION_SEC"; value: number }
  | { type: "SET_CUSTOM_MAX_POINTS"; value: number }
  | { type: "SET_CUSTOM_POINTS_PER_CHUNK"; value: number }
  | { type: "SET_CUSTOM_INTERVAL_MS"; value: number }
  | { type: "SET_LAST_BENCHMARK_REPORT"; value: BenchmarkReport | null }
  | { type: "SET_STREAM_SHAPE"; value: MockStreamShape };

function benchmarkReducer(state: BenchmarkState, action: BenchmarkAction): BenchmarkState {
  switch (action.type) {
    case "SET_STREAMING":
      return { ...state, streaming: action.value };
    case "SET_BENCHMARK_RUNNING":
      return { ...state, benchmarkRunning: action.value };
    case "SET_BENCHMARK_PROFILE_ID":
      return { ...state, benchmarkProfileId: action.value };
    case "SET_CUSTOM_DURATION_SEC":
      return { ...state, customDurationSec: action.value };
    case "SET_CUSTOM_MAX_POINTS":
      return { ...state, customMaxPoints: action.value };
    case "SET_CUSTOM_POINTS_PER_CHUNK":
      return { ...state, customPointsPerChunk: action.value };
    case "SET_CUSTOM_INTERVAL_MS":
      return { ...state, customIntervalMs: action.value };
    case "SET_LAST_BENCHMARK_REPORT":
      return { ...state, lastBenchmarkReport: action.value };
    case "SET_STREAM_SHAPE":
      return { ...state, streamShape: action.value };
  }
}

const BenchmarkStateContext    = createContext<BenchmarkState | null>(null);
const BenchmarkDispatchContext = createContext<Dispatch<BenchmarkAction> | null>(null);

export function BenchmarkProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(benchmarkReducer, initialState);
  return (
    <BenchmarkStateContext value={state}>
      <BenchmarkDispatchContext value={dispatch}>
        {children}
      </BenchmarkDispatchContext>
    </BenchmarkStateContext>
  );
}

export function useBenchmarkState(): BenchmarkState {
  const ctx = use(BenchmarkStateContext);
  if (!ctx) throw new Error("useBenchmarkState must be used within BenchmarkProvider");
  return ctx;
}

export function useBenchmarkDispatch(): Dispatch<BenchmarkAction> {
  const ctx = use(BenchmarkDispatchContext);
  if (!ctx) throw new Error("useBenchmarkDispatch must be used within BenchmarkProvider");
  return ctx;
}
