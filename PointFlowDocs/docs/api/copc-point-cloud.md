---
id: copc-point-cloud
title: CopcPointCloud
sidebar_position: 3
---

# CopcPointCloud

Streaming COPC viewer. Fetches only the tiles visible in the current camera frustum via HTTP range requests. No server infrastructure required.

```tsx
import { CopcPointCloud } from "pointflow/copc";
```

## Quick example

```tsx
<CopcPointCloud
  src="https://s3.amazonaws.com/bucket/scan.copc.laz"
  colorBy="intensity"
  maxConcurrent={16}
  persistCache={true}
/>
```

## Props

### Required

| Prop | Type | Description |
|---|---|---|
| `src` | `string` | URL to a `.copc.laz` file. Needs CORS + Range request support on the server. |

### Tile loading

| Prop | Type | Default | Description |
|---|---|---|---|
| `prefetchStrategy` | `"frustum-priority" \| "depth-first" \| "nearest" \| "bandwidth-saver"` | `"frustum-priority"` | Tile prioritization strategy. |
| `maxConcurrent` | `number` | `16` | Max parallel tile fetch requests. |
| `maxDepth` | `number` | `12` | Octree depth limit. |

### Caching

| Prop | Type | Default | Description |
|---|---|---|---|
| `maxCacheMb` | `number` | `512` | In-memory LRU tile budget in MB. |
| `persistCache` | `boolean` | `false` | Store decoded tiles in OPFS across page reloads. |

### Rendering

| Prop | Type | Default | Description |
|---|---|---|---|
| `colorBy` | `string` | `undefined` | Attribute key to colour by. |
| `rendererBackend` | `"auto" \| "webgpu" \| "webgl"` | `"auto"` | Force a renderer or let PointFlow pick. |
| `powerPreference` | `"high-performance" \| "low-power" \| "default"` | `"high-performance"` | GPU power preference hint for the WebGPU adapter. `"high-performance"` prefers the discrete GPU on multi-GPU systems. `"low-power"` prefers the integrated GPU. `"default"` lets the browser decide. No-op on the WebGL path. |
| `frustumCulling` | `boolean` | `true` | |
| `lodThreshold` | `number` | `0.01` | Screen-space geometric error cutoff. Lower = finer detail. |
| `atlasTiers` | `AtlasTierConfig[]` | See [defaults](/docs/guides/copc#atlas-tier-configuration) | GPU atlas tier configuration. |

### Lifecycle

| Prop | Type | Description |
|---|---|---|
| `onReady` | `() => void` | Called after the first frame renders. |
| `onRendererResolved` | `(backend) => void` | |
| `onError` | `(err: PointFlowError) => void` | |
| `onProgress` | `(progress: number) => void` | Called with 0–1 as tiles load. |
| `onDeclaredPointCount` | `(count: number) => void` | Total points from COPC header. |
| `onAvailableAttributes` | `(attrs: string[]) => void` | Attribute keys present in the file. |
| `renderMetricsRef` | `React.MutableRefObject<...>` | |
| `fileSourceLabel` | `string` | Human-readable source label for metrics. |
| `fileViewSnapshotRef` | `React.MutableRefObject<...>` | Snapshot ref for serializing the current view state. |

## AtlasTierConfig

```ts
type AtlasTierConfig = {
  slotCount: number;      // number of slots in this tier
  pointsPerSlot: number;  // max points per slot
};
```

Default tiers:

| Tier | Slots | Points/slot | For |
|---|---|---|---|
| 0 (small) | 4096 | 512 | Leaf / deep nodes |
| 1 (medium) | 1024 | 8,192 | Mid-level nodes |
| 2 (large) | 256 | 65,536 | Root / shallow nodes |

Total default GPU memory: ~280 MB.

## Deprecated props

These props existed before v0.1.0 and are now silently ignored:

| Prop | Reason |
|---|---|
| `maxPoints` | Memory is atlas-controlled. Use `atlasTiers` to tune capacity. |
| `pollIntervalMs` | Loading is RAF-driven. No polling needed. |
| `workerMode` | Rendering is always direct WebGPU/WebGL. |
