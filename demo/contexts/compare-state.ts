import {
  isValidCompareIntervalMs,
  isValidComparePointsPerChunk,
} from "../compare-input";

function devInvariant(condition: boolean, message: string): void {
  if (condition) return;
  if (import.meta.env.DEV) {
    throw new Error(message);
  }
}

export interface CompareState {
  compareStreaming: boolean;
  compareLeftReady: boolean;
  compareRightReady: boolean;
  compareColorBy: string;
  compareMaxPoints: number;
  compareImportanceField: string;
  compareMaxStalenessMs: number;
  compareImportanceSamplingEnabled: boolean;
  comparePointsPerChunk: number;
  compareIntervalMs: number;
}

export const initialState: CompareState = {
  compareStreaming: false,
  compareLeftReady: false,
  compareRightReady: false,
  compareColorBy: "velocity",
  compareMaxPoints: 50_000,
  compareImportanceField: "velocity",
  compareMaxStalenessMs: 5_000,
  compareImportanceSamplingEnabled: true,
  comparePointsPerChunk: 500,
  compareIntervalMs: 100,
};

export type CompareAction =
  | { type: "SET_COMPARE_STREAMING"; value: boolean }
  | { type: "SET_COMPARE_LEFT_READY"; value: boolean }
  | { type: "SET_COMPARE_RIGHT_READY"; value: boolean }
  | { type: "SET_COMPARE_COLOR_BY"; value: string }
  | { type: "SET_COMPARE_MAX_POINTS"; value: number }
  | { type: "SET_COMPARE_IMPORTANCE_FIELD"; value: string }
  | { type: "SET_COMPARE_MAX_STALENESS_MS"; value: number }
  | { type: "SET_COMPARE_IMPORTANCE_SAMPLING"; value: boolean }
  | { type: "SET_COMPARE_POINTS_PER_CHUNK"; value: number }
  | { type: "SET_COMPARE_INTERVAL_MS"; value: number };

export function compareReducer(state: CompareState, action: CompareAction): CompareState {
  switch (action.type) {
    case "SET_COMPARE_STREAMING":       return { ...state, compareStreaming: action.value };
    case "SET_COMPARE_LEFT_READY":      return { ...state, compareLeftReady: action.value };
    case "SET_COMPARE_RIGHT_READY":     return { ...state, compareRightReady: action.value };
    case "SET_COMPARE_COLOR_BY":        return { ...state, compareColorBy: action.value };
    case "SET_COMPARE_MAX_POINTS":      return { ...state, compareMaxPoints: action.value };
    case "SET_COMPARE_IMPORTANCE_FIELD":    return { ...state, compareImportanceField: action.value };
    case "SET_COMPARE_MAX_STALENESS_MS":    return { ...state, compareMaxStalenessMs: action.value };
    case "SET_COMPARE_IMPORTANCE_SAMPLING": return { ...state, compareImportanceSamplingEnabled: action.value };
    case "SET_COMPARE_POINTS_PER_CHUNK":
      if (!isValidComparePointsPerChunk(action.value)) {
        devInvariant(false, `[CompareContext] Invalid comparePointsPerChunk: ${action.value}`);
        return state;
      }
      return { ...state, comparePointsPerChunk: action.value };
    case "SET_COMPARE_INTERVAL_MS":
      if (!isValidCompareIntervalMs(action.value)) {
        devInvariant(false, `[CompareContext] Invalid compareIntervalMs: ${action.value}`);
        return state;
      }
      return { ...state, compareIntervalMs: action.value };
  }
}
