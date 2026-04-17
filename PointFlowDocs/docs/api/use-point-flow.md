---
id: use-point-flow
title: usePointFlow
sidebar_position: 4
---

# usePointFlow

The core hook that manages the ring buffer, ingest pipeline, and policy engine. `StreamedPointCloud` is built on top of it.

Use `usePointFlow` when you need direct access to the buffer — for example, to drive a custom renderer, to integrate with a non-React-three-fiber canvas, or to share buffer state across multiple scenes.

```tsx
import { usePointFlow } from "pointflow";
```

## Usage

```tsx
const state = usePointFlow({
  maxPoints: 100_000,
  workerMode: true,
  importanceField: "intensity",
});

// Push a chunk:
state.pushChunk({ points: [...] });

// Read buffer state:
console.log(state.totalPoints, state.droppedPoints, state.isUnderPressure);

// For custom rendering:
const count = state.renderIntoBuffers(positions, colors, 1, "intensity", isVisible);
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPoints` | `number` | — | Ring buffer ceiling. |
| `lodLevels` | `number` | `3` | Number of LOD levels to build. |
| `mode` | `BackpressurePolicy["mode"]` | `"drop-oldest"` | Eviction mode. |
| `reactivePush` | `boolean` | `true` | When true, `pushChunk` triggers a React state update. Set to false when you're driving render from a loop. |
| `workerMode` | `boolean` | `false` | Off-thread ingest. |
| `tier` | `TierLevel` | auto | Hardware capability tier. |
| `runtimeMode` | `RuntimeMode` | `"balanced"` | Operating mode. |
| `constraints` | `UserConstraints` | `undefined` | Hard budget ceilings. |
| `legacyMode` | `boolean` | `false` | Disable policy and use `maxPoints` directly. |
| `dynamicAlloc` | `DynamicAllocOptions` | `undefined` | Dynamic buffer growth. |
| `importanceField` | `string \| "auto"` | `undefined` | Importance attribute key. |
| `maxStalenessMs` | `number` | `0` | Recency half-life in ms. |
| `timeWindowMs` | `number` | `0` | Render window filter in ms. |
| `spatialCulling` | `boolean` | `true` | Uniform-grid spatial index. |
| `workerCulling` | `boolean` | `false` | Ingest-time frustum filter. |
| `adaptiveIngest` | `boolean` | `false` | Thin chunks under pressure. |
| `onRawIngest` | `(xyz, attributes, count) => void` | `undefined` | Called after each chunk ingests. |
| `config` | `PointFlowConfig` | `undefined` | Shared config object. |

## Returned state

| Field | Type | Description |
|---|---|---|
| `points` | `PointRecord[]` | Current buffer contents. Updated on each `pushChunk` when `reactivePush` is true. |
| `lodBuckets` | `PointRecord[][]` | Points organized by LOD level. |
| `totalPoints` | `number` | Current buffer fill. |
| `droppedPoints` | `number` | Cumulative dropped count since last reset. |
| `isUnderPressure` | `boolean` | True when buffer is full and dropping. |
| `activePolicy` | `ActivePolicy` | Current tier, mode, and effective budgets. |
| `pushChunk` | `(chunk: PointChunk) => void` | Ingest a chunk. |
| `reset` | `() => void` | Clear the buffer. |
| `refresh` | `() => void` | Pull latest buffer state into React. |
| `refreshStats` | `() => void` | Pull stats only, without rebuilding the points array. |
| `getSnapshot` | `() => PointRecord[]` | Read buffer contents without a React update. |
| `renderIntoBuffers` | `(positions, colors, lodStep, colorBy, isVisible?) => number` | Write buffer directly into typed arrays. Returns point count written. |
| `getBufferCapacity` | `() => number` | Current allocated capacity. |
| `setWorkerFrustum` | `(planes: Float32Array) => void` | Update the frustum used by worker-side culling. |
| `resetVersion` | `number` | Increments each time `reset()` is called. |
| `_bufferRef` | `MutableRefObject<PointBuffer \| null>` | Direct buffer access for advanced use. |

## usePointCloud

For file loading, use `usePointCloud` instead:

```tsx
import { usePointCloud } from "pointflow";

const { status, progress, detectedPointCount, onSceneReady, abort } =
  usePointCloud("/scan.ply", {
    maxPoints: 1_000_000,
    colorBy: "intensity",
  });
```

The first argument is the source (`string`, `URL`, `File`, or `Blob`). The second is an options object. Returns `status` (`"idle" | "loading" | "ready" | "error" | "aborted"`), `progress` (0–1), `detectedPointCount`, an `onSceneReady` callback setter, and `abort`.
