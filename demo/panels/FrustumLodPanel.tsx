import React from "react";
import { useDemoCanvas, useDemoHud } from "../DemoContext";

export function FrustumLodPanel() {
  const {
    demoMode,
    isCustomProfile,
    frustumCulling, setFrustumCulling,
    autoLod, setAutoLod,
    manualLodLevel, setManualLodLevel,
    adaptiveRefresh, setAdaptiveRefresh,
  } = useDemoCanvas();
  const { effectiveLodLevel, cameraDistance } = useDemoHud();

  const panelInteractive = isCustomProfile || demoMode === "file";

  return (
    <div className={`pf-panel ${!panelInteractive ? "pf-panel-disabled" : ""}`}>
      <div className="pf-panel-title">Frustum & LOD</div>
      {!panelInteractive && <p className="pf-benchmark-hint">Set by profile</p>}
      <div className="pf-button-row" style={{ flexWrap: "wrap", gap: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={frustumCulling}
            onChange={() => setFrustumCulling((v: boolean) => !v)}
            disabled={!panelInteractive}
          />
          Frustum Culling
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={autoLod}
            onChange={() => setAutoLod((v: boolean) => !v)}
            disabled={!panelInteractive}
          />
          Auto LOD
        </label>
        <label title="Throttle visual updates under load; not for deterministic benchmarks." style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={adaptiveRefresh}
            onChange={() => setAdaptiveRefresh((v: boolean) => !v)}
            disabled={!panelInteractive}
          />
          Adaptive refresh
        </label>
        {!autoLod && (
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            Manual LOD:
            <input
              type="range"
              min={0}
              max={2}
              value={manualLodLevel}
              onChange={(e) => setManualLodLevel(Number(e.target.value))}
              style={{ width: 80 }}
              disabled={!panelInteractive}
            />
            <span>{manualLodLevel}</span>
          </label>
        )}
        <span style={{ marginLeft: 16, fontWeight: 500 }}>
          Frustum: <span style={{ color: frustumCulling ? "#52c7ff" : "#a9bdd9" }}>{frustumCulling ? "ON" : "OFF"}</span>
          , LOD: <span style={{ color: autoLod ? "#52c7ff" : "#a9bdd9" }}>{autoLod ? `auto (${effectiveLodLevel})` : `manual (${manualLodLevel})`}</span>
          , cam: <span style={{ color: "#52c7ff" }}>{cameraDistance.toFixed(1)}</span>
        </span>
      </div>
    </div>
  );
}
