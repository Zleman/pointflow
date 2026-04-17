import React from "react";

export function TestSuitePanel() {
  return (
    <div className="pf-panel pf-benchmark-panel" style={{ gridColumn: "1 / -1" }}>
      <div className="pf-panel-title">Test Suite</div>
      <p className="pf-benchmark-hint">Suite runner removed. Use the stream controls to run individual benchmarks.</p>
    </div>
  );
}
