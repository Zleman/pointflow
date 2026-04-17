import React from "react";
import { useDemoCanvas, useDemoHud } from "../DemoContext";

function fmtAge(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

export function TemporalPanel() {
  const { timeWindowMs, setTimeWindowMs, streaming, benchmarkRunning } = useDemoCanvas();
  const { temporalStats } = useDemoHud();

  const disabled = streaming || benchmarkRunning;

  return (
    <div className="pf-panel">
      <div className="pf-panel-title">Temporal Window - M12</div>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#94a3b8" }}>
        Show only points ingested within the last N ms. Buffer retains all points - only the render stage filters.
      </p>

      <label className="pf-benchmark-profile-label">
        <span>Time window</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="range"
            min={0}
            max={30_000}
            step={500}
            value={timeWindowMs}
            onChange={(e) => setTimeWindowMs(Number(e.target.value))}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: "#94a3b8", minWidth: 48, textAlign: "right" }}>
            {timeWindowMs === 0 ? "all" : fmtAge(timeWindowMs)}
          </span>
        </div>
      </label>

      {temporalStats && (
        <div style={{
          marginTop: 10,
          background: "#0f172a",
          borderRadius: 6,
          padding: "6px 10px",
          border: "1px solid #334155",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "4px 12px",
          fontSize: 11,
          color: "#94a3b8",
        }}>
          <span>Oldest point</span>
          <span style={{ color: "#cbd5e1", textAlign: "right" }}>
            {fmtAge(temporalStats.oldestPointAgeMs)}
          </span>
          <span>Newest point</span>
          <span style={{ color: "#cbd5e1", textAlign: "right" }}>
            {fmtAge(temporalStats.newestPointAgeMs)}
          </span>
          <span>In window</span>
          <span style={{ color: timeWindowMs > 0 ? "#4ade80" : "#cbd5e1", textAlign: "right" }}>
            {temporalStats.windowedCount.toLocaleString()}
            {timeWindowMs > 0 && temporalStats.totalCount > 0 && (
              <> / {temporalStats.totalCount.toLocaleString()}</>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
