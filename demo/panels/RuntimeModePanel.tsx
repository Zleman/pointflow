import React from "react";
import { useDemoCanvas } from "../DemoContext";
import type { RuntimeMode } from "pointflow";

const MODES: { id: RuntimeMode; label: string }[] = [
  { id: "eco", label: "Eco" },
  { id: "balanced", label: "Balanced" },
  { id: "max_throughput", label: "Max" },
];

export function RuntimeModePanel() {
  const { runtimeMode, setRuntimeMode, isCustomProfile } = useDemoCanvas();

  return (
    <div className={`pf-panel ${!isCustomProfile ? "pf-panel-disabled" : ""}`}>
      <div className="pf-panel-title">Runtime mode</div>
      {!isCustomProfile && <p className="pf-benchmark-hint">Set by profile</p>}
      <div className="pf-button-row">
        {MODES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`pf-btn ${runtimeMode === id ? "is-active" : ""}`}
            onClick={() => setRuntimeMode(id)}
            disabled={!isCustomProfile}
            aria-pressed={runtimeMode === id}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
