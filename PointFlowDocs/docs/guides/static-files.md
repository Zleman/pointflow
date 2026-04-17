---
id: static-files
title: Static file loading
sidebar_position: 2
---

# Static file loading

`<PointCloud>` loads static point-cloud files with progressive rendering, off-thread parsing, and automatic format detection.

## Supported formats

| Format | Extension | Notes |
|---|---|---|
| PLY | `.ply` | Binary little-endian, binary big-endian, ASCII |
| XYZ / CSV | `.xyz`, `.csv`, `.txt` | Whitespace or comma-delimited, optional header row |
| LAS | `.las` | LAS 1.0 through 1.4 |
| LAZ | `.laz` | Requires `loaderFactory={createLazLoader}` from `pointflow/laz` |
| COPC | `.copc.laz` | Use `<CopcPointCloud>` from `pointflow/copc` instead |

## Basic usage

```tsx
import { PointCloud } from "pointflow";

<PointCloud
  src="/scans/building.ply"
  colorBy="intensity"
/>
```

Parsing runs in a Web Worker. Points appear progressively as they're parsed. The component re-renders with more points roughly every `chunkSize` points (default: 10,000).

## Source types

`src` accepts any of:

```tsx
// URL string
<PointCloud src="/scan.ply" />
<PointCloud src="https://example.com/scan.ply" />

// File object (from input or drop)
<PointCloud src={fileObject} />

// Blob (from fetch or any pipeline)
const blob = await fetch("/scan.ply").then(r => r.blob());
<PointCloud src={blob} />

// URL or Request instance
<PointCloud src={new URL("https://example.com/scan.ply")} />
<PointCloud src={new Request("https://example.com/scan.ply", { headers: { ... } })} />
```

## File picker

```tsx
import { useState } from "react";
import { PointCloud } from "pointflow";

export function FilePicker() {
  const [src, setSrc] = useState<File | null>(null);

  return (
    <>
      <input
        type="file"
        accept=".ply,.xyz,.las,.laz,.csv,.txt"
        onChange={(e) => setSrc(e.target.files?.[0] ?? null)}
      />
      {src && <PointCloud src={src} colorBy="intensity" />}
    </>
  );
}
```

## Drag and drop

Use `PointCloudDropzone` for a reusable drag-and-drop area:

```tsx
import { PointCloud, PointCloudDropzone } from "pointflow";
import { useState } from "react";

export function DropScene() {
  const [source, setSource] = useState<File | null>(null);

  return (
    <>
      <PointCloudDropzone onSourceChange={setSource} />
      {source && <PointCloud src={source} />}
    </>
  );
}
```

## Loading LAZ files

LAZ support is opt-in. Import `createLazLoader` from `pointflow/laz` and pass it to `loaderFactory`:

```tsx
import { PointCloud } from "pointflow";
import { createLazLoader } from "pointflow/laz";

<PointCloud
  src="/scan.laz"
  loaderFactory={createLazLoader}
  colorBy="intensity"
/>
```

The same `loaderFactory` works for plain `.las` files too. The laz-perf WASM decoder is inlined, so no additional fetches or CDN dependencies.

## Cancellation

Pass `onLoadControls` to get an `abort()` function for a Cancel button:

```tsx
import { useRef } from "react";

export function CancellableScene({ src }) {
  const abortRef = useRef<() => void>(null);

  return (
    <>
      <button onClick={() => abortRef.current?.()}>Cancel</button>
      <PointCloud
        src={src}
        onLoadControls={({ abort }) => { abortRef.current = abort; }}
      />
    </>
  );
}
```

## Load lifecycle

```tsx
<PointCloud
  src={src}
  onLoadTelemetry={(e) => {
    // e.phase: "start" | "header" | "chunk" | "done" | "error" | "abort"
    // e.progress: 0-1 (available on "chunk" and "done" phases)
    console.log(e.phase, Math.round((e.progress ?? 0) * 100) + "%");
  }}
/>
```

For error handling:

```tsx
<PointCloud
  src={src}
  onError={(err) => {
    // err is a PointFlowError with a stable error code
    console.error(err.code, err.message);
  }}
/>
```

See [Error codes](/docs/api/errors) for the full list.

## Tuning chunk size

`chunkSize` controls how many points are parsed and ingested per batch. Smaller values give smoother progressive rendering at the cost of more React updates:

```tsx
<PointCloud
  src="/scan.ply"
  chunkSize={5_000}   // default: 10,000
/>
```

For very large files where you don't need smooth progressivity, increasing `chunkSize` reduces update frequency and speeds up time-to-complete.

## LOD for large files

For files with more than 500,000 points, LOD is auto-enabled. You can override:

```tsx
<PointCloud
  src="/large-scan.ply"
  autoLod={true}         // force on regardless of point count
  lodLevel={1}           // fixed LOD level (0 = finest)
/>
```
