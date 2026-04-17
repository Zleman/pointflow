import React, { useRef, useState } from "react";
import type { PointCloudSource } from "../parsers/source-resolver";

export interface PointCloudDropzoneProps {
  onSourceChange: (source: PointCloudSource) => void;
  disabled?: boolean;
  accept?: string;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export function PointCloudDropzone({
  onSourceChange,
  disabled = false,
  accept = ".las,.laz,.copc.laz,.ply,.xyz,.csv,.txt",
  className,
  style,
  children,
}: PointCloudDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const pickFile = (file?: File | null) => {
    if (!file || disabled) return;
    onSourceChange(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div
      className={className}
      style={{
        border: "1px dashed #64748b",
        borderColor: dragOver ? "#38bdf8" : "#64748b",
        borderRadius: 8,
        padding: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
      onClick={() => { if (!disabled) inputRef.current?.click(); }}
      onDragOver={(e) => {
        e.preventDefault();
        if (disabled) return;
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) return;
        pickFile(e.dataTransfer.files?.[0] ?? null);
      }}
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
      />
      {children ?? "Drop a point cloud file or click to open."}
    </div>
  );
}
