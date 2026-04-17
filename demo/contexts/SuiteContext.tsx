import { createContext, use, useReducer, type Dispatch, type ReactNode } from "react";
import type { SuiteReport } from "../test-suite";

export interface SuiteState {
  suiteRunning: boolean;
  suiteCurrentIdx: number;
  suiteTotalProfiles: number;
  suiteCurrentProfileId: string | null;
  suiteWaitingManual: boolean;
  suiteManualCountdownSec: number | null;
  lastSuiteReport: SuiteReport | null;
}

const initialState: SuiteState = {
  suiteRunning: false,
  suiteCurrentIdx: 0,
  suiteTotalProfiles: 0,
  suiteCurrentProfileId: null,
  suiteWaitingManual: false,
  suiteManualCountdownSec: null,
  lastSuiteReport: null,
};

export type SuiteAction =
  | { type: "SET_SUITE_RUNNING"; value: boolean }
  | { type: "SET_SUITE_CURRENT_IDX"; value: number }
  | { type: "INCREMENT_SUITE_IDX" }
  | { type: "SET_SUITE_TOTAL_PROFILES"; value: number }
  | { type: "SET_SUITE_CURRENT_PROFILE_ID"; value: string | null }
  | { type: "SET_SUITE_WAITING_MANUAL"; value: boolean }
  | { type: "SET_SUITE_MANUAL_COUNTDOWN_SEC"; value: number | null }
  | { type: "SET_LAST_SUITE_REPORT"; value: SuiteReport | null }
  | { type: "RESET_SUITE" };

function suiteReducer(state: SuiteState, action: SuiteAction): SuiteState {
  switch (action.type) {
    case "SET_SUITE_RUNNING":
      return { ...state, suiteRunning: action.value };
    case "SET_SUITE_CURRENT_IDX":
      return { ...state, suiteCurrentIdx: action.value };
    case "INCREMENT_SUITE_IDX":
      return { ...state, suiteCurrentIdx: state.suiteCurrentIdx + 1 };
    case "SET_SUITE_TOTAL_PROFILES":
      return { ...state, suiteTotalProfiles: action.value };
    case "SET_SUITE_CURRENT_PROFILE_ID":
      return { ...state, suiteCurrentProfileId: action.value };
    case "SET_SUITE_WAITING_MANUAL":
      return { ...state, suiteWaitingManual: action.value };
    case "SET_SUITE_MANUAL_COUNTDOWN_SEC":
      return { ...state, suiteManualCountdownSec: action.value };
    case "SET_LAST_SUITE_REPORT":
      return { ...state, lastSuiteReport: action.value };
    case "RESET_SUITE":
      // keep lastSuiteReport so the user can still read it after a run
      return { ...initialState, lastSuiteReport: state.lastSuiteReport };
  }
}

const SuiteStateContext    = createContext<SuiteState | null>(null);
const SuiteDispatchContext = createContext<Dispatch<SuiteAction> | null>(null);

export function SuiteProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(suiteReducer, initialState);
  return (
    <SuiteStateContext value={state}>
      <SuiteDispatchContext value={dispatch}>
        {children}
      </SuiteDispatchContext>
    </SuiteStateContext>
  );
}

export function useSuiteState(): SuiteState {
  const ctx = use(SuiteStateContext);
  if (!ctx) throw new Error("useSuiteState must be used within SuiteProvider");
  return ctx;
}

export function useSuiteDispatch(): Dispatch<SuiteAction> {
  const ctx = use(SuiteDispatchContext);
  if (!ctx) throw new Error("useSuiteDispatch must be used within SuiteProvider");
  return ctx;
}
