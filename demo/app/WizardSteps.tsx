import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COMPARE_INTERVAL_MS_MAX,
  COMPARE_INTERVAL_MS_MIN,
  COMPARE_POINTS_PER_CHUNK_MAX,
  COMPARE_POINTS_PER_CHUNK_MIN,
  parseCompareBoundedInt,
} from "../compare-input";
import { useDemoCanvas } from "../DemoContext";
import { useCanvasConfig, useCanvasConfigDispatch } from "../contexts/CanvasConfigContext";
import { useFileDispatch, useFileState } from "../contexts/FileContext";
import { isCopcDatasetUrl, isDemoRemoteUrlAllowed } from "../utils";
import {
  ATTRIBUTE_KEY_LABELS,
  DEMO_BACKEND_OPTIONS,
  DEMO_COMPARE_COLOR_BY_OPTIONS,
  DEMO_COMPARE_IMPORTANCE_OPTIONS,
  DEMO_COMPARE_MAX_POINTS_OPTIONS,
  DEMO_IMPORTANCE_FIELD_OPTIONS,
  DEMO_MANUAL_LOD_OPTIONS,
  DEMO_ON_OFF_OPTIONS,
  DEMO_RUNTIME_MODE_OPTIONS,
  DEMO_STREAM_SHAPE_OPTIONS,
  FILE_LOAD_STATUS_LABELS,
} from "../ui-options";
import { generateSpiralXYZ } from "../panels/file-loader/sample-generators";
import type { MockStreamShape } from "../utils";
import { colorByKeysFromAttributes } from "../colorByOptions";

const LABS_URL_STORAGE_KEY = "pointflow-demo-labs-arbitrary-url";

const BG_PRESETS = [
  { hex: "#0d1117", label: "Near black" },
  { hex: "#111111", label: "Dark" },
  { hex: "#404040", label: "Dark grey" },
  { hex: "#1e2735", label: "Navy" },
  { hex: "#ffffff", label: "White" },
];

function BgColorPicker() {
  const { canvasBg } = useCanvasConfig();
  const dispatch = useCanvasConfigDispatch();
  const [hexInput, setHexInput] = useState(canvasBg);
  const applyHex = useCallback((raw: string) => {
    const val = raw.startsWith("#") ? raw : "#" + raw;
    if (/^#[0-9a-fA-F]{6}$/.test(val)) dispatch({ type: "SET_CANVAS_BG", value: val });
  }, [dispatch]);
  return (
    <div className="bg-color-picker">
      <span className="bg-color-label">Canvas background</span>
      <div className="bg-presets">
        {BG_PRESETS.map((p) => (
          <button
            key={p.hex}
            type="button"
            className={`bg-swatch${canvasBg === p.hex ? " active" : ""}`}
            style={{ background: p.hex }}
            aria-label={p.label}
            title={p.label}
            onClick={() => { dispatch({ type: "SET_CANVAS_BG", value: p.hex }); setHexInput(p.hex); }}
          />
        ))}
        <input
          type="text"
          className="bg-hex-input"
          value={hexInput}
          maxLength={7}
          placeholder="#rrggbb"
          onChange={(e) => setHexInput(e.target.value)}
          onBlur={() => applyHex(hexInput)}
          onKeyDown={(e) => { if (e.key === "Enter") applyHex(hexInput); }}
          aria-label="Custom hex colour"
        />
      </div>
    </div>
  );
}

const PUBLIC_DATASETS = [
  {
    label: "Autzen COPC",
    url: "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz",
    colorBy: "classification",
  },
] as const;

const SAMPLE_DATASET_ATTRIBUTION = {
  title: "Autzen classified (COPC)",
  sourceLabel: "PDAL sample data",
  sourceUrl: "https://github.com/PDAL/data",
  licenseLabel: "Upstream repository (terms)",
  licenseUrl: "https://github.com/PDAL/data",
  mirrorNote: "This demo fetches a public COPC mirror (Hobu-hosted bucket used in PDAL/COPC examples).",
} as const;

export function ModeStep() {
  const { demoMode } = useCanvasConfig();
  const { setDemoMode, streaming, benchmarkRunning, compareStreaming } = useDemoCanvas();
  const disabled = streaming || benchmarkRunning || compareStreaming;
  const modes: Array<{ id: "stream" | "file" | "compare"; title: string; subtitle: string }> = [
    { id: "stream", title: "Live Stream", subtitle: "Stress ingest, runtime policies, and renderer behavior." },
    { id: "file", title: "File Explorer", subtitle: "Load PLY/XYZ/COPC and inspect progressive rendering." },
    { id: "compare", title: "A/B Compare", subtitle: "FIFO vs importance engine in side-by-side canvases." },
  ];
  return (
    <section className="wizard-card">
      <div className="mode-grid" role="group" aria-label="Demo mode">
        {modes.map((mode) => (
          <button
            key={mode.id}
            className={`mode-tile ${demoMode === mode.id ? "active" : ""}`}
            type="button"
            onClick={() => setDemoMode(mode.id)}
            disabled={disabled && demoMode !== mode.id}
            aria-pressed={demoMode === mode.id}
            aria-label={`${mode.title}. ${mode.subtitle}`}
          >
            <strong>{mode.title}</strong>
            <span>{mode.subtitle}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function StreamControlsStep() {
  const canvas = useDemoCanvas();
  const dispatch = useCanvasConfigDispatch();
  const {
    maxPoints, manualLodLevel, runtimeMode, adaptiveRefresh, workerCulling,
    importanceField, maxStalenessMs, importanceSamplingEnabled, timeWindowMs,
    requestedBackend,
    setRequestedBackend,
    streamShape,
    setStreamShape,
    frustumCulling,
    setFrustumCulling,
    workerMode,
    setWorkerMode,
    autoLod,
    setAutoLod,
    colorBy,
    setColorBy,
  } = canvas;
  const isCustom = canvas.benchmarkProfileId === "custom";
  return (
    <section className="wizard-card">
      <div className="button-row wrap" style={{ marginBottom: 8 }}>
        <button type="button" onClick={() => {
          dispatch({ type: "SET_RUNTIME_MODE", value: "balanced" });
          dispatch({ type: "SET_FRUSTUM_CULLING", value: true });
          dispatch({ type: "SET_AUTO_LOD", value: true });
          dispatch({ type: "SET_ADAPTIVE_REFRESH", value: false });
          dispatch({ type: "SET_WORKER_MODE", value: true });
          dispatch({ type: "SET_WORKER_CULLING", value: false });
          dispatch({ type: "SET_USE_DYNAMIC_ALLOC", value: false });
          dispatch({ type: "SET_MAX_POINTS", value: 200_000 });
          canvas.setBenchmarkProfileId("normal");
        }}>Preset: Balanced</button>
        <button type="button" onClick={() => {
          dispatch({ type: "SET_RUNTIME_MODE", value: "max_throughput" });
          dispatch({ type: "SET_FRUSTUM_CULLING", value: true });
          dispatch({ type: "SET_AUTO_LOD", value: true });
          dispatch({ type: "SET_ADAPTIVE_REFRESH", value: true });
          dispatch({ type: "SET_WORKER_MODE", value: true });
          dispatch({ type: "SET_WORKER_CULLING", value: true });
          dispatch({ type: "SET_USE_DYNAMIC_ALLOC", value: true });
          dispatch({ type: "SET_MAX_POINTS", value: 1_000_000 });
          canvas.setBenchmarkProfileId("extreme");
        }}>Preset: Stress</button>
        <button type="button" onClick={() => canvas.setBenchmarkProfileId("custom")}>Preset: Custom</button>
      </div>
      <div className="form-grid">
        <label>
          Backend
          <select value={requestedBackend} onChange={(e) => setRequestedBackend(e.target.value as "auto" | "webgl" | "webgpu")}>
            {DEMO_BACKEND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Color by
          <select value={colorBy} onChange={(e) => setColorBy(e.target.value)}>
            <option value="velocity">Velocity</option>
            <option value="intensity">Intensity</option>
            <option value="temperature">Temperature</option>
            <option value="pressure">Pressure</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>
          Stream shape
          <select value={streamShape} onChange={(e) => setStreamShape(e.target.value as MockStreamShape)}>
            {DEMO_STREAM_SHAPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Auto LOD
          <select value={autoLod ? "on" : "off"} onChange={(e) => setAutoLod(e.target.value === "on")}>
            {DEMO_ON_OFF_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Frustum culling
          <select value={frustumCulling ? "on" : "off"} onChange={(e) => setFrustumCulling(e.target.value === "on")}>
            {DEMO_ON_OFF_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Worker ingest
          <select value={workerMode ? "on" : "off"} onChange={(e) => setWorkerMode(e.target.value === "on")}>
            {DEMO_ON_OFF_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>
      {isCustom && (
      <div className="custom-params">
        <p className="custom-params-label">Benchmark parameters</p>
        <div className="form-grid">
          <label>
            Duration sec
            <input
              type="number"
              min={5}
              max={300}
              value={canvas.customDurationSec}
              onChange={(e) => canvas.setCustomDurationSec(Number(e.target.value))}
              disabled={!isCustom}
            />
          </label>
          <label>
            Points/chunk
            <input
              type="number"
              min={1}
              max={10000}
              value={canvas.customPointsPerChunk}
              onChange={(e) => canvas.setCustomPointsPerChunk(Number(e.target.value))}
              disabled={!isCustom}
            />
          </label>
          <label>
            Interval ms
            <input
              type="number"
              min={1}
              max={5000}
              value={canvas.customIntervalMs}
              onChange={(e) => canvas.setCustomIntervalMs(Number(e.target.value))}
              disabled={!isCustom}
            />
          </label>
          <label>
            Max points
            <input
              type="number"
              min={1000}
              max={10_000_000}
              step={10000}
              value={maxPoints}
              onChange={(e) => dispatch({ type: "SET_MAX_POINTS", value: Number(e.target.value) })}
              disabled={!isCustom}
            />
          </label>
        </div>
      </div>
      )}
      {isCustom && (
        <div className="form-grid advanced-grid">
          <label>
            Runtime mode
            <select value={runtimeMode} onChange={(e) => dispatch({ type: "SET_RUNTIME_MODE", value: e.target.value as "eco" | "balanced" | "max_throughput" | "custom" })}>
              {DEMO_RUNTIME_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            Manual LOD level
            <select value={manualLodLevel} onChange={(e) => dispatch({ type: "SET_MANUAL_LOD_LEVEL", value: Number(e.target.value) })}>
              {DEMO_MANUAL_LOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            Adaptive refresh
            <select value={adaptiveRefresh ? "on" : "off"} onChange={(e) => dispatch({ type: "SET_ADAPTIVE_REFRESH", value: e.target.value === "on" })}>
              {DEMO_ON_OFF_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            Worker culling
            <select value={workerCulling ? "on" : "off"} onChange={(e) => dispatch({ type: "SET_WORKER_CULLING", value: e.target.value === "on" })}>
              {DEMO_ON_OFF_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            Importance field
            <select value={importanceField || ""} onChange={(e) => dispatch({ type: "SET_IMPORTANCE_FIELD", value: e.target.value })}>
              {DEMO_IMPORTANCE_FIELD_OPTIONS.map((o) => (
                <option key={o.value === "" ? "__none__" : o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            Staleness half-life (ms)
            <input
              type="number"
              min={0}
              max={60000}
              step={500}
              value={maxStalenessMs}
              onChange={(e) => dispatch({ type: "SET_MAX_STALENESS_MS", value: Number(e.target.value) })}
            />
          </label>
          <label>
            GPU importance sampling
            <select value={importanceSamplingEnabled ? "on" : "off"} onChange={(e) => dispatch({ type: "SET_IMPORTANCE_SAMPLING", value: e.target.value === "on" })}>
              {DEMO_ON_OFF_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            Time window (ms)
            <input
              type="number"
              min={0}
              max={60000}
              step={500}
              value={timeWindowMs}
              onChange={(e) => dispatch({ type: "SET_TIME_WINDOW_MS", value: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      <BgColorPicker />
    </section>
  );
}

export function FileControlsStep() {
  const fileState = useFileState();
  const fileDispatch = useFileDispatch();
  const canvas = useDemoCanvas();
  const [urlInput, setUrlInput] = useState("");
  const [urlPolicyHint, setUrlPolicyHint] = useState<string | null>(null);
  const [labsArbitraryUrl, setLabsArbitraryUrl] = useState(() => {
    try {
      return localStorage.getItem(LABS_URL_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const allowedRemoteUrls = useMemo(() => PUBLIC_DATASETS.map((d) => d.url), []);
  const setLabs = useCallback((on: boolean) => {
    setLabsArbitraryUrl(on);
    try {
      if (on) localStorage.setItem(LABS_URL_STORAGE_KEY, "1");
      else localStorage.removeItem(LABS_URL_STORAGE_KEY);
    } catch {
    }
    setUrlPolicyHint(null);
  }, []);
  const loadUrl = useCallback(() => {
    const url = urlInput.trim();
    if (!url) return;
    if (!labsArbitraryUrl && !isDemoRemoteUrlAllowed(url, allowedRemoteUrls)) {
      setUrlPolicyHint(
        "Only bundled sample URLs are allowed here. Enable “Arbitrary URLs (Labs)” to load other http(s) links -use only with trusted data.",
      );
      return;
    }
    setUrlPolicyHint(null);
    fileDispatch({ type: "SET_COLOR_BY", colorBy: isCopcDatasetUrl(url) ? "classification" : "intensity" });
    fileDispatch({ type: "SET_SRC", src: url, label: url });
  }, [allowedRemoteUrls, fileDispatch, labsArbitraryUrl, urlInput]);

  const loadSpiral = useCallback(() => {
    const blob = new Blob([generateSpiralXYZ(500_000)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    fileDispatch({ type: "SET_COLOR_BY", colorBy: "intensity" });
    fileDispatch({ type: "SET_SRC", src: url, label: "Spiral sample" });
  }, [fileDispatch]);

  const loadLocalFile = useCallback((file: File) => {
    const nameLower = file.name.toLowerCase();
    const isCopc = nameLower.endsWith(".copc.laz") || nameLower.includes(".copc.");
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const blob = URL.createObjectURL(file);
    const hint = isCopc ? "#.copc.laz" : ((ext === "las" || ext === "laz" || ext === "pcd" || ext === "e57") ? `#.${ext}` : "");
    fileDispatch({ type: "SET_COLOR_BY", colorBy: isCopc || ext === "las" || ext === "laz" ? "classification" : "intensity" });
    fileDispatch({ type: "SET_SRC", src: blob + hint, label: file.name });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [fileDispatch]);

  const retryFileLoad = useCallback(() => {
    const { src, label } = fileState;
    if (!src) return;
    fileDispatch({ type: "DISMISS_FILE_ERROR" });
    window.setTimeout(() => fileDispatch({ type: "SET_SRC", src, label }), 0);
  }, [fileDispatch, fileState]);

  const fileColorOptions = useMemo(
    () => colorByKeysFromAttributes(fileState.availableAttributes),
    [fileState.availableAttributes]
  );

  useEffect(() => {
    if (fileColorOptions.length === 0) return;
    if (fileColorOptions.includes(fileState.colorBy)) return;
    fileDispatch({ type: "SET_COLOR_BY", colorBy: fileColorOptions[0] });
  }, [fileColorOptions, fileState.colorBy, fileDispatch]);

  return (
    <section className="wizard-card">
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        accept=".las,.laz,.copc.laz,.ply,.pcd,.e57,.xyz,.csv,.txt"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) loadLocalFile(file);
        }}
      />
      <div className="form-grid single">
        <label htmlFor="file-dataset-url">
          Remote dataset URL
          <input
            id="file-dataset-url"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              if (urlPolicyHint) setUrlPolicyHint(null);
            }}
            onKeyDown={(e) => { if (e.key === "Enter") loadUrl(); }}
            placeholder="https://.../scan.copc.laz"
            autoComplete="off"
          />
        </label>
      </div>
      {urlPolicyHint && (
        <div className="file-policy-hint" role="status">
          {urlPolicyHint}
        </div>
      )}
      <div className="labs-url-row">
        <input
          id="file-labs-arbitrary-url"
          type="checkbox"
          checked={labsArbitraryUrl}
          onChange={(e) => setLabs(e.target.checked)}
        />
        <label htmlFor="file-labs-arbitrary-url">
          Arbitrary URLs (Labs). Lets the browser request any http(s) URL you paste -only use with trusted hosts; not suitable for public deployments without a proxy.
        </label>
      </div>
      <div className="button-row wrap file-step-actions">
        <button type="button" onClick={loadUrl}>Load URL</button>
        <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="Open local point cloud file from disk">
          Open Local File
        </button>
        <button type="button" onClick={loadSpiral}>Load Spiral Sample</button>
        {PUBLIC_DATASETS.map((ds) => (
          <button
            key={ds.url}
            type="button"
            aria-label={`Load sample ${ds.label}`}
            onClick={() => {
              fileDispatch({ type: "SET_COLOR_BY", colorBy: ds.colorBy });
              fileDispatch({ type: "SET_SRC", src: ds.url, label: ds.label });
              setUrlInput(ds.url);
              setUrlPolicyHint(null);
            }}
          >
            {ds.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => fileDispatch({ type: "SET_SRC", src: null, label: null })}
          disabled={!fileState.src}
        >
          Clear
        </button>
        <button type="button" onClick={() => void canvas.copyFileReport()} disabled={!fileState.src} aria-label="Copy file diagnostics report">
          Copy File Report
        </button>
      </div>
      {fileState.status === "error" && fileState.errorMessage && (
        <div className="file-error-alert" role="alert">
          <div className="file-error-alert-body">
            <span>{fileState.errorMessage}</span>
            <button
              type="button"
              className="file-error-dismiss"
              onClick={() => fileDispatch({ type: "DISMISS_FILE_ERROR" })}
              aria-label="Dismiss load error"
            >
              ×
            </button>
          </div>
          <div className="button-row wrap" style={{ marginTop: 8 }}>
            {fileState.src && (
              <button type="button" className="btn-primary" onClick={retryFileLoad}>
                Retry load
              </button>
            )}
            <button
              type="button"
              onClick={() => fileDispatch({ type: "SET_SRC", src: null, label: null })}
            >
              Clear dataset
            </button>
          </div>
        </div>
      )}
      <aside className="dataset-attribution" aria-label="Sample dataset attribution">
        <strong>{SAMPLE_DATASET_ATTRIBUTION.title}</strong>
        <p>
          {SAMPLE_DATASET_ATTRIBUTION.mirrorNote}{" "}
          <a href={SAMPLE_DATASET_ATTRIBUTION.sourceUrl} target="_blank" rel="noreferrer">
            {SAMPLE_DATASET_ATTRIBUTION.sourceLabel}
          </a>
          {" · "}
          <a href={SAMPLE_DATASET_ATTRIBUTION.licenseUrl} target="_blank" rel="noreferrer">
            {SAMPLE_DATASET_ATTRIBUTION.licenseLabel}
          </a>
        </p>
      </aside>
      <p className="status-line">
        Status: {FILE_LOAD_STATUS_LABELS[fileState.status]}{fileState.status === "loading" ? ` (${Math.round(fileState.progress * 100)}%)` : ""}
        {fileState.label && <span style={{ marginLeft: 8, opacity: 0.6, fontWeight: "normal", fontSize: "0.9em" }}>{fileState.label}</span>}
      </p>
      <div className="form-grid" style={{ marginTop: 6 }}>
        <label htmlFor="file-color-by">
          Color by
          <select
            id="file-color-by"
            value={fileColorOptions.length > 0 ? fileState.colorBy : ""}
            disabled={fileColorOptions.length === 0}
            onChange={(e) => fileDispatch({ type: "SET_COLOR_BY", colorBy: e.target.value })}
          >
            {fileColorOptions.length === 0
              ? <option value="">Loading…</option>
              : fileColorOptions.map((key) => (
                  <option key={key} value={key}>{ATTRIBUTE_KEY_LABELS[key] ?? key}</option>
                ))
            }
          </select>
        </label>
      </div>
    </section>
  );
}

export function CompareControlsStep() {
  const canvas = useDemoCanvas();
  return (
    <section className="wizard-card">
      <div className="form-grid">
        <label>
          Max points
          <select value={canvas.compareMaxPoints} onChange={(e) => canvas.setCompareMaxPoints(Number(e.target.value))}>
            {DEMO_COMPARE_MAX_POINTS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Color by
          <select value={canvas.compareColorBy} onChange={(e) => canvas.setCompareColorBy(e.target.value)}>
            {DEMO_COMPARE_COLOR_BY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Ingest points/chunk
          <input
            type="number"
            min={COMPARE_POINTS_PER_CHUNK_MIN}
            max={COMPARE_POINTS_PER_CHUNK_MAX}
            step={10}
            value={canvas.comparePointsPerChunk}
            onChange={(e) => {
              const parsed = parseCompareBoundedInt(
                e.target.value,
                COMPARE_POINTS_PER_CHUNK_MIN,
                COMPARE_POINTS_PER_CHUNK_MAX
              );
              if (parsed !== null) canvas.setComparePointsPerChunk(parsed);
            }}
          />
        </label>
        <label>
          Interval ms
          <input
            type="number"
            min={COMPARE_INTERVAL_MS_MIN}
            max={COMPARE_INTERVAL_MS_MAX}
            value={canvas.compareIntervalMs}
            onChange={(e) => {
              const parsed = parseCompareBoundedInt(
                e.target.value,
                COMPARE_INTERVAL_MS_MIN,
                COMPARE_INTERVAL_MS_MAX
              );
              if (parsed !== null) canvas.setCompareIntervalMs(parsed);
            }}
          />
        </label>
        <label>
          Importance field
          <select value={canvas.compareImportanceField || ""} onChange={(e) => canvas.setCompareImportanceField(e.target.value)}>
            {DEMO_COMPARE_IMPORTANCE_OPTIONS.map((o) => (
              <option key={o.value === "" ? "__none__" : o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Staleness (ms)
          <input
            type="number"
            min={0}
            max={20000}
            step={500}
            value={canvas.compareMaxStalenessMs}
            onChange={(e) => canvas.setCompareMaxStalenessMs(Number(e.target.value))}
          />
        </label>
        <label>
          GPU sampling
          <select value={canvas.compareImportanceSamplingEnabled ? "on" : "off"} onChange={(e) => canvas.setCompareImportanceSamplingEnabled(e.target.value === "on")}>
            {DEMO_ON_OFF_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>
      <BgColorPicker />
    </section>
  );
}

