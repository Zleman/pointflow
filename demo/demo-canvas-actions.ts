import { ATTRIBUTE_PROFILES } from "./constants";
import type { AttributeProfile } from "./constants";
import type { RendererBackend, RuntimeMode } from "pointflow";

type CanvasDispatch = (action: Record<string, unknown>) => void;

export function createDemoCanvasActions(params: {
  dispatch: CanvasDispatch;
  frustumCulling: boolean;
  autoLod: boolean;
  workerMode: boolean;
  adaptiveRefresh: boolean;
  workerCulling: boolean;
}) {
  const { dispatch, frustumCulling, autoLod, workerMode, adaptiveRefresh, workerCulling } = params;
  return {
    setDemoMode: (mode: "stream" | "file" | "compare") => dispatch({ type: "SET_DEMO_MODE", mode }),
    setColorBy: (value: string) => dispatch({ type: "SET_COLOR_BY", value }),
    setRequestedBackend: (value: RendererBackend) => dispatch({ type: "SET_REQUESTED_BACKEND", value }),
    setActiveBackend: (value: "webgl" | "webgpu") => dispatch({ type: "SET_ACTIVE_BACKEND", value }),
    setFrustumCulling: (v: boolean | ((p: boolean) => boolean)) =>
      dispatch({ type: "SET_FRUSTUM_CULLING", value: typeof v === "function" ? v(frustumCulling) : v }),
    setAutoLod: (v: boolean | ((p: boolean) => boolean)) =>
      dispatch({ type: "SET_AUTO_LOD", value: typeof v === "function" ? v(autoLod) : v }),
    setManualLodLevel: (value: number) => dispatch({ type: "SET_MANUAL_LOD_LEVEL", value }),
    setWorkerMode: (v: boolean | ((p: boolean) => boolean)) =>
      dispatch({ type: "SET_WORKER_MODE", value: typeof v === "function" ? v(workerMode) : v }),
    setAdaptiveRefresh: (v: boolean | ((p: boolean) => boolean)) =>
      dispatch({ type: "SET_ADAPTIVE_REFRESH", value: typeof v === "function" ? v(adaptiveRefresh) : v }),
    setWorkerCulling: (v: boolean | ((p: boolean) => boolean)) =>
      dispatch({ type: "SET_WORKER_CULLING", value: typeof v === "function" ? v(workerCulling) : v }),
    setAttributeProfile: (value: AttributeProfile) =>
      dispatch({ type: "SET_ATTRIBUTE_PROFILE", value, availableKeys: ATTRIBUTE_PROFILES[value].keys }),
    setRuntimeMode: (value: RuntimeMode) => dispatch({ type: "SET_RUNTIME_MODE", value }),
    setImportanceField: (value: string) => dispatch({ type: "SET_IMPORTANCE_FIELD", value }),
    setMaxStalenessMs: (value: number) => dispatch({ type: "SET_MAX_STALENESS_MS", value }),
    setImportanceSamplingEnabled: (value: boolean) => dispatch({ type: "SET_IMPORTANCE_SAMPLING", value }),
    setUseDynamicAlloc: (value: boolean) => dispatch({ type: "SET_USE_DYNAMIC_ALLOC", value }),
    setTimeWindowMs: (value: number) => dispatch({ type: "SET_TIME_WINDOW_MS", value }),
    setApiReady: (value: boolean) => dispatch({ type: "SET_API_READY", value }),
  };
}
