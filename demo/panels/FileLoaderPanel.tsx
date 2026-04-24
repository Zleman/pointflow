import React, { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { useFileState, useFileDispatch } from "../contexts/FileContext";
import { useDemoCanvas } from "../DemoContext";
import { isCopcDatasetUrl } from "../utils";
import { colorByKeysFromAttributes } from "../colorByOptions";
import { buildFileSourceFromDisk } from "./file-loader/file-handlers";
import { FileLoaderView } from "./file-loader/FileLoaderView";
import { generateRainbowXYZ, generateSpiralXYZ } from "./file-loader/sample-generators";

const SAMPLE_POINT_COUNT = 500_000;
const PUBLIC_DATASETS: { label: string; url: string; colorBy: string }[] = [
  {
    label: "Autzen (COPC ~110M)",
    url: "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz",
    colorBy: "classification",
  },
];

export function FileLoaderPanel() {
  const { src, label, status, progress, colorBy, pointCount, availableAttributes } = useFileState();
  const dispatch = useFileDispatch();
  const { copyFileReport } = useDemoCanvas();
  const [urlInput, setUrlInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const sampleBlobRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleLoad = () => {
    const url = urlInput.trim();
    if (!url) return;
    if (isCopcDatasetUrl(url)) {
      dispatch({ type: "SET_COLOR_BY", colorBy: "classification" });
    }
    dispatch({ type: "SET_SRC", src: url, label: url });
  };

  const handleFileFromDisk = useCallback((file: File) => {
    const source = buildFileSourceFromDisk(file);
    dispatch({ type: "SET_SRC", src: source.src, label: source.label });
    if (source.shouldPreferClassification) {
      dispatch({ type: "SET_COLOR_BY", colorBy: "classification" });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [dispatch]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    handleFileFromDisk(file);
  }, [handleFileFromDisk]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    handleFileFromDisk(file);
  }, [handleFileFromDisk]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const makeSampleBlob = (text: string, nextColorBy: string, nextLabel: string) => {
    setGenerating(true);
    setTimeout(() => {
      if (sampleBlobRef.current) URL.revokeObjectURL(sampleBlobRef.current);
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      sampleBlobRef.current = url;
      dispatch({ type: "SET_COLOR_BY", colorBy: nextColorBy });
      dispatch({ type: "SET_SRC", src: url, label: nextLabel });
      setGenerating(false);
    }, 10);
  };

  const handleClear = () => {
    dispatch({ type: "SET_SRC", src: null, label: null });
    setUrlInput("");
  };

  const isLoading = status === "loading";
  const isReady = status === "ready";
  const isError = status === "error";
  const statusColor: React.CSSProperties["color"] =
    isReady ? "#4ade80" : isError ? "#f87171" : isLoading ? "#fbbf24" : "#94a3b8";
  const progressPct = Math.round(progress * 100);

  const colorByKeys = useMemo(
    () => colorByKeysFromAttributes(availableAttributes),
    [availableAttributes]
  );

  useEffect(() => {
    if (colorByKeys.length === 0) return;
    if (colorByKeys.includes(colorBy)) return;
    dispatch({ type: "SET_COLOR_BY", colorBy: colorByKeys[0] });
  }, [colorByKeys, colorBy, dispatch]);

  const selectValue = colorByKeys.length > 0 && colorByKeys.includes(colorBy)
    ? colorBy
    : colorByKeys[0] ?? "";

  return (
    <FileLoaderView
      src={src}
      label={label}
      status={status}
      progressPct={progressPct}
      colorBy={colorBy}
      pointCount={pointCount}
      colorByKeys={colorByKeys}
      colorByDisabled={colorByKeys.length === 0}
      selectValue={selectValue}
      statusColor={statusColor}
      generating={generating}
      isDragOver={isDragOver}
      fileInputRef={fileInputRef}
      publicDatasets={PUBLIC_DATASETS}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onFileSelect={handleFileSelect}
      onUrlInputChange={setUrlInput}
      onUrlInputKeyDown={(e) => e.key === "Enter" && handleLoad()}
      onLoadUrl={handleLoad}
      onOpenFile={() => fileInputRef.current?.click()}
      onLoadSpiral={() => makeSampleBlob(generateSpiralXYZ(SAMPLE_POINT_COUNT), "intensity", "Spiral sample")}
      onLoadRainbow={() => makeSampleBlob(generateRainbowXYZ(SAMPLE_POINT_COUNT), "rgb", "Rainbow helix")}
      onLoadDataset={(ds) => {
        setUrlInput(ds.url);
        dispatch({ type: "SET_COLOR_BY", colorBy: ds.colorBy });
        dispatch({ type: "SET_SRC", src: ds.url, label: ds.label });
      }}
      onCopyFileReport={() => void copyFileReport()}
      onClear={handleClear}
      onColorByChange={(value) => dispatch({ type: "SET_COLOR_BY", colorBy: value })}
      urlInput={urlInput}
      isLoading={isLoading}
      isReady={isReady}
    />
  );
}
