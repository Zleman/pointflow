import React from "react";
import { useDemoCanvas } from "../DemoContext";

export function ImportancePanel() {
  const {
    importanceField, setImportanceField,
    maxStalenessMs, setMaxStalenessMs,
    importanceSamplingEnabled, setImportanceSamplingEnabled,
    attributeProfileConfig,
  } = useDemoCanvas();

  const fieldOptions = attributeProfileConfig.keys;
  const kLookaheadActive = importanceField !== "" || maxStalenessMs > 0;

  return (
    <div className="pf-panel">
      <div className="pf-panel-title">Importance Engine - M8.5</div>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#94a3b8" }}>
        Score: <code>importance × recency</code>. Drives K=16 eviction and GPU stochastic sampling.
      </p>

      <label className="pf-benchmark-profile-label">
        <span>Importance field</span>
        <select
          className="pf-benchmark-select"
          value={importanceField}
          onChange={(e) => setImportanceField(e.target.value)}
        >
          <option value="">None (uniform)</option>
          {fieldOptions.map((k: string) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </label>

      <label className="pf-benchmark-profile-label" style={{ marginTop: 8 }}>
        <span>Staleness half-life</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="range"
            min={0}
            max={30000}
            step={500}
            value={maxStalenessMs}
            onChange={(e) => setMaxStalenessMs(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: "#94a3b8", minWidth: 46, textAlign: "right" }}>
            {maxStalenessMs === 0 ? "off" : `${(maxStalenessMs / 1000).toFixed(1)}s`}
          </span>
        </div>
      </label>

      <label className="pf-benchmark-profile-label" style={{ marginTop: 8 }}>
        <span>GPU stochastic sampling</span>
        <input
          type="checkbox"
          checked={importanceSamplingEnabled}
          onChange={(e) => setImportanceSamplingEnabled(e.target.checked)}
        />
      </label>

      <div style={{ marginTop: 8, fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>
        <div>
          {kLookaheadActive
            ? `K=16 lookahead active${importanceField ? ` · field: ${importanceField}` : " · uniform importance"}${maxStalenessMs > 0 ? ` · recency ${(maxStalenessMs / 1000).toFixed(1)}s` : ""}`
            : "K=16 lookahead off · pure FIFO"}
        </div>
        {importanceSamplingEnabled && (
          <div style={{ color: "#38bdf8" }}>
            GPU sampling active · seed quantized 500ms
          </div>
        )}
      </div>
    </div>
  );
}
