import { useRef } from "react";
import type { MutableRefObject } from "react";
import type { StreamedPointCloudRef } from "pointflow";
import {
  type BenchmarkProfile,
  type BenchmarkPassResult,
  type BenchmarkReport,
} from "../benchmark";
import { ATTRIBUTE_PROFILES } from "../constants";
import type { AttributeProfile } from "../constants";
import { useCanvasConfig, useCanvasConfigDispatch } from "../contexts/CanvasConfigContext";
import { useBenchmarkState, useBenchmarkDispatch } from "../contexts/BenchmarkContext";
import { useSuiteState, useSuiteDispatch } from "../contexts/SuiteContext";
import { useHudMetrics } from "../contexts/HudContext";
import type { FeatureSnapshot } from "./useBenchmarkRunner";
import {
  TEST_PROFILES,
  buildSuiteReport,
  type TestProfile,
  type SuiteProfileResult,
  type SuiteReport,
  type SuiteFeatureMetrics,
} from "../test-suite";
import { applySuiteProfileSettings } from "./suite-apply-profile";
import { buildFeatureMetrics, createSkippedSuiteResult, createSuiteProfileResult } from "./suite-results";
import { clearSuiteTimers, startSuiteManualCountdown } from "./suite-timers";

export function useSuiteRunner({
  apiRef,
  featureSnapshotRef,
  suiteOnCompleteRef,
  pendingBenchmarkRef,
  multiRunPassesRef,
  multiRunRemainingRef,
  warmupMsRef,
  handleStop,
}: {
  apiRef: MutableRefObject<StreamedPointCloudRef | null>;
  featureSnapshotRef: MutableRefObject<FeatureSnapshot>;
  suiteOnCompleteRef: MutableRefObject<((pass: BenchmarkPassResult) => void) | null>;
  pendingBenchmarkRef: MutableRefObject<{ profile: BenchmarkProfile; runAt: number } | null>;
  multiRunPassesRef: MutableRefObject<BenchmarkReport["passes"]>;
  multiRunRemainingRef: MutableRefObject<number>;
  warmupMsRef: MutableRefObject<number>;
  handleStop: () => void;
}) {
  // ── Context reads ─────────────────────────────────────────────────────────
  const {
    requestedBackend, activeBackend, workerMode, frustumCulling, autoLod,
    importanceSamplingEnabled,
  } = useCanvasConfig();
  const canvasConfigDispatch = useCanvasConfigDispatch();

  const { streaming, benchmarkRunning } = useBenchmarkState();
  const benchmarkDispatch = useBenchmarkDispatch();

  const {
    suiteRunning, suiteCurrentIdx, suiteTotalProfiles,
    suiteCurrentProfileId, suiteWaitingManual, suiteManualCountdownSec,
    lastSuiteReport,
  } = useSuiteState();
  const suiteDispatch = useSuiteDispatch();

  const {
    frameTimeMs, rollingP95Ms, hitches50, hitches100, heapMb,
    ingestRate, ingestedPoints, droppedRatio, stats, renderedPoints, fps,
  } = useHudMetrics();

  // ── Dispatch wrappers ─────────────────────────────────────────────────────
  const setSuiteRunning          = (value: boolean)         => suiteDispatch({ type: "SET_SUITE_RUNNING", value });
  const setSuiteCurrentIdx       = (value: number)          => suiteDispatch({ type: "SET_SUITE_CURRENT_IDX", value });
  const setSuiteTotalProfiles    = (value: number)          => suiteDispatch({ type: "SET_SUITE_TOTAL_PROFILES", value });
  const setSuiteCurrentProfileId = (value: string | null)   => suiteDispatch({ type: "SET_SUITE_CURRENT_PROFILE_ID", value });
  const setSuiteWaitingManual    = (value: boolean)         => suiteDispatch({ type: "SET_SUITE_WAITING_MANUAL", value });
  const setSuiteManualCountdownSec = (value: number | null) => suiteDispatch({ type: "SET_SUITE_MANUAL_COUNTDOWN_SEC", value });
  const setLastSuiteReport       = (value: SuiteReport | null) => suiteDispatch({ type: "SET_LAST_SUITE_REPORT", value });

  const setBenchmarkRunning    = (value: boolean)       => benchmarkDispatch({ type: "SET_BENCHMARK_RUNNING", value });
  const setBenchmarkProfileId  = (value: string)        => benchmarkDispatch({ type: "SET_BENCHMARK_PROFILE_ID", value: value as any });
  const setCustomMaxPoints     = (value: number)        => benchmarkDispatch({ type: "SET_CUSTOM_MAX_POINTS", value });
  const setCustomPointsPerChunk = (value: number)       => benchmarkDispatch({ type: "SET_CUSTOM_POINTS_PER_CHUNK", value });
  const setCustomIntervalMs    = (value: number)        => benchmarkDispatch({ type: "SET_CUSTOM_INTERVAL_MS", value });
  const setCustomDurationSec   = (value: number)        => benchmarkDispatch({ type: "SET_CUSTOM_DURATION_SEC", value });

  const setDemoMode             = (mode: "stream" | "file" | "compare") => canvasConfigDispatch({ type: "SET_DEMO_MODE", mode });
  const setMaxPoints            = (value: number)       => canvasConfigDispatch({ type: "SET_MAX_POINTS", value });
  const setAutoLod              = (value: boolean)      => canvasConfigDispatch({ type: "SET_AUTO_LOD", value });
  const setFrustumCulling       = (value: boolean)      => canvasConfigDispatch({ type: "SET_FRUSTUM_CULLING", value });
  const setRequestedBackend     = (value: string)       => canvasConfigDispatch({ type: "SET_REQUESTED_BACKEND", value: value as any });
  const setAttributeProfile     = (value: AttributeProfile) =>
    canvasConfigDispatch({ type: "SET_ATTRIBUTE_PROFILE", value, availableKeys: ATTRIBUTE_PROFILES[value].keys });
  const setColorBy              = (value: string)       => canvasConfigDispatch({ type: "SET_COLOR_BY", value });
  const setImportanceField      = (value: string)       => canvasConfigDispatch({ type: "SET_IMPORTANCE_FIELD", value });
  const setMaxStalenessMs       = (value: number)       => canvasConfigDispatch({ type: "SET_MAX_STALENESS_MS", value });
  const setImportanceSamplingEnabled = (value: boolean) => canvasConfigDispatch({ type: "SET_IMPORTANCE_SAMPLING", value });
  const setTimeWindowMs         = (value: number)       => canvasConfigDispatch({ type: "SET_TIME_WINDOW_MS", value });

  // ── Suite refs ────────────────────────────────────────────────────────────
  const suiteQueueRef            = useRef<TestProfile[]>([]);
  const suiteResultsRef          = useRef<SuiteProfileResult[]>([]);
  const suiteCurrentProfileRef   = useRef<TestProfile | null>(null);
  const suiteManualTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suiteCountdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const manualProfileStartTimeRef = useRef(0);
  // Always-current ref so the countdown setInterval closure reads the latest value.
  const suiteManualCountdownSecRef = useRef<number | null>(null);
  suiteManualCountdownSecRef.current = suiteManualCountdownSec;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function handleSuiteProfileComplete(pass: BenchmarkPassResult) {
    const profile = suiteCurrentProfileRef.current;
    if (!profile) return;
    const featureMetrics = buildFeatureMetrics(featureSnapshotRef.current);
    suiteResultsRef.current.push(createSuiteProfileResult(profile, pass, featureMetrics));

    suiteDispatch({ type: "INCREMENT_SUITE_IDX" });
    advanceSuite();
  }

  function advanceSuite() {
    const next = suiteQueueRef.current.shift();

    if (!next) {
      setLastSuiteReport(buildSuiteReport(suiteResultsRef.current));
      setSuiteRunning(false);
      setSuiteCurrentProfileId(null);
      suiteCurrentProfileRef.current = null;
      return;
    }

    suiteCurrentProfileRef.current = next;
    setSuiteCurrentProfileId(next.id);

    if (next.manual) {
      manualProfileStartTimeRef.current = Date.now();
      setSuiteWaitingManual(true);
      startSuiteManualCountdown({
        durationSec: next.durationSec,
        suiteCountdownIntervalRef,
        suiteManualCountdownSecRef,
        setSuiteManualCountdownSec,
        dispatchCountdownTick: (value) => suiteDispatch({ type: "SET_SUITE_MANUAL_COUNTDOWN_SEC", value }),
      });
      return;
    }

    // Automated profile: apply settings and kick off the benchmark runner.
    const prevResult = suiteResultsRef.current[suiteResultsRef.current.length - 1];
    const prevProfile = prevResult ? TEST_PROFILES.find(p => p.id === prevResult.profileId) : null;
    const backendChanged = prevProfile && prevProfile.requestedBackend !== next.requestedBackend;
    const transitionMs = (prevProfile && (prevProfile.maxPoints !== next.maxPoints || backendChanged)) ? 3000 : 400;

    applySuiteProfileSettings(next, {
      setDemoMode,
      setBenchmarkProfileId,
      setCustomMaxPoints,
      setMaxPoints,
      setCustomPointsPerChunk,
      setCustomIntervalMs,
      setCustomDurationSec,
      setAutoLod,
      setFrustumCulling,
      setRequestedBackend,
      setAttributeProfile,
      setColorBy,
      setImportanceField,
      setMaxStalenessMs,
      setImportanceSamplingEnabled,
      setTimeWindowMs,
    });

    const benchProfile: BenchmarkProfile = {
      id:             next.id,
      label:          next.label,
      maxPoints:      next.maxPoints,
      pointsPerChunk: next.pointsPerChunk,
      intervalMs:     next.intervalMs,
      durationSec:    next.durationSec,
      warmupSec:      next.warmupSec,
    };

    // setTimeout ensures React commits benchmarkRunning=false before flipping true,
    // so the benchmark useEffect sees the false→true edge.
    setTimeout(() => {
      apiRef.current?.reset();
      warmupMsRef.current           = next.warmupSec * 1000;
      suiteOnCompleteRef.current    = handleSuiteProfileComplete;
      multiRunPassesRef.current     = [];
      multiRunRemainingRef.current  = 0;
      pendingBenchmarkRef.current   = { profile: benchProfile, runAt: Date.now() };
      setBenchmarkRunning(true);
    }, transitionMs);
  }

  // ── Public handlers ───────────────────────────────────────────────────────

  const handleRunSuite = () => {
    if (suiteRunning || benchmarkRunning || streaming) return;

    const allProfiles = [...TEST_PROFILES];
    suiteQueueRef.current   = allProfiles.slice(1);
    suiteResultsRef.current = [];
    setSuiteRunning(true);
    setSuiteCurrentIdx(0);
    setSuiteTotalProfiles(allProfiles.length);
    setSuiteWaitingManual(false);
    setLastSuiteReport(null);

    suiteQueueRef.current = allProfiles.slice(1);
    suiteCurrentProfileRef.current = allProfiles[0];
    setSuiteCurrentProfileId(allProfiles[0].id);

    if (allProfiles[0].manual) {
      setSuiteWaitingManual(true);
    } else {
      applySuiteProfileSettings(allProfiles[0], {
        setDemoMode,
        setBenchmarkProfileId,
        setCustomMaxPoints,
        setMaxPoints,
        setCustomPointsPerChunk,
        setCustomIntervalMs,
        setCustomDurationSec,
        setAutoLod,
        setFrustumCulling,
        setRequestedBackend,
        setAttributeProfile,
        setColorBy,
        setImportanceField,
        setMaxStalenessMs,
        setImportanceSamplingEnabled,
        setTimeWindowMs,
      });
      const first = allProfiles[0];
      const benchProfile: BenchmarkProfile = {
        id: first.id, label: first.label,
        maxPoints: first.maxPoints, pointsPerChunk: first.pointsPerChunk,
        intervalMs: first.intervalMs, durationSec: first.durationSec, warmupSec: first.warmupSec,
      };
      warmupMsRef.current           = first.warmupSec * 1000;
      suiteOnCompleteRef.current    = handleSuiteProfileComplete;
      multiRunPassesRef.current     = [];
      multiRunRemainingRef.current  = 0;
      pendingBenchmarkRef.current   = { profile: benchProfile, runAt: Date.now() };
      setBenchmarkRunning(true);
    }
  };

  const handleStopSuite = () => {
    if (!suiteRunning) return;
    clearSuiteTimers({
      suiteManualTimerRef,
      suiteCountdownIntervalRef,
      setSuiteManualCountdownSec,
    });
    suiteOnCompleteRef.current = null;
    handleStop();
    const remaining = suiteQueueRef.current;
    suiteQueueRef.current = [];
    for (const p of remaining) {
      suiteResultsRef.current.push(createSkippedSuiteResult(p));
    }
    if (suiteResultsRef.current.length > 0) {
      setLastSuiteReport(buildSuiteReport(suiteResultsRef.current));
    }
    setSuiteRunning(false);
    setSuiteWaitingManual(false);
    setSuiteCurrentProfileId(null);
  };

  const handleSuiteManualContinue = () => {
    if (!suiteWaitingManual) return;
    setSuiteWaitingManual(false);
    clearSuiteTimers({
      suiteManualTimerRef,
      suiteCountdownIntervalRef,
      setSuiteManualCountdownSec,
    });

    const profile = suiteCurrentProfileRef.current;
    if (!profile) return;

    const minimalPass: BenchmarkPassResult = {
      passIndex:           suiteResultsRef.current.length,
      durationSec:         profile.durationSec,
      warmupSec:           profile.warmupSec,
      elapsedMs:           Date.now() - manualProfileStartTimeRef.current,
      avgFrameMs:          frameTimeMs,
      rollingP95Ms,
      hitches50,
      hitches100,
      heapCurrentMb:       heapMb,
      heapMaxMb:           heapMb ?? 0,
      ingestPeakPtsPerSec: ingestRate,
      ingestTotal:         ingestedPoints,
      droppedPoints:       stats.droppedPoints,
      droppedRatioPct:     droppedRatio,
      bufferKept:          stats.totalPoints,
      pressure:            stats.isUnderPressure,
      renderedPeak:        renderedPoints,
      minFps:              fps,
      maxFps:              fps,
      requestedBackend,
      activeBackend,
      fallbackActive:      requestedBackend === "webgpu" && activeBackend === "webgl",
      workerMode,
      frustumCulling,
      autoLod,
      importanceSamplingEnabled,
    };

    const featureMetrics = buildFeatureMetrics(featureSnapshotRef.current);
    suiteResultsRef.current.push(createSuiteProfileResult(profile, minimalPass, featureMetrics));

    suiteDispatch({ type: "INCREMENT_SUITE_IDX" });
    advanceSuite();
  };

  const handleExportSuiteReport = () => {
    if (!lastSuiteReport) return;
    const json = JSON.stringify(lastSuiteReport, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a    = document.createElement("a");
    a.href     = URL.createObjectURL(blob);
    a.download = `pointflow-suite-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return {
    suiteRunning,
    suiteCurrentIdx,
    suiteTotalProfiles,
    suiteCurrentProfileId,
    suiteWaitingManual,
    suiteManualCountdownSec,
    lastSuiteReport,
    handleRunSuite,
    handleStopSuite,
    handleSuiteManualContinue,
    handleExportSuiteReport,
  };
}
