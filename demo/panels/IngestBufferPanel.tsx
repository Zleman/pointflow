import React from "react";
import { useDemoCanvas } from "../DemoContext";

export function IngestBufferPanel() {
  const {
    isCustomProfile,
    customPointsPerChunk,
    setCustomPointsPerChunk,
    customIntervalMs,
    setCustomIntervalMs,
    customMaxPoints,
    setCustomMaxPoints,
    useDynamicAlloc,
    setUseDynamicAlloc,
    streaming,
    benchmarkRunning
  } = useDemoCanvas();

  const disabled = !isCustomProfile || streaming || benchmarkRunning;

  return (
    <div className={`pf-panel ${!isCustomProfile ? "pf-panel-disabled" : ""}`}>
      <div className="pf-panel-title">Ingest & Buffer</div>
      {!isCustomProfile && <p className="pf-benchmark-hint">Set by profile</p>}
      <div className="pf-button-row" style={{ flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <label className="pf-benchmark-profile-label">
          <span>Points per chunk</span>
          <input
            type="number"
            min={10}
            max={2000}
            value={customPointsPerChunk}
            onChange={(e) => setCustomPointsPerChunk(Number(e.target.value))}
            disabled={disabled}
            className="pf-benchmark-select"
            style={{ width: 100 }}
          />
        </label>
        <label className="pf-benchmark-profile-label">
          <span>Interval (ms)</span>
          <input
            type="number"
            min={10}
            max={500}
            value={customIntervalMs}
            onChange={(e) => setCustomIntervalMs(Number(e.target.value))}
            disabled={disabled}
            className="pf-benchmark-select"
            style={{ width: 72 }}
          />
        </label>
        <span className="pf-benchmark-hint" style={{ marginBottom: 0 }}>
          ≈ {Math.round((1000 * customPointsPerChunk) / customIntervalMs).toLocaleString()} pts/s
        </span>
        <label className="pf-benchmark-profile-label">
          <span>Max buffer</span>
          <input
            type="number"
            min={1000}
            max={5_000_000}
            step={10000}
            value={customMaxPoints}
            onChange={(e) => setCustomMaxPoints(Number(e.target.value))}
            disabled={disabled}
            className="pf-benchmark-select"
            style={{ width: 110 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={useDynamicAlloc}
            onChange={(e) => setUseDynamicAlloc(e.target.checked)}
            disabled={streaming || benchmarkRunning}
          />
          <span>Dynamic allocation</span>
        </label>
      </div>
    </div>
  );
}
