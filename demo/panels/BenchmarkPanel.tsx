import React from "react";
import { useDemoCanvas } from "../DemoContext";
import type { BenchmarkPassResult, BenchmarkProfileId } from "../benchmark";

export function BenchmarkPanel() {
  type FixedBenchmarkProfileId = Exclude<BenchmarkProfileId, "custom">;
  const {
    streaming,
    benchmarkRunning,
    apiReady,
    benchmarkProfileId,
    setBenchmarkProfileId,
    isCustomProfile,
    customDurationSec,
    setCustomDurationSec,
    lastBenchmarkReport,
    handleStart,
    handleStop,
    copyReport,
    handleExportBenchmarkJson,
    getFixedProfileIds,
    BENCHMARK_PROFILES
  } = useDemoCanvas();

  return (
    <div className="pf-panel pf-benchmark-panel">
      <div className="pf-panel-title">Benchmark</div>
      <p className="pf-benchmark-hint">
        {isCustomProfile
          ? "Custom: set options below and duration. Run benchmark uses your choices."
          : "Profile sets buffer, ingest rate, duration, and options. Choose Custom to override."}
      </p>
      <div className="pf-button-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <label className="pf-benchmark-profile-label">
          <span className="pf-panel-title" style={{ marginBottom: 0 }}>Profile</span>
          <select
            aria-label="Benchmark profile"
            value={benchmarkProfileId}
            onChange={(e) => setBenchmarkProfileId(e.target.value as BenchmarkProfileId)}
            disabled={streaming || benchmarkRunning}
            className="pf-benchmark-select"
          >
            {getFixedProfileIds().map((id: FixedBenchmarkProfileId) => (
              <option key={id} value={id}>
                {BENCHMARK_PROFILES[id].label} ({BENCHMARK_PROFILES[id].durationSec}s)
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        {isCustomProfile && (
          <label className="pf-benchmark-profile-label">
            <span>Duration (s)</span>
            <input
              type="number"
              min={5}
              max={600}
              value={customDurationSec}
              onChange={(e) => setCustomDurationSec(Number(e.target.value))}
              disabled={streaming || benchmarkRunning}
              className="pf-benchmark-select"
              style={{ width: 72 }}
            />
          </label>
        )}
        <button
          className="pf-btn pf-btn-primary"
          type="button"
          onClick={handleStart}
          disabled={streaming || benchmarkRunning || !apiReady}
          aria-label="Run benchmark"
        >
          Run benchmark
        </button>
        <button className="pf-btn" type="button" onClick={handleStop} disabled={!streaming}>
          Stop
        </button>
        <button className="pf-btn" type="button" onClick={() => void copyReport()}>
          Copy Report
        </button>
        <button
          className="pf-btn"
          type="button"
          onClick={handleExportBenchmarkJson}
          disabled={!lastBenchmarkReport}
          aria-label="Export benchmark report as JSON"
        >
          Export JSON
        </button>
      </div>
      {lastBenchmarkReport && lastBenchmarkReport.passes.length > 0 && (
        <div className="pf-benchmark-result" role="region" aria-label="Last benchmark result">
          <div className="pf-benchmark-result-summary">
            {lastBenchmarkReport.passes.length} pass{lastBenchmarkReport.passes.length !== 1 ? "es" : ""}
            {lastBenchmarkReport.multiRunSummary ? (
              <>
                {" · "}
                avg {lastBenchmarkReport.multiRunSummary.avgFrameMsMean.toFixed(2)} ms
                {" · "}
                p95 {lastBenchmarkReport.multiRunSummary.rollingP95MsMean.toFixed(2)} ms
                {" · "}
                hitches 50ms {lastBenchmarkReport.multiRunSummary.hitches50Total}
                {" · "}
                100ms {lastBenchmarkReport.multiRunSummary.hitches100Total}
              </>
            ) : (
              <>
                {" · "}
                avg {lastBenchmarkReport.passes[0].avgFrameMs.toFixed(2)} ms
                {" · "}
                p95 {lastBenchmarkReport.passes[0].rollingP95Ms.toFixed(2)} ms
                {" · "}
                hitches 50ms {lastBenchmarkReport.passes.reduce((s: number, p: BenchmarkPassResult) => s + p.hitches50, 0)}
                {" · "}
                100ms {lastBenchmarkReport.passes.reduce((s: number, p: BenchmarkPassResult) => s + p.hitches100, 0)}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
