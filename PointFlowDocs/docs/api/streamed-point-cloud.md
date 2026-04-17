---
id: streamed-point-cloud
title: StreamedPointCloud
sidebar_position: 1
---

# StreamedPointCloud

The primary component for rendering live point-cloud streams. Handles ingest, buffering, and rendering in one place.

```tsx
import { StreamedPointCloud, type StreamedPointCloudRef } from "pointflow";
```

## Quick example

```tsx
const api = useRef<StreamedPointCloudRef>(null);

<StreamedPointCloud
  maxPoints={200_000}
  colorBy="velocity"
  workerMode={true}
  onReady={(ref) => { api.current = ref; }}
/>

// Push data:
api.current?.pushChunk({ points: [...] });
api.current?.pushBinary(xyzFloat32, attributes, count);
```

## Props

### Capacity

| Prop | Type | Default | Description |
|---|---|---|---|
| `maxPoints` | `number` | — | Hard ceiling on the number of retained points. Required unless you pass a `config` with a streamed or global default. |
| `dynamicAlloc` | `{ initialCapacity?: number; growthFactor?: number }` | `undefined` | Start small and grow toward `maxPoints`. See [Dynamic allocation](/docs/guides/dynamic-allocation). |

### Rendering

| Prop | Type | Default | Description |
|---|---|---|---|
| `colorBy` | `string` | `undefined` | Attribute key to map to a colour gradient. |
| `rendererBackend` | `"auto" \| "webgpu" \| "webgl"` | `"auto"` | Force a renderer or let PointFlow pick. |
| `powerPreference` | `"high-performance" \| "low-power" \| "default"` | `"high-performance"` | GPU power preference hint passed to the WebGPU adapter. `"high-performance"` asks the browser to prefer the discrete GPU on multi-GPU systems. `"low-power"` prefers the integrated GPU. `"default"` lets the browser decide. No-op on the WebGL path. The browser may ignore the hint — for a hard guarantee, use OS-level GPU assignment (Windows Graphics Settings or NVIDIA/AMD control panel). |
| `frustumCulling` | `boolean` | `true` | Discard points outside the camera frustum before upload. |
| `autoLod` | `boolean` | `false` | Automatically pick LOD level by camera distance. |
| `lodLevel` | `number` | `0` | Fixed LOD level when `autoLod` is false. 0 = full detail. |
| `lodLevels` | `number` | `3` | Total number of LOD levels. |
| `visualRefreshRateHz` | `number` | `60` | Target upload rate. Frames are skipped when the renderer is faster. |
| `adaptiveRefresh` | `boolean` | `false` | Reduce upload rate when frame times are long. |
| `background` | `string` | `undefined` | Canvas background colour as a CSS hex string (e.g. `"#0d1117"`). |

### Ingest

| Prop | Type | Default | Description |
|---|---|---|---|
| `workerMode` | `boolean` | `false` | Run chunk processing in a Web Worker. |
| `adaptiveIngest` | `boolean` | `false` | Thin incoming chunks under high buffer pressure. |

### Importance and sampling

| Prop | Type | Default | Description |
|---|---|---|---|
| `importanceField` | `string \| "auto"` | `undefined` | Attribute key for importance scoring. `"auto"` picks from the first chunk. |
| `maxStalenessMs` | `number` | `0` | Recency half-life in milliseconds. |
| `importanceSamplingEnabled` | `boolean` | `false` | GPU stochastic sampling weighted by importance. WebGPU only. |
| `fovStrength` | `number` | `0` | Foveated boost for points near screen center. 0 = off, 3 = strong. WebGPU + importanceSampling only. |
| `accumulationMode` | `boolean` | `false` | Full-detail rendering when camera is static. WebGPU only. |
| `accumulationThresholdMs` | `number` | `200` | Ms camera must be static before accumulation activates. |

### Temporal window

| Prop | Type | Default | Description |
|---|---|---|---|
| `timeWindowMs` | `number` | `0` | Show only points from the last N milliseconds. 0 = all points. |

### Culling

| Prop | Type | Default | Description |
|---|---|---|---|
| `spatialCulling` | `boolean` | `true` | Uniform-grid index for batch frustum tests. Active when frustum culling is on and LOD stride is 1. |
| `workerCulling` | `boolean` | `false` | Filter off-frustum points at ingest time. Permanent discard. |

### Policy

| Prop | Type | Default | Description |
|---|---|---|---|
| `runtimeMode` | `"eco" \| "balanced" \| "max_throughput" \| "custom"` | `"balanced"` | Operating mode. Drives point budget and update cadence. |
| `tier` | `TierLevel` | auto-detected | Hardware capability tier. |
| `constraints` | `UserConstraints` | `undefined` | Hard ceilings for policy decisions. Only applies in `custom` mode. |
| `legacyMode` | `boolean` | `false` | Disable tier/mode/policy and use `maxPoints` directly. |

### Point picking

| Prop | Type | Default | Description |
|---|---|---|---|
| `onPointPick` | `(pt: PickedPoint) => void` | `undefined` | Called on pointer down when a point is found within the radius. |
| `pickRadius` | `number` | `8` | Pick radius in CSS pixels. |
| `pickStrategy` | `"highestImportance" \| "nearest" \| "recentFirst"` | `"highestImportance"` | Which point wins when multiple qualify. |

### Camera

| Prop | Type | Default | Description |
|---|---|---|---|
| `cameraFit` | `{ halfsize: number }` | `undefined` | Auto-fit the camera to the point cloud. `halfsize` is the scene half-extent in world units. |

### Lifecycle and telemetry

| Prop | Type | Default | Description |
|---|---|---|---|
| `onReady` | `(api: StreamedPointCloudRef) => void` | `undefined` | Called once after the GPU pipeline is ready and the first frame has submitted. |
| `onRendererResolved` | `(backend: "webgpu" \| "webgl") => void` | `undefined` | Called once with the resolved backend. |
| `onStats` | `(stats) => void` | `undefined` | Called each frame with buffer fill and backpressure stats. |
| `onRenderMetrics` | `(metrics) => void` | `undefined` | Called each frame with render timing metrics. |
| `renderMetricsRef` | `React.MutableRefObject<...>` | `undefined` | Ref written each frame without triggering React updates. Use with a polling timer. |
| `onTemporalStats` | `(stats) => void` | `undefined` | Called each frame when `timeWindowMs > 0`. |
| `onAccumulationChange` | `(active: boolean) => void` | `undefined` | Called when accumulation state changes. |
| `onIngestTelemetry` | `(event) => void` | `undefined` | Per-chunk ingest lifecycle. |
| `onRawIngest` | `(xyz, attributes, count) => void` | `undefined` | Called immediately after each chunk ingests, on the main thread. |
| `sourceName` | `string` | `undefined` | Human-readable label for this source, used in metrics output. |
| `config` | `PointFlowConfig` | `undefined` | Shared config object from `pointflow/config`. |

## Ref methods (`StreamedPointCloudRef`)

| Method | Signature | Description |
|---|---|---|
| `pushChunk` | `(chunk: PointChunk) => void` | Ingest a JSON point chunk. |
| `pushBinary` | `(xyz: Float32Array, attributes: DenseAttributeChannel[], count: number) => void` | Ingest pre-packed SoA data. Zero allocation. |
| `reset` | `() => void` | Clear all points. |
| `getOldestRetainedAgeMs` | `() => number` | Age of the oldest buffered point in milliseconds. |

## PointChunk shape

```ts
type PointChunk = {
  points: Array<{
    x: number;
    y: number;
    z: number;
    attributes?: Record<string, number>;
  }>;
};
```

## PickedPoint shape

```ts
type PickedPoint = {
  x: number;
  y: number;
  z: number;
  attributes: Record<string, number>;
  screenDist: number;    // distance from click center in CSS px
  slotIndex: number;     // ring buffer slot
  confidence: number;    // 0-1
};
```
