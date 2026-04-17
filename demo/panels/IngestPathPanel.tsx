import React from "react";
import { useDemoCanvas } from "../DemoContext";

export function IngestPathPanel() {
  const { isCustomProfile, workerMode, setWorkerMode, workerCulling, setWorkerCulling } = useDemoCanvas();

  return (
    <div className={`pf-panel ${!isCustomProfile ? "pf-panel-disabled" : ""}`}>
      <div className="pf-panel-title">Ingest Path</div>
      {!isCustomProfile && <p className="pf-benchmark-hint">Set by profile</p>}
      <div className="pf-button-row">
        <button
          className={`pf-btn ${workerMode ? "" : "is-active"}`}
          type="button"
          onClick={() => setWorkerMode(false)}
          disabled={!isCustomProfile}
        >
          Main Thread
        </button>
        <button
          className={`pf-btn ${workerMode ? "is-active" : ""}`}
          type="button"
          onClick={() => setWorkerMode(true)}
          disabled={!isCustomProfile}
        >
          Worker
        </button>
      </div>
      {workerMode && (
        <label title="Only ingest points inside camera frustum; off-screen points are discarded. Not for soak comparison." style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 8 }}>
          <input
            type="checkbox"
            checked={workerCulling}
            onChange={() => setWorkerCulling((v: boolean) => !v)}
            disabled={!isCustomProfile}
          />
          Worker culling
        </label>
      )}
    </div>
  );
}
