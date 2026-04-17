import React from "react";
import { useDemoCanvas } from "../DemoContext";
import type { RendererBackend } from "pointflow";

export function RendererPanel() {
  const { isCustomProfile, requestedBackend, setRequestedBackend } = useDemoCanvas();

  return (
    <div className={`pf-panel ${!isCustomProfile ? "pf-panel-disabled" : ""}`}>
      <div className="pf-panel-title">Renderer</div>
      {!isCustomProfile && <p className="pf-benchmark-hint">Set by profile</p>}
      <div className="pf-button-row">
        {(["webgl", "webgpu", "auto"] as RendererBackend[]).map((backend) => (
          <button
            key={backend}
            className={`pf-btn ${requestedBackend === backend ? "is-active" : ""}`}
            type="button"
            onClick={() => setRequestedBackend(backend)}
            disabled={!isCustomProfile}
          >
            {backend.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
