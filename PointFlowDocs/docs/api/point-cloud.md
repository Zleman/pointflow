---
id: point-cloud
title: PointCloud
sidebar_position: 2
---

# PointCloud

Static file loader with progressive rendering. Accepts PLY, XYZ, LAS, and (with `loaderFactory`) LAZ.

```tsx
import { PointCloud } from "pointflow";
```

## Quick example

```tsx
<PointCloud
  src="/scans/building.ply"
  colorBy="intensity"
  maxPoints={2_000_000}
/>
```

## Props

### Required

| Prop | Type | Description |
|---|---|---|
| `src` | `PointCloudSource` | URL string, `File`, `Blob`, `URL`, or `Request`. |

### Capacity

| Prop | Type | Default | Description |
|---|---|---|---|
| `maxPoints` | `number` | From file header, or 1,000,000 | Maximum retained points. Excess points are drop-oldest evicted. |

### Rendering

| Prop | Type | Default | Description |
|---|---|---|---|
| `colorBy` | `string` | First attribute | Attribute key to colour by. |
| `rendererBackend` | `"auto" \| "webgpu" \| "webgl"` | `"auto"` | |
| `frustumCulling` | `boolean` | `true` | |
| `autoLod` | `boolean` | Auto (on above 500k) | |
| `lodLevel` | `number` | `0` | Fixed LOD level. |
| `visualRefreshRateHz` | `number` | `8` | Lower default than streaming because files don't change. |
| `adaptiveRefresh` | `boolean` | `false` | |
| `adaptiveIngest` | `boolean` | `false` | |

### Parser

| Prop | Type | Default | Description |
|---|---|---|---|
| `chunkSize` | `number` | `10_000` | Points parsed per batch. Smaller = smoother progressive rendering. |
| `loaderFactory` | `() => Worker` | Standard loader | Pass `createLazLoader` from `pointflow/laz` to add LAZ support. |

### Point picking

| Prop | Type | Default | Description |
|---|---|---|---|
| `onPointPick` | `(pt: PickedPoint) => void` | `undefined` | |
| `pickRadius` | `number` | `8` | |
| `pickStrategy` | `PickStrategy` | `"highestImportance"` | |

### Lifecycle

| Prop | Type | Description |
|---|---|---|
| `onLoadControls` | `({ abort }) => void` | Receive an `abort()` function for cancellation. |
| `onLoadTelemetry` | `(event) => void` | Per-phase load events: `start`, `header`, `chunk`, `done`, `error`, `abort`. |
| `onError` | `(err: Error) => void` | Called on load failure. |
| `onRendererResolved` | `(backend) => void` | |
| `renderMetricsRef` | `React.MutableRefObject<...>` | |
| `config` | `PointFlowConfig` | |

## PointCloudSource type

```ts
type PointCloudSource = string | URL | Request | File | Blob;
```

## Load telemetry phases

| Phase | When it fires |
|---|---|
| `start` | File fetch or read begins. |
| `header` | File header parsed (format, point count, attributes known). |
| `chunk` | A batch of points ingested. `progress` is 0–1. |
| `done` | All points ingested. `progress` is 1. |
| `error` | Load failed. |
| `abort` | Load cancelled via `abort()`. |

## PointCloudDropzone

`PointCloudDropzone` gives you a drag-and-drop area that feeds into `PointCloud`:

```tsx
import { PointCloud, PointCloudDropzone } from "pointflow";
import { useState } from "react";

export function DropScene() {
  const [src, setSrc] = useState<File | null>(null);

  return (
    <>
      <PointCloudDropzone onSourceChange={setSrc} />
      {src && <PointCloud src={src} />}
    </>
  );
}
```

`PointCloudDropzone` accepts standard HTML div props plus `onSourceChange: (source: File) => void`.
