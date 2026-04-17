import React, { useEffect, useState } from "react";
import type { CopcFileViewSnapshot } from "pointflow";
import { useCanvasConfig } from "./contexts/CanvasConfigContext";
import { useFileState } from "./contexts/FileContext";
import { useDemoCanvas, useDemoHud } from "./DemoContext";
import { isCopcDatasetUrl } from "./utils";

export function MetricsGrid() {
  const { demoMode } = useCanvasConfig();
  const { src: fileSrc } = useFileState();
  const {
    workerMode,
    attributeProfileConfig,
    colorBy,
    activeBackend,
    requestedBackend,
    ingestConfigLabel,
    importanceField,
    maxStalenessMs,
    importanceSamplingEnabled,
    fileViewSnapshotRef,
  } = useDemoCanvas();
  const {
    ingestRate,
    ingestedPoints,
    stats,
    droppedRatio,
    renderedPoints,
    effectiveLodLevel,
    cameraDistance,
    fps,
    frameTimeMs,
    rollingP95Ms,
    hitches50,
    hitches100,
    heapMb,
    runDurationSec,
    oldestRetainedAgeMs,
  } = useDemoHud();

  const kLookaheadActive = importanceField !== "" || maxStalenessMs > 0;
  const isFileMode = demoMode === "file";
  const showCopcHud = isFileMode && fileSrc !== null && isCopcDatasetUrl(fileSrc);

  const [copcSnap, setCopcSnap] = useState<CopcFileViewSnapshot | null>(null);
  useEffect(() => {
    if (!showCopcHud) {
      setCopcSnap(null);
      return;
    }
    const id = window.setInterval(() => {
      setCopcSnap(fileViewSnapshotRef.current);
    }, 200);
    return () => clearInterval(id);
  }, [showCopcHud, fileViewSnapshotRef]);

  return (
    <section className="pf-metrics-grid">
      <article className="pf-metric-card">
        <h3>Ingest</h3>
        <p className="pf-metric-main">{ingestRate} pts/s</p>
        <p className="pf-metric-sub">total {ingestedPoints} | {workerMode ? "worker" : "main-thread"}</p>
      </article>
      <article className="pf-metric-card">
        <h3>Attributes</h3>
        <p className="pf-metric-main">{attributeProfileConfig.label}</p>
        <p className="pf-metric-sub">{attributeProfileConfig.keys.join(", ")} | colorBy {colorBy}</p>
      </article>
      <article className="pf-metric-card">
        <h3>Renderer</h3>
        <p className="pf-metric-main">{activeBackend.toUpperCase()}</p>
        <p className="pf-metric-sub">
          req {requestedBackend}
          {requestedBackend === "webgpu" && activeBackend === "webgl" ? " | fallback active" : ""}
        </p>
      </article>
      <article className="pf-metric-card">
        <h3>Buffer</h3>
        <p className="pf-metric-main">{stats.totalPoints} kept</p>
        <p className="pf-metric-sub">dropped {stats.droppedPoints} ({droppedRatio.toFixed(2)}%) | pressure {stats.isUnderPressure ? "yes" : "no"}</p>
      </article>
      <article className="pf-metric-card">
        <h3>Render</h3>
        <p className="pf-metric-main">
          {isFileMode ? `${cameraDistance.toFixed(1)} m` : `${renderedPoints} pts`}
        </p>
        <p className="pf-metric-sub">
          {isFileMode
            ? `${renderedPoints.toLocaleString()} pts · LOD ${effectiveLodLevel}`
            : `LOD ${effectiveLodLevel} | cam ${cameraDistance.toFixed(1)}`}
        </p>
      </article>
      <article className="pf-metric-card">
        <h3>Frame</h3>
        <p className="pf-metric-main">{fps.toFixed(1)} FPS</p>
        <p className="pf-metric-sub">{frameTimeMs.toFixed(2)} ms | p95 {rollingP95Ms.toFixed(2)} ms</p>
      </article>
      <article className="pf-metric-card">
        <h3>Hitches</h3>
        <p className="pf-metric-main">50ms {hitches50}</p>
        <p className="pf-metric-sub">100ms {hitches100}</p>
      </article>
      <article className="pf-metric-card">
        <h3>Memory</h3>
        <p className="pf-metric-main">{heapMb === null ? "n/a" : `${heapMb.toFixed(1)} MB`}</p>
        <p className="pf-metric-sub">run {runDurationSec}s | ingest {ingestConfigLabel}</p>
      </article>
      <article className="pf-metric-card">
        <h3>Importance</h3>
        <p className="pf-metric-main" style={{ fontSize: 14 }}>
          {importanceField || "uniform"}
        </p>
        <p className="pf-metric-sub">
          {kLookaheadActive ? "K=16 lookahead" : "FIFO"}
          {maxStalenessMs > 0 ? ` · ${(maxStalenessMs / 1000).toFixed(1)}s` : ""}
          {importanceSamplingEnabled ? " · GPU on" : " · GPU off"}
        </p>
        {kLookaheadActive && (
          <p className="pf-metric-sub" style={{ marginTop: 2 }}>
            oldest {oldestRetainedAgeMs < 1000 ? `${oldestRetainedAgeMs}ms` : `${(oldestRetainedAgeMs / 1000).toFixed(1)}s`}
          </p>
        )}
      </article>
      {showCopcHud && copcSnap && (
        <>
          <article className="pf-metric-card">
            <h3>Geometry</h3>
            <p className="pf-metric-main">
              {copcSnap.frame.cameraToBboxClosestM.toFixed(1)} m to hull
            </p>
            <p className="pf-metric-sub">
              orbit {copcSnap.frame.orbitToCameraM.toFixed(1)} m · center {copcSnap.frame.cameraToCenterM.toFixed(1)} m
              {copcSnap.frame.cameraInsideDatasetBbox ? " · inside bbox" : ""}
            </p>
            <p className="pf-metric-sub">
              orbit−closest {copcSnap.frame.orbitDistanceMinusClosestM.toFixed(1)} m · frustum∩bbox {copcSnap.frame.frustumIntersectsBbox ? "yes" : "no"}
            </p>
            {copcSnap.frame.cameraInsideDatasetBbox && (
              <p className="pf-metric-sub" style={{ marginTop: 4 }}>
                Inside bbox: orbit distance is pivot depth, not scene scale - double-click to focus pivot on the hull
              </p>
            )}
          </article>
          <article className="pf-metric-card">
            <h3>COPC file</h3>
            <p className="pf-metric-main">
              {copcSnap.static.indexNodeCount.toLocaleString()} nodes
            </p>
            <p className="pf-metric-sub">
              depth ≤{copcSnap.static.maxTreeDepth} · {copcSnap.static.declaredTotalPoints.toLocaleString()} pts declared
              {copcSnap.static.declaredTotalPointsCapped ? " (cap)" : ""}
            </p>
            <p className="pf-metric-sub">
              tiles {copcSnap.frame.tilesFetched.toLocaleString()}/{copcSnap.frame.tilesTotal.toLocaleString()} · half-diag {copcSnap.static.bboxHalfDiagonalM.toFixed(0)} m
            </p>
          </article>
        </>
      )}
    </section>
  );
}
