import React from "react";
import { isCopcDatasetUrl } from "../../utils";
import { colorByOptionTitle } from "./file-handlers";

type DatasetOption = { label: string; url: string; colorBy: string };

export function FileLoaderView(props: {
  src: string | null;
  label: string | null;
  status: "idle" | "loading" | "ready" | "error";
  progressPct: number;
  colorBy: string;
  pointCount: number | null;
  colorByKeys: string[];
  colorByDisabled: boolean;
  selectValue: string;
  statusColor: React.CSSProperties["color"];
  generating: boolean;
  isDragOver: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  publicDatasets: DatasetOption[];
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onUrlInputChange: (value: string) => void;
  onUrlInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onLoadUrl: () => void;
  onOpenFile: () => void;
  onLoadSpiral: () => void;
  onLoadRainbow: () => void;
  onLoadDataset: (dataset: DatasetOption) => void;
  onCopyFileReport: () => void;
  onClear: () => void;
  onColorByChange: (value: string) => void;
  urlInput: string;
  isLoading: boolean;
  isReady: boolean;
}): React.ReactElement {
  const {
    src,
    label,
    status,
    progressPct,
    colorBy,
    pointCount,
    colorByKeys,
    colorByDisabled,
    selectValue,
    statusColor,
    generating,
    isDragOver,
    fileInputRef,
    publicDatasets,
    onDrop,
    onDragOver,
    onDragLeave,
    onFileSelect,
    onUrlInputChange,
    onUrlInputKeyDown,
    onLoadUrl,
    onOpenFile,
    onLoadSpiral,
    onLoadRainbow,
    onLoadDataset,
    onCopyFileReport,
    onClear,
    onColorByChange,
    urlInput,
    isLoading,
    isReady,
  } = props;
  return (
    <div
      className="pf-panel"
      style={{
        gridColumn: "span 2",
        outline: isDragOver ? "2px dashed #38bdf8" : "2px dashed transparent",
        outlineOffset: -2,
        transition: "outline-color 0.1s",
      }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="pf-panel-title">File Loader - M9</div>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#94a3b8" }}>
        Load <strong style={{ color: "#e2e8f0" }}>LAS / LAZ</strong>,{" "}
        <strong style={{ color: "#e2e8f0" }}>COPC (.copc.laz)</strong>, PLY,
        PCD, E57, or XYZ / CSV. Drag a file anywhere onto this panel, use{" "}
        <strong style={{ color: "#e2e8f0" }}>Open file</strong>, or paste a URL.
        LAS/PLY/PCD parse in a worker; E57 uses the dedicated E57 loader; COPC
        streams tiles from the octree index.
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".las,.laz,.copc.laz,.ply,.pcd,.e57,.xyz,.csv,.txt"
        style={{ display: "none" }}
        onChange={onFileSelect}
      />
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          type="text"
          className="pf-benchmark-select"
          placeholder="https://…/scan.las  or  /data/model.ply"
          value={urlInput}
          onChange={(e) => onUrlInputChange(e.target.value)}
          onKeyDown={onUrlInputKeyDown}
          style={{ flex: 1, minWidth: 0 }}
          disabled={isLoading}
        />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <button className="pf-btn pf-btn-primary" type="button" onClick={onLoadUrl} disabled={isLoading || !urlInput.trim()}>
          Load URL
        </button>
        <button className="pf-btn" type="button" onClick={onOpenFile} disabled={isLoading} title="Open LAS, LAZ, COPC (.copc.laz), PLY, PCD, E57, or XYZ from disk">
          Open file
        </button>
        <button className="pf-btn" type="button" onClick={onLoadSpiral} disabled={isLoading || generating} title="Generate a 500k-point synthetic spiral galaxy (intensity)">
          {generating ? "Generating…" : "Spiral"}
        </button>
        <button className="pf-btn" type="button" onClick={onLoadRainbow} disabled={isLoading || generating} title="Generate a 500k-point rainbow double-helix (true RGB colour)">
          Rainbow
        </button>
        {publicDatasets.map((ds) => (
          <button
            key={ds.url}
            className="pf-btn"
            type="button"
            disabled={isLoading}
            title={`${ds.url} - coloured by ${ds.colorBy}`}
            onClick={() => onLoadDataset(ds)}
          >
            {ds.label}
          </button>
        ))}
        {src && isCopcDatasetUrl(src) && (
          <button className="pf-btn" type="button" title="Copy COPC index, geometry, camera, and render metrics to the clipboard" onClick={onCopyFileReport}>
            Copy file report
          </button>
        )}
        {src && (
          <button className="pf-btn" type="button" onClick={onClear} disabled={isLoading}>
            Clear
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
        <span className="pf-badge" style={{ color: statusColor, borderColor: statusColor, minWidth: 60, textAlign: "center" }}>
          {status.toUpperCase()}
        </span>
        {pointCount !== null && (
          <span className="pf-badge">
            {pointCount.toLocaleString()} pts detected
          </span>
        )}
        {label && (
          <span style={{ fontSize: 12, color: "#94a3b8", wordBreak: "break-all", flex: 1 }}>
            {label}
          </span>
        )}
      </div>
      {(isLoading || isReady) && (
        <div style={{ height: 4, background: "#1e293b", borderRadius: 2, marginBottom: 8, overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${progressPct}%`,
              background: isReady ? "#4ade80" : "#38bdf8",
              borderRadius: 2,
              transition: "width 0.15s ease",
            }}
          />
        </div>
      )}
      {isLoading && src && isCopcDatasetUrl(src) && (
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
          {progressPct < 14
            ? "COPC: fetching index (first ~1 MB over the network)…"
            : progressPct < 100
              ? `COPC: streaming tiles - ${progressPct}% of scheduled tiles`
              : "COPC: finishing…"}
        </div>
      )}
      {isLoading && (!src || !isCopcDatasetUrl(src)) && (
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
          {progressPct}% parsed - rendering progressively…
        </div>
      )}
      <label className="pf-benchmark-profile-label" style={{ marginTop: 4 }}>
        <span className="pf-panel-title" style={{ marginBottom: 0 }}>Colour by</span>
        <select
          className="pf-benchmark-select"
          value={colorByDisabled ? "" : selectValue}
          disabled={colorByDisabled}
          title={colorByDisabled ? "Loading…" : colorByOptionTitle(selectValue)}
          aria-label="Colour by attribute"
          onChange={(e) => onColorByChange(e.target.value)}
          style={{ width: "100%", maxWidth: 320, marginTop: 4 }}
        >
          {colorByDisabled
            ? <option value="">Loading…</option>
            : colorByKeys.map((k) => (
                <option key={k} value={k} title={colorByOptionTitle(k)}>
                  {colorByOptionTitle(k)}
                </option>
              ))
          }
        </select>
      </label>
    </div>
  );
}
