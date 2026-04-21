import React, { Suspense, lazy, useCallback, useMemo } from "react";
import { StreamedPointCloud, type StreamedPointCloudRef } from "pointflow";
import { useDemoCanvas, useDemoHud } from "../DemoContext";
import { useCanvasConfig } from "../contexts/CanvasConfigContext";

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
import { useFileDispatch, useFileState } from "../contexts/FileContext";
import { isCopcDatasetUrl } from "../utils";
import { DEMO_MODE_LABELS, RESOLVED_BACKEND_LABELS } from "../ui-options";

const LazyCopcPointCloud = lazy(() =>
  import("pointflow/copc").then((m) => ({ default: m.CopcPointCloud }))
);
const LazyPointCloud = lazy(() =>
  import("../../src/components/PointCloud").then((m) => ({ default: m.PointCloud }))
);
const LazyLazPointCloud = lazy(() =>
  Promise.all([
    import("../../src/components/PointCloud"),
    import("pointflow/laz"),
  ]).then(([{ PointCloud }, { createLazLoader }]) => ({
    default: (props: React.ComponentProps<typeof PointCloud>) =>
      <PointCloud {...props} loaderFactory={createLazLoader} maxPoints={props.maxPoints ?? 1_000_000} />,
  }))
);

export function StreamScene() {
  const {
    maxPoints, colorBy, autoLod, manualLodLevel, frustumCulling,
    workerMode, adaptiveRefresh, workerCulling, requestedBackend,
    useDynamicAlloc, runtimeMode, importanceField, maxStalenessMs,
    importanceSamplingEnabled, timeWindowMs, canvasBg,
  } = useCanvasConfig();
  const { apiRef, setStats, renderMetricsRef, setTemporalStats, setActiveBackend, setApiReady } = useDemoCanvas();
  const dynamicAlloc = useMemo(() => (useDynamicAlloc ? { initialCapacity: 65536, growthFactor: 2 } : undefined), [useDynamicAlloc]);
  const onStreamReady = useCallback((api: StreamedPointCloudRef) => {
    apiRef.current = api;
    setApiReady(true);
  }, [apiRef, setApiReady]);
  return (
    <StreamedPointCloud
      key={`${useDynamicAlloc}-${maxPoints}`}
      maxPoints={maxPoints}
      lodLevels={3}
      colorBy={colorBy}
      autoLod={autoLod}
      lodLevel={manualLodLevel}
      frustumCulling={frustumCulling}
      workerMode={workerMode}
      adaptiveRefresh={adaptiveRefresh}
      workerCulling={workerCulling}
      rendererBackend={requestedBackend}
      runtimeMode={runtimeMode}
      dynamicAlloc={dynamicAlloc}
      importanceField={importanceField || undefined}
      maxStalenessMs={maxStalenessMs || undefined}
      importanceSamplingEnabled={importanceSamplingEnabled}
      timeWindowMs={timeWindowMs || undefined}
      onTemporalStats={timeWindowMs > 0 ? setTemporalStats : undefined}
      onRendererResolved={setActiveBackend}
      onStats={setStats}
      renderMetricsRef={renderMetricsRef}
      onReady={onStreamReady}
      progress={1}
      cameraFit={{ halfsize: 15 }}
      background={canvasBg}
    />
  );
}

export function FileScene() {
  const { src: fileSrc, colorBy: fileColorBy, label: fileLabel } = useFileState();
  const fileDispatch = useFileDispatch();
  const { setActiveBackend, renderMetricsRef, fileViewSnapshotRef, requestedBackend, frustumCulling } = useDemoCanvas();
  const handleFileProgress = (p: number) => fileDispatch({ type: "SET_PROGRESS", progress: p });
  const handleFileReady = () => fileDispatch({ type: "SET_STATUS", status: "ready" });
  const handleFileError = (err: Error) => fileDispatch({ type: "SET_FILE_ERROR", message: err.message });
  const isLaz = fileSrc !== null && !isCopcDatasetUrl(fileSrc) &&
    (fileSrc.split('?')[0].toLowerCase().endsWith('.laz') || fileSrc.includes('#.laz'));
  if (!fileSrc) return <div className="empty-state">Load a dataset URL or sample.</div>;
  if (isCopcDatasetUrl(fileSrc)) {
    return (
      <Suspense fallback={<div className="empty-state">Loading COPC viewer…</div>}>
        <LazyCopcPointCloud
          key={fileSrc}
          src={fileSrc}
          colorBy={fileColorBy || "classification"}
          rendererBackend={requestedBackend}
          frustumCulling={frustumCulling}
          maxDepth={8}
          maxConcurrent={32}
          onReady={handleFileReady}
          onRendererResolved={setActiveBackend}
          onError={handleFileError}
          renderMetricsRef={renderMetricsRef}
          fileViewSnapshotRef={fileViewSnapshotRef}
          fileSourceLabel={fileLabel}
          onDeclaredPointCount={(n) => fileDispatch({ type: "SET_POINT_COUNT", count: n })}
          onAvailableAttributes={(attrs) => fileDispatch({ type: "SET_AVAILABLE_ATTRS", attributes: attrs })}
          onProgress={handleFileProgress}
        />
      </Suspense>
    );
  }
  const FileComponent = isLaz ? LazyLazPointCloud : LazyPointCloud;
  return (
    <Suspense fallback={<div className="empty-state">Loading file viewer…</div>}>
      <FileComponent
        key={fileSrc}
        src={fileSrc}
        colorBy={fileColorBy || "intensity"}
        rendererBackend={requestedBackend}
        frustumCulling={frustumCulling}
        onProgress={handleFileProgress}
        onReady={handleFileReady}
        onError={handleFileError}
        renderMetricsRef={renderMetricsRef}
        onRendererResolved={setActiveBackend}
        onAvailableAttributes={(attrs) => fileDispatch({ type: "SET_AVAILABLE_ATTRS", attributes: attrs })}
      />
    </Suspense>
  );
}

export function CompareScene() {
  const { canvasBg } = useCanvasConfig();
  const {
    compareLeftApiRef, compareRightApiRef,
    setCompareLeftReady, setCompareRightReady,
    setCompareLeftStats, setCompareRightStats,
    compareColorBy, compareMaxPoints,
    compareImportanceField, compareMaxStalenessMs, compareImportanceSamplingEnabled,
    requestedBackend, setActiveBackend,
    compareLeftRenderMetricsRef, compareRightRenderMetricsRef,
  } = useDemoCanvas();
  const onCompareLeftReady = useCallback((api: StreamedPointCloudRef) => {
    compareLeftApiRef.current = api;
    setCompareLeftReady(true);
  }, [compareLeftApiRef, setCompareLeftReady]);
  const onCompareRightReady = useCallback((api: StreamedPointCloudRef) => {
    compareRightApiRef.current = api;
    setCompareRightReady(true);
  }, [compareRightApiRef, setCompareRightReady]);
  return (
    <div className="compare-grid">
      <div className="compare-col">
        <div className="compare-label">FIFO</div>
        <StreamedPointCloud
          key={`cmp-left-${compareMaxPoints}`}
          maxPoints={compareMaxPoints}
          colorBy={compareColorBy}
          rendererBackend={requestedBackend}
          importanceSamplingEnabled={false}
          onRendererResolved={setActiveBackend}
          renderMetricsRef={compareLeftRenderMetricsRef}
          onStats={setCompareLeftStats}
          onReady={onCompareLeftReady}
          progress={1}
          cameraFit={{ halfsize: 30 }}
          background={canvasBg}
        />
      </div>
      <div className="compare-col">
        <div className="compare-label alt">K=16 + Importance</div>
        <StreamedPointCloud
          key={`cmp-right-${compareMaxPoints}`}
          maxPoints={compareMaxPoints}
          colorBy={compareColorBy}
          importanceField={compareImportanceField || undefined}
          maxStalenessMs={compareMaxStalenessMs || undefined}
          importanceSamplingEnabled={compareImportanceSamplingEnabled}
          rendererBackend={requestedBackend}
          onRendererResolved={setActiveBackend}
          renderMetricsRef={compareRightRenderMetricsRef}
          onStats={setCompareRightStats}
          onReady={onCompareRightReady}
          progress={1}
          cameraFit={{ halfsize: 30 }}
          background={canvasBg}
        />
      </div>
    </div>
  );
}

export function MetricsRail() {
  const hud = useDemoHud();
  const canvas = useDemoCanvas();
  const demoMode = canvas.demoMode as "stream" | "file" | "compare";
  const activeBackend = canvas.activeBackend as "webgl" | "webgpu";
  const running = canvas.streaming || canvas.benchmarkRunning || canvas.compareStreaming;

  return (
    <aside className="metrics-rail" role="complementary" aria-label="Live performance metrics">
      {demoMode === "stream" && (
        <div className="rail-actions">
          <button type="button" className="btn-primary" onClick={canvas.handleStart} disabled={running}>Run</button>
          <button type="button" className="btn-stop" onClick={canvas.handleStop} disabled={!canvas.streaming && !canvas.benchmarkRunning}>Stop</button>
          <button type="button" onClick={() => canvas.apiRef.current?.reset()} disabled={running}>Clear</button>
          <button type="button" onClick={canvas.handleExportBenchmarkJson} disabled={!canvas.lastBenchmarkReport}>Export JSON</button>
          <button type="button" onClick={() => void canvas.copyReport()}>Copy Report</button>
        </div>
      )}
      {demoMode === "compare" && (
        <div className="rail-actions">
          <button type="button" className="btn-primary" onClick={canvas.handleCompareStart} disabled={running}>Run</button>
          <button type="button" className="btn-stop" onClick={canvas.handleCompareStop} disabled={!canvas.compareStreaming}>Stop</button>
          <button type="button" onClick={() => { canvas.compareLeftApiRef.current?.reset(); canvas.compareRightApiRef.current?.reset(); }} disabled={running}>Clear</button>
          <button type="button" onClick={() => void canvas.copyCompareReport()}>Copy Report</button>
        </div>
      )}
      {(canvas.streaming || canvas.benchmarkRunning || canvas.compareStreaming) && (
        <div className="rail-timer">{formatDuration(hud.runDurationSec)}</div>
      )}
      <div className="metric-block">
        <span>Mode</span>
        <strong>{DEMO_MODE_LABELS[demoMode]}</strong>
      </div>
      <div className="metric-block">
        <span>Backend</span>
        <strong>{RESOLVED_BACKEND_LABELS[activeBackend]}</strong>
      </div>
      <div className="metric-block">
        <span>FPS</span>
        <strong>{hud.fps.toFixed(1)}</strong>
      </div>
      <div className="metric-block">
        <span>P95 ms</span>
        <strong>{hud.rollingP95Ms.toFixed(2)}</strong>
      </div>
      <div className="metric-block">
        <span>Drawn</span>
        <strong>{hud.renderedPoints.toLocaleString()}</strong>
      </div>
      <div className="metric-block">
        <span>Ingest/s</span>
        <strong>{hud.ingestRate.toLocaleString()}</strong>
      </div>
      <div className="metric-block">
        <span>Dropped</span>
        <strong>{hud.stats.droppedPoints.toLocaleString()}</strong>
      </div>
      <div className="metric-block">
        <span>Pressure</span>
        <strong>{hud.stats.isUnderPressure ? "Yes" : "No"}</strong>
      </div>
      <div className="metric-block">
        <span>Heap MB</span>
        <strong>{hud.heapMb === null ? "N/A" : hud.heapMb.toFixed(1)}</strong>
      </div>
    </aside>
  );
}
