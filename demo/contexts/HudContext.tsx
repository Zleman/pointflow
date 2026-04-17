import { createContext, use, useCallback, useReducer, type Dispatch, type ReactNode } from "react";

export interface HudState {
  renderedPoints: number;
  effectiveLodLevel: number;
  cameraDistance: number;
  fps: number;
  frameTimeMs: number;
  rollingP95Ms: number;
  hitches50: number;
  hitches100: number;
  heapMb: number | null;
  stats: { totalPoints: number; droppedPoints: number; isUnderPressure: boolean };
  ingestRate: number;
  runDurationSec: number;
  oldestRetainedAgeMs: number;
  temporalStats: {
    oldestPointAgeMs: number;
    newestPointAgeMs: number;
    windowedCount: number;
    totalCount: number;
  } | null;
}

const initialState: HudState = {
  renderedPoints: 0,
  effectiveLodLevel: 0,
  cameraDistance: 0,
  fps: 0,
  frameTimeMs: 0,
  rollingP95Ms: 0,
  hitches50: 0,
  hitches100: 0,
  heapMb: null,
  stats: { totalPoints: 0, droppedPoints: 0, isUnderPressure: false },
  ingestRate: 0,
  runDurationSec: 0,
  oldestRetainedAgeMs: 0,
  temporalStats: null,
};

export type HudAction =
  | {
      type: "FLUSH_RENDER_METRICS";
      renderedPoints: number;
      effectiveLodLevel: number;
      cameraDistance: number;
      fps: number;
      frameTimeMs: number;
      /** Omit to preserve the current rollingP95Ms (e.g. during warmup frames). */
      rollingP95Ms?: number;
      hitches50Bump: boolean;
      hitches100Bump: boolean;
      oldestRetainedAgeMs: number;
    }
  | { type: "RESET_HITCHES" }
  | { type: "SET_HEAP_MB"; value: number }
  | { type: "SET_INGEST_RATE"; value: number }
  | { type: "SET_RUN_DURATION_SEC"; value: number }
  | { type: "SET_STATS"; stats: { totalPoints: number; droppedPoints: number; isUnderPressure: boolean } }
  | {
      type: "SET_TEMPORAL_STATS";
      stats: { oldestPointAgeMs: number; newestPointAgeMs: number; windowedCount: number; totalCount: number } | null;
    };

function hudReducer(state: HudState, action: HudAction): HudState {
  switch (action.type) {
    case "FLUSH_RENDER_METRICS":
      return {
        ...state,
        renderedPoints:    action.renderedPoints,
        effectiveLodLevel: action.effectiveLodLevel,
        cameraDistance:    action.cameraDistance,
        fps:               action.fps,
        frameTimeMs:       action.frameTimeMs,
        rollingP95Ms:      action.rollingP95Ms !== undefined ? action.rollingP95Ms : state.rollingP95Ms,
        hitches50:         action.hitches50Bump  ? state.hitches50  + 1 : state.hitches50,
        hitches100:        action.hitches100Bump ? state.hitches100 + 1 : state.hitches100,
        oldestRetainedAgeMs: action.oldestRetainedAgeMs,
      };
    case "RESET_HITCHES":
      return { ...state, hitches50: 0, hitches100: 0 };
    case "SET_HEAP_MB":
      return { ...state, heapMb: action.value };
    case "SET_INGEST_RATE":
      return { ...state, ingestRate: action.value };
    case "SET_RUN_DURATION_SEC":
      return { ...state, runDurationSec: action.value };
    case "SET_STATS":
      return { ...state, stats: action.stats };
    case "SET_TEMPORAL_STATS":
      return { ...state, temporalStats: action.stats };
  }
}

const HudStateContext    = createContext<HudState | null>(null);
const HudDispatchContext = createContext<Dispatch<HudAction> | null>(null);

export function HudProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(hudReducer, initialState);
  return (
    <HudStateContext value={state}>
      <HudDispatchContext value={dispatch}>
        {children}
      </HudDispatchContext>
    </HudStateContext>
  );
}

export function useHudState(): HudState {
  const ctx = use(HudStateContext);
  if (!ctx) throw new Error("useHudState must be used within HudProvider");
  return ctx;
}

export function useHudDispatch(): Dispatch<HudAction> {
  const ctx = use(HudDispatchContext);
  if (!ctx) throw new Error("useHudDispatch must be used within HudProvider");
  return ctx;
}

/** Full HUD domain hook - state + computed values + stable dispatch. */
export function useHudMetrics() {
  const state = useHudState();
  const hudDispatch = useHudDispatch();

  const ingestedPoints = state.stats.totalPoints + state.stats.droppedPoints;
  const droppedRatio   = ingestedPoints > 0 ? (state.stats.droppedPoints / ingestedPoints) * 100 : 0;

  const setStats = useCallback(
    (s: { totalPoints: number; droppedPoints: number; isUnderPressure: boolean }) =>
      hudDispatch({ type: "SET_STATS", stats: s }),
    [hudDispatch]
  );

  return { ...state, ingestedPoints, droppedRatio, hudDispatch, setStats };
}
