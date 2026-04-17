import {
  createContext, use, useReducer, useRef, useState, useEffect,
  type Dispatch, type ReactNode,
} from "react";
import type { StreamedPointCloudRef, StreamedPointCloudRenderMetrics } from "pointflow";
import { useCanvasConfig } from "./CanvasConfigContext";
import {
  compareReducer,
  initialState,
  type CompareAction,
  type CompareState,
} from "./compare-state";
import {
  restartCompareLoop,
  startCompareLoop,
  stopCompareLoop,
} from "./compare-runtime";

const CompareStateContext    = createContext<CompareState | null>(null);
const CompareDispatchContext = createContext<Dispatch<CompareAction> | null>(null);

export function CompareProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(compareReducer, initialState);
  return (
    <CompareStateContext value={state}>
      <CompareDispatchContext value={dispatch}>
        {children}
      </CompareDispatchContext>
    </CompareStateContext>
  );
}

export function useCompareState(): CompareState {
  const ctx = use(CompareStateContext);
  if (!ctx) throw new Error("useCompareState must be used within CompareProvider");
  return ctx;
}

export function useCompareDispatch(): Dispatch<CompareAction> {
  const ctx = use(CompareDispatchContext);
  if (!ctx) throw new Error("useCompareDispatch must be used within CompareProvider");
  return ctx;
}

export function useCompareMode() {
  const {
    compareStreaming, compareLeftReady, compareRightReady,
    compareColorBy, compareMaxPoints,
    compareImportanceField, compareMaxStalenessMs, compareImportanceSamplingEnabled,
    comparePointsPerChunk, compareIntervalMs,
  } = useCompareState();
  const compareDispatch = useCompareDispatch();
  const { demoMode } = useCanvasConfig();

  const compareLeftApiRef  = useRef<StreamedPointCloudRef | null>(null);
  const compareRightApiRef = useRef<StreamedPointCloudRef | null>(null);
  const compareIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compareIngestCounterRef = useRef(0);
  const compareLeftRenderMetricsRef  = useRef<StreamedPointCloudRenderMetrics | null>(null);
  const compareRightRenderMetricsRef = useRef<StreamedPointCloudRenderMetrics | null>(null);

  // Always-current refs so interval closures don't go stale.
  const compareStreamingRef     = useRef(compareStreaming);
  compareStreamingRef.current   = compareStreaming;
  const comparePointsPerChunkRef = useRef(comparePointsPerChunk);
  comparePointsPerChunkRef.current = comparePointsPerChunk;
  const compareIntervalMsRef    = useRef(compareIntervalMs);
  compareIntervalMsRef.current  = compareIntervalMs;

  // Display metrics - written by the 200ms flush effect, read by ComparePanel/headers.
  const [compareIngestRate,           setCompareIngestRate]           = useState(0);
  const [compareLeftRenderedPoints,   setCompareLeftRenderedPoints]   = useState(0);
  const [compareRightRenderedPoints,  setCompareRightRenderedPoints]  = useState(0);
  const [compareLeftFps,              setCompareLeftFps]              = useState(0);
  const [compareRightFps,             setCompareRightFps]             = useState(0);
  const [compareLeftStats,  setCompareLeftStats]  = useState({ totalPoints: 0, droppedPoints: 0 });
  const [compareRightStats, setCompareRightStats] = useState({ totalPoints: 0, droppedPoints: 0 });

  function startCompare(
    pointsPerChunk = comparePointsPerChunkRef.current,
    intervalMs     = compareIntervalMsRef.current,
  ) {
    startCompareLoop({
      pointsPerChunk,
      intervalMs,
      compareIntervalRef,
      compareIngestCounterRef,
      compareLeftApiRef,
      compareRightApiRef,
      setCompareStreaming: (value) => compareDispatch({ type: "SET_COMPARE_STREAMING", value }),
    });
  }

  function stopCompare() {
    stopCompareLoop({
      compareIntervalRef,
      setCompareStreaming: (value) => compareDispatch({ type: "SET_COMPARE_STREAMING", value }),
    });
  }

  // Stop the interval when the user navigates away from compare mode.
  useEffect(() => {
    if (demoMode !== "compare" && compareStreamingRef.current) stopCompare();
  }, [demoMode]);

  // Ingest rate counter - only meaningful while in compare mode.
  useEffect(() => {
    if (demoMode !== "compare") return;
    const timer = setInterval(() => {
      setCompareIngestRate(compareIngestCounterRef.current);
      compareIngestCounterRef.current = 0;
    }, 1000);
    return () => clearInterval(timer);
  }, [demoMode]);

  // Flush render-metrics refs to React state every 200ms.
  const flushLeftRef  = useRef((m: StreamedPointCloudRenderMetrics) => {
    setCompareLeftRenderedPoints(m.renderedPoints);
    setCompareLeftFps(m.fps);
  });
  const flushRightRef = useRef((m: StreamedPointCloudRenderMetrics) => {
    setCompareRightRenderedPoints(m.renderedPoints);
    setCompareRightFps(m.fps);
  });

  useEffect(() => {
    const id = setInterval(() => {
      if (compareLeftRenderMetricsRef.current)  flushLeftRef.current(compareLeftRenderMetricsRef.current);
      if (compareRightRenderMetricsRef.current) flushRightRef.current(compareRightRenderMetricsRef.current);
    }, 200);
    return () => clearInterval(id);
  }, []);

  // These two setters restart the stream inline rather than via a useEffect watcher.
  function setComparePointsPerChunk(value: number) {
    compareDispatch({ type: "SET_COMPARE_POINTS_PER_CHUNK", value });
    restartCompareLoop({
      compareStreaming: compareStreamingRef.current,
      stopCompare,
      startCompare: () => startCompare(comparePointsPerChunkRef.current, compareIntervalMsRef.current),
    });
  }

  function setCompareIntervalMs(value: number) {
    compareDispatch({ type: "SET_COMPARE_INTERVAL_MS", value });
    restartCompareLoop({
      compareStreaming: compareStreamingRef.current,
      stopCompare,
      startCompare: () => startCompare(comparePointsPerChunkRef.current, compareIntervalMsRef.current),
    });
  }

  const copyCompareReport = async () => {
    const lIngest = compareLeftStats.totalPoints  + compareLeftStats.droppedPoints;
    const rIngest = compareRightStats.totalPoints + compareRightStats.droppedPoints;
    const lDrop = lIngest > 0 ? ((compareLeftStats.droppedPoints  / lIngest) * 100).toFixed(1) : "0.0";
    const rDrop = rIngest > 0 ? ((compareRightStats.droppedPoints / rIngest) * 100).toFixed(1) : "0.0";
    const report = [
      "PointFlow Comparison Report - FIFO vs Importance Engine",
      `Max buffer: ${compareMaxPoints.toLocaleString()} pts each`,
      `Ingest: ${comparePointsPerChunk} pts/chunk · ${compareIntervalMs}ms interval · ~${compareIngestRate} pts/s`,
      `ColorBy: ${compareColorBy}`,
      "",
      "LEFT (FIFO - no importance)",
      `  Rendered: ${compareLeftRenderedPoints.toLocaleString()} pts · FPS: ${compareLeftFps.toFixed(1)}`,
      `  Buffer: ${compareLeftStats.totalPoints.toLocaleString()} kept · ${compareLeftStats.droppedPoints.toLocaleString()} dropped (${lDrop}%)`,
      "",
      "RIGHT (K=16 + importance engine)",
      `  Field: ${compareImportanceField || "none"} · Staleness: ${compareMaxStalenessMs > 0 ? `${(compareMaxStalenessMs / 1000).toFixed(1)}s` : "off"} · GPU sampling: ${compareImportanceSamplingEnabled ? "on" : "off"}`,
      `  Rendered: ${compareRightRenderedPoints.toLocaleString()} pts · FPS: ${compareRightFps.toFixed(1)}`,
      `  Buffer: ${compareRightStats.totalPoints.toLocaleString()} kept · ${compareRightStats.droppedPoints.toLocaleString()} dropped (${rDrop}%)`,
      "",
      `Render advantage (right vs left): ${
        compareLeftRenderedPoints > 0
          ? (() => {
              const deltaPct = ((compareRightRenderedPoints / compareLeftRenderedPoints) * 100 - 100);
              return deltaPct >= 0
                ? `${deltaPct.toFixed(0)}% more rendered pts`
                : `${Math.abs(deltaPct).toFixed(0)}% fewer rendered pts`;
            })()
          : "n/a"
      }`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      window.prompt("Copy comparison report:", report);
    }
  };

  return {
    compareStreaming, compareLeftReady, compareRightReady,
    compareColorBy, compareMaxPoints,
    compareImportanceField, compareMaxStalenessMs, compareImportanceSamplingEnabled,
    comparePointsPerChunk, compareIntervalMs,
    setCompareStreaming:               (value: boolean) => compareDispatch({ type: "SET_COMPARE_STREAMING", value }),
    setCompareLeftReady:               (value: boolean) => compareDispatch({ type: "SET_COMPARE_LEFT_READY", value }),
    setCompareRightReady:              (value: boolean) => compareDispatch({ type: "SET_COMPARE_RIGHT_READY", value }),
    setCompareColorBy:                 (value: string)  => compareDispatch({ type: "SET_COMPARE_COLOR_BY", value }),
    setCompareMaxPoints:               (value: number)  => compareDispatch({ type: "SET_COMPARE_MAX_POINTS", value }),
    setCompareImportanceField:         (value: string)  => compareDispatch({ type: "SET_COMPARE_IMPORTANCE_FIELD", value }),
    setCompareMaxStalenessMs:          (value: number)  => compareDispatch({ type: "SET_COMPARE_MAX_STALENESS_MS", value }),
    setCompareImportanceSamplingEnabled: (value: boolean) => compareDispatch({ type: "SET_COMPARE_IMPORTANCE_SAMPLING", value }),
    setComparePointsPerChunk,
    setCompareIntervalMs,
    compareLeftApiRef, compareRightApiRef,
    compareLeftRenderMetricsRef, compareRightRenderMetricsRef,
    compareIngestRate,
    compareLeftRenderedPoints, compareRightRenderedPoints,
    compareLeftFps, compareRightFps,
    compareLeftStats, setCompareLeftStats,
    compareRightStats, setCompareRightStats,
    handleCompareStart: () => startCompare(),
    handleCompareStop:  () => stopCompare(),
    copyCompareReport,
  };
}
