import { createContext, use, useReducer, type Dispatch, type ReactNode } from "react";
import type { PointCloudStatus } from "pointflow";

export interface FileState {
  src: string | null;
  label: string | null;
  /** Always derived from src - don't set independently. */
  status: PointCloudStatus;
  progress: number;
  colorBy: string;
  pointCount: number | null;
  /** null = not yet reported for this load; [] = reported and empty; string[] = reported keys. */
  availableAttributes: string[] | null;
  /** User-visible detail when status is "error"; cleared on new load. */
  errorMessage: string | null;
}

const initialState: FileState = {
  src: null,
  label: null,
  status: "idle",
  progress: 0,
  colorBy: "classification",
  pointCount: null,
  availableAttributes: null,
  errorMessage: null,
};

export type FileAction =
  | { type: "SET_SRC"; src: string | null; label: string | null }
  | { type: "SET_COLOR_BY"; colorBy: string }
  | { type: "SET_AVAILABLE_ATTRS"; attributes: string[] }
  | { type: "SET_PROGRESS"; progress: number }
  | { type: "SET_STATUS"; status: PointCloudStatus }
  | { type: "SET_POINT_COUNT"; count: number }
  | { type: "SET_FILE_ERROR"; message: string }
  | { type: "DISMISS_FILE_ERROR" };

function fileReducer(state: FileState, action: FileAction): FileState {
  switch (action.type) {
    case "SET_SRC":
      return {
        ...state,
        src: action.src,
        label: action.label,
        status: action.src ? "loading" : "idle",
        progress: 0,
        pointCount: null,
        availableAttributes: null,
        errorMessage: null,
      };
    case "SET_COLOR_BY":
      return { ...state, colorBy: action.colorBy };
    case "SET_AVAILABLE_ATTRS":
      return { ...state, availableAttributes: action.attributes };
    case "SET_PROGRESS":
      return { ...state, progress: action.progress };
    case "SET_STATUS":
      return { ...state, status: action.status };
    case "SET_POINT_COUNT":
      return { ...state, pointCount: action.count };
    case "SET_FILE_ERROR":
      return {
        ...state,
        status: "error",
        errorMessage: action.message,
      };
    case "DISMISS_FILE_ERROR":
      return {
        ...state,
        errorMessage: null,
        status: state.status === "error" ? "idle" : state.status,
      };
    default:
      return state;
  }
}

const FileStateContext    = createContext<FileState | null>(null);
const FileDispatchContext = createContext<Dispatch<FileAction> | null>(null);

export function FileProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(fileReducer, initialState);
  return (
    <FileStateContext value={state}>
      <FileDispatchContext value={dispatch}>
        {children}
      </FileDispatchContext>
    </FileStateContext>
  );
}

export function useFileState(): FileState {
  const ctx = use(FileStateContext);
  if (!ctx) throw new Error("useFileState must be used within FileProvider");
  return ctx;
}

export function useFileDispatch(): Dispatch<FileAction> {
  const ctx = use(FileDispatchContext);
  if (!ctx) throw new Error("useFileDispatch must be used within FileProvider");
  return ctx;
}
