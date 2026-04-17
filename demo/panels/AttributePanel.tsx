import React from "react";
import { useDemoCanvas } from "../DemoContext";
import { ATTRIBUTE_PROFILES } from "../constants";
import type { AttributeProfile } from "../constants";

export function AttributePanel() {
  const { isCustomProfile, attributeProfile, setAttributeProfile } = useDemoCanvas();

  return (
    <div className={`pf-panel ${!isCustomProfile ? "pf-panel-disabled" : ""}`}>
      <div className="pf-panel-title">Attribute Profile</div>
      {!isCustomProfile && <p className="pf-benchmark-hint">Set by profile</p>}
      <div className="pf-button-row">
        {(Object.keys(ATTRIBUTE_PROFILES) as AttributeProfile[]).map((profile) => (
          <button
            key={profile}
            className={`pf-btn ${attributeProfile === profile ? "is-active" : ""}`}
            type="button"
            onClick={() => setAttributeProfile(profile)}
            disabled={!isCustomProfile}
          >
            {ATTRIBUTE_PROFILES[profile].label}
          </button>
        ))}
      </div>
    </div>
  );
}
