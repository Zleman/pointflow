import React from "react";
import { useDemoCanvas } from "../DemoContext";

export function ColorPanel() {
  const { attributeProfileConfig, colorBy, setColorBy } = useDemoCanvas();

  return (
    <div className="pf-panel">
      <div className="pf-panel-title">Color Channel</div>
      <div className="pf-button-row">
        {attributeProfileConfig.keys.map((key: string) => (
          <button
            key={key}
            className={`pf-btn ${colorBy === key ? "is-active" : ""}`}
            type="button"
            onClick={() => setColorBy(key)}
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
