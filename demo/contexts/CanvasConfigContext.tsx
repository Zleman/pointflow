import { createContext, use, useReducer, type Dispatch, type ReactNode } from "react";
import { resolveRenderer } from "pointflow";
import type { RendererBackend, RuntimeMode } from "pointflow";
import type { AttributeProfile } from "../constants";

export interface CanvasConfigState {
  demoMode: "stream" | "file" | "compare";
  maxPoints: number;
  colorBy: string;
  requestedBackend: RendererBackend;
  activeBackend: "webgl" | "webgpu";
  frustumCulling: boolean;
  autoLod: boolean;
  manualLodLevel: number;
  workerMode: boolean;
  adaptiveRefresh: boolean;
  workerCulling: boolean;
  attributeProfile: AttributeProfile;
  runtimeMode: RuntimeMode;
  importanceField: string;
  maxStalenessMs: number;
  importanceSamplingEnabled: boolean;
  useDynamicAlloc: boolean;
  timeWindowMs: number;
  /** True once StreamedPointCloud's onReady has fired for the current buffer size. */
  apiReady: boolean;
  canvasBg: string;
}

const initialState: CanvasConfigState = {
  demoMode: "stream",
  maxPoints: 50_000,
  colorBy: "velocity",
  requestedBackend: "auto",
  activeBackend: resolveRenderer(undefined),
  frustumCulling: true,
  autoLod: true,
  manualLodLevel: 0,
  workerMode: true,
  adaptiveRefresh: false,
  workerCulling: false,
  attributeProfile: "quad",
  runtimeMode: "balanced",
  importanceField: "",
  maxStalenessMs: 0,
  importanceSamplingEnabled: false,
  useDynamicAlloc: false,
  timeWindowMs: 0,
  apiReady: false,
  canvasBg: "#0d1117",
};

export type CanvasConfigAction =
  | { type: "SET_DEMO_MODE"; mode: "stream" | "file" | "compare" }
  | { type: "SET_MAX_POINTS"; value: number }
  | { type: "SET_COLOR_BY"; value: string }
  | { type: "SET_REQUESTED_BACKEND"; value: RendererBackend }
  | { type: "SET_ACTIVE_BACKEND"; value: "webgl" | "webgpu" }
  | { type: "SET_FRUSTUM_CULLING"; value: boolean }
  | { type: "SET_AUTO_LOD"; value: boolean }
  | { type: "SET_MANUAL_LOD_LEVEL"; value: number }
  | { type: "SET_WORKER_MODE"; value: boolean }
  | { type: "SET_ADAPTIVE_REFRESH"; value: boolean }
  | { type: "SET_WORKER_CULLING"; value: boolean }
  /** Also resets colorBy/importanceField if the new profile doesn't include them. */
  | { type: "SET_ATTRIBUTE_PROFILE"; value: AttributeProfile; availableKeys: string[] }
  | { type: "SET_RUNTIME_MODE"; value: RuntimeMode }
  | { type: "SET_IMPORTANCE_FIELD"; value: string }
  | { type: "SET_MAX_STALENESS_MS"; value: number }
  | { type: "SET_IMPORTANCE_SAMPLING"; value: boolean }
  | { type: "SET_USE_DYNAMIC_ALLOC"; value: boolean }
  | { type: "SET_TIME_WINDOW_MS"; value: number }
  | { type: "SET_API_READY"; value: boolean }
  | { type: "SET_CANVAS_BG"; value: string };

function canvasConfigReducer(state: CanvasConfigState, action: CanvasConfigAction): CanvasConfigState {
  switch (action.type) {
    case "SET_DEMO_MODE":
      return { ...state, demoMode: action.mode };
    case "SET_MAX_POINTS":
      if (state.maxPoints === action.value) return state;
      // A real change requires a buffer remount; apiReady resets so the
      // benchmark waits for the new StreamedPointCloud to call onReady.
      return { ...state, maxPoints: action.value, apiReady: false };
    case "SET_COLOR_BY":
      return { ...state, colorBy: action.value };
    case "SET_REQUESTED_BACKEND":
      return { ...state, requestedBackend: action.value };
    case "SET_ACTIVE_BACKEND":
      return { ...state, activeBackend: action.value };
    case "SET_FRUSTUM_CULLING":
      return { ...state, frustumCulling: action.value };
    case "SET_AUTO_LOD":
      return { ...state, autoLod: action.value };
    case "SET_MANUAL_LOD_LEVEL":
      return { ...state, manualLodLevel: action.value };
    case "SET_WORKER_MODE":
      return { ...state, workerMode: action.value };
    case "SET_ADAPTIVE_REFRESH":
      return { ...state, adaptiveRefresh: action.value };
    case "SET_WORKER_CULLING":
      return { ...state, workerCulling: action.value };
    case "SET_ATTRIBUTE_PROFILE": {
      const colorBy = action.availableKeys.includes(state.colorBy)
        ? state.colorBy
        : action.availableKeys[0] ?? state.colorBy;
      const importanceField = action.availableKeys.includes(state.importanceField)
        ? state.importanceField
        : "";
      return { ...state, attributeProfile: action.value, colorBy, importanceField };
    }
    case "SET_RUNTIME_MODE":
      return { ...state, runtimeMode: action.value };
    case "SET_IMPORTANCE_FIELD":
      return { ...state, importanceField: action.value };
    case "SET_MAX_STALENESS_MS":
      return { ...state, maxStalenessMs: action.value };
    case "SET_IMPORTANCE_SAMPLING":
      return { ...state, importanceSamplingEnabled: action.value };
    case "SET_USE_DYNAMIC_ALLOC":
      return { ...state, useDynamicAlloc: action.value };
    case "SET_TIME_WINDOW_MS":
      return { ...state, timeWindowMs: action.value };
    case "SET_API_READY":
      return { ...state, apiReady: action.value };
    case "SET_CANVAS_BG":
      return { ...state, canvasBg: action.value };
  }
}

const CanvasConfigStateContext    = createContext<CanvasConfigState | null>(null);
const CanvasConfigDispatchContext = createContext<Dispatch<CanvasConfigAction> | null>(null);

export function CanvasConfigProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(canvasConfigReducer, initialState);
  return (
    <CanvasConfigStateContext value={state}>
      <CanvasConfigDispatchContext value={dispatch}>
        {children}
      </CanvasConfigDispatchContext>
    </CanvasConfigStateContext>
  );
}

export function useCanvasConfig(): CanvasConfigState {
  const ctx = use(CanvasConfigStateContext);
  if (!ctx) throw new Error("useCanvasConfig must be used within CanvasConfigProvider");
  return ctx;
}

export function useCanvasConfigDispatch(): Dispatch<CanvasConfigAction> {
  const ctx = use(CanvasConfigDispatchContext);
  if (!ctx) throw new Error("useCanvasConfigDispatch must be used within CanvasConfigProvider");
  return ctx;
}
