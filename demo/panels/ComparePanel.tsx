import React from "react";
import { useDemoCanvas, useDemoHud } from "../DemoContext";
import {
  COMPARE_ATTR_KEYS,
  COMPARE_INTERVAL_MS_OPTIONS,
  COMPARE_MAX_POINTS_OPTIONS,
  COMPARE_POINTS_PER_CHUNK_OPTIONS,
} from "./compare-panel-options";
import { getRenderAdvantagePercent } from "./compare-panel-helpers";

export function ComparePanel() {
  const {
    compareStreaming,
    compareLeftReady, compareRightReady,
    compareColorBy, setCompareColorBy,
    compareMaxPoints, setCompareMaxPoints,
    compareImportanceField, setCompareImportanceField,
    compareMaxStalenessMs, setCompareMaxStalenessMs,
    compareImportanceSamplingEnabled, setCompareImportanceSamplingEnabled,
    comparePointsPerChunk, setComparePointsPerChunk,
    compareIntervalMs, setCompareIntervalMs,
    handleCompareStart, handleCompareStop,
    copyCompareReport,
  } = useDemoCanvas();
  const {
    compareIngestRate,
    compareLeftRenderedPoints, compareRightRenderedPoints,
    compareLeftFps, compareRightFps,
    compareLeftStats, compareRightStats,
  } = useDemoHud();

  const bothReady = compareLeftReady && compareRightReady;
  const canStart  = bothReady && !compareStreaming;

  const renderAdvantage = getRenderAdvantagePercent(compareLeftRenderedPoints, compareRightRenderedPoints);

  return (
    <div className="pf-panel" style={{ gridColumn: "span 2" }}>
      <div className="pf-panel-title">Compare - FIFO vs Importance - M11.3</div>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#94a3b8" }}>
        Same ingest stream, two buffers. Left: pure FIFO. Right: K=16 eviction + importance-weighted GPU sampling.
      </p>

      {/* ── Shared settings ─────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        <label className="pf-benchmark-profile-label">
          <span>Max points (each)</span>
          <select
            className="pf-benchmark-select"
            value={compareMaxPoints}
            onChange={(e) => setCompareMaxPoints(Number(e.target.value))}
            disabled={compareStreaming}
          >
            {COMPARE_MAX_POINTS_OPTIONS.map((n) => (
              <option key={n} value={n}>{n.toLocaleString()}</option>
            ))}
          </select>
        </label>

        <label className="pf-benchmark-profile-label">
          <span>Color by</span>
          <select
            className="pf-benchmark-select"
            value={compareColorBy}
            onChange={(e) => setCompareColorBy(e.target.value)}
          >
            {COMPARE_ATTR_KEYS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>

        <label className="pf-benchmark-profile-label">
          <span>Pts / chunk</span>
          <select
            className="pf-benchmark-select"
            value={comparePointsPerChunk}
            onChange={(e) => setComparePointsPerChunk(Number(e.target.value))}
            disabled={compareStreaming}
          >
            {COMPARE_POINTS_PER_CHUNK_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>

        <label className="pf-benchmark-profile-label">
          <span>Interval (ms)</span>
          <select
            className="pf-benchmark-select"
            value={compareIntervalMs}
            onChange={(e) => setCompareIntervalMs(Number(e.target.value))}
            disabled={compareStreaming}
          >
            {COMPARE_INTERVAL_MS_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Right canvas: importance settings ──────────────────────────── */}
      <div style={{
        background: "#0f172a", borderRadius: 6, padding: "8px 10px", marginBottom: 10,
        border: "1px solid #1e40af",
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "#38bdf8", marginBottom: 6 }}>
          RIGHT CANVAS - Importance settings
        </div>

        <label className="pf-benchmark-profile-label">
          <span>Importance field</span>
          <select
            className="pf-benchmark-select"
            value={compareImportanceField}
            onChange={(e) => setCompareImportanceField(e.target.value)}
          >
            <option value="">None (uniform)</option>
            {COMPARE_ATTR_KEYS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>

        <label className="pf-benchmark-profile-label" style={{ marginTop: 6 }}>
          <span>Staleness half-life</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range" min={0} max={30000} step={500}
              value={compareMaxStalenessMs}
              onChange={(e) => setCompareMaxStalenessMs(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 12, color: "#94a3b8", minWidth: 46, textAlign: "right" }}>
              {compareMaxStalenessMs === 0 ? "off" : `${(compareMaxStalenessMs / 1000).toFixed(1)}s`}
            </span>
          </div>
        </label>

        <label className="pf-benchmark-profile-label" style={{ marginTop: 6 }}>
          <span>GPU stochastic sampling</span>
          <input
            type="checkbox"
            checked={compareImportanceSamplingEnabled}
            onChange={(e) => setCompareImportanceSamplingEnabled(e.target.checked)}
          />
        </label>
      </div>

      {/* ── Controls ────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <button
          type="button"
          className={`pf-btn${compareStreaming ? "" : " pf-btn-primary"}`}
          onClick={compareStreaming ? handleCompareStop : handleCompareStart}
          disabled={!bothReady}
          style={{ minWidth: 80 }}
        >
          {compareStreaming ? "Stop" : "Start"}
        </button>

        <button
          type="button"
          className="pf-btn"
          onClick={copyCompareReport}
          title="Copy side-by-side comparison report to clipboard"
        >
          Copy Report
        </button>

        {!bothReady && (
          <span style={{ fontSize: 11, color: "#64748b" }}>
            Waiting for scenes to mount…
          </span>
        )}
        {bothReady && compareStreaming && (
          <span style={{ fontSize: 11, color: "#94a3b8" }}>
            ~{compareIngestRate.toLocaleString()} pts/s
          </span>
        )}
      </div>

      {/* ── Live stats ──────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div style={{ background: "#0f172a", borderRadius: 6, padding: "6px 10px", border: "1px solid #334155" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 4 }}>FIFO</div>
          <div style={{ fontSize: 12, color: "#cbd5e1" }}>
            {compareLeftRenderedPoints.toLocaleString()} rendered · {compareLeftFps.toFixed(1)} fps
          </div>
          <div style={{ fontSize: 11, color: "#64748b" }}>
            {compareLeftStats.totalPoints.toLocaleString()} kept · {compareLeftStats.droppedPoints.toLocaleString()} dropped
          </div>
        </div>

        <div style={{ background: "#0f172a", borderRadius: 6, padding: "6px 10px", border: "1px solid #1e40af" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#38bdf8", marginBottom: 4 }}>K=16 + importance</div>
          <div style={{ fontSize: 12, color: "#cbd5e1" }}>
            {compareRightRenderedPoints.toLocaleString()} rendered · {compareRightFps.toFixed(1)} fps
          </div>
          <div style={{ fontSize: 11, color: "#64748b" }}>
            {compareRightStats.totalPoints.toLocaleString()} kept · {compareRightStats.droppedPoints.toLocaleString()} dropped
          </div>
        </div>
      </div>

      {renderAdvantage !== null && (
        <div style={{ marginTop: 8, fontSize: 12, color: Number(renderAdvantage) >= 0 ? "#4ade80" : "#f87171", textAlign: "center" }}>
          Importance engine renders {Math.abs(Number(renderAdvantage))}% {Number(renderAdvantage) >= 0 ? "more" : "fewer"} points
        </div>
      )}
    </div>
  );
}
