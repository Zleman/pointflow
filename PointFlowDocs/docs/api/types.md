---
id: types
title: TypeScript types
sidebar_position: 8
---

# TypeScript types

All public types are exported from `"pointflow"`. Import them with `import type` to avoid including them in your runtime bundle.

## Core types

### PointRecord

```ts
type PointRecord = {
  x: number;
  y: number;
  z: number;
  attributes?: Record<string, number>;
};
```

### PointChunk

```ts
type PointChunk = {
  points: PointRecord[];
};
```

### PackedAttributeChannel

```ts
type PackedAttributeChannel = {
  key: string;
  values: Float32Array;
  present: Uint8Array;   // 1 = value present, 0 = missing
};
```

### DenseAttributeChannel

```ts
type DenseAttributeChannel = {
  key: string;
  values: Float32Array;    // all values present — no presence bitmap needed
};
```

### PickedPoint

```ts
type PickedPoint = {
  x: number;
  y: number;
  z: number;
  attributes: Record<string, number>;
  screenDist: number;
  slotIndex: number;
  confidence: number;
};
```

### PickStrategy

```ts
type PickStrategy = "highestImportance" | "nearest" | "recentFirst";
```

### RendererBackend

```ts
type RendererBackend = "auto" | "webgpu" | "webgl";
```

### PointCloudSource

```ts
type PointCloudSource = string | URL | Request | File | Blob;
```

## Policy types

### RuntimeMode

```ts
type RuntimeMode = "eco" | "balanced" | "max_throughput" | "custom";
```

### TierLevel

```ts
type TierLevel = "L" | "M" | "H";
```

### UserConstraints

```ts
type UserConstraints = {
  pointBudgetCap?: number;
  updateCadenceMinMs?: number;
};
```

### ActivePolicy

```ts
type ActivePolicy = {
  tier: TierLevel;
  mode: RuntimeMode;
  pointBudget: number;
  updateCadenceMs: number;
  expensivePassesEnabled: boolean;
};
```

## Streaming metrics

### StreamedPointCloudRenderMetrics

```ts
type StreamedPointCloudRenderMetrics = {
  drawCalls: number;
  renderedPoints: number;
  gpuTimeMs: number | null;
  frameTimeMs: number;
  fps: number;
};
```

### TemporalStats

```ts
type TemporalStats = {
  windowedCount: number;
  totalCount: number;
  oldestPointAgeMs: number;
};
```

## COPC types

### AtlasTierConfig

```ts
type AtlasTierConfig = {
  slotCount: number;
  pointsPerSlot: number;
};
```

### CopcPrefetchStrategy

```ts
type CopcPrefetchStrategy =
  | "frustum-priority"
  | "depth-first"
  | "nearest"
  | "bandwidth-saver";
```

## Quantized transport types

### QuantizedSchema

```ts
type QuantizedSchema = {
  attributes: QuantizedAttrSchema[];
};
```

### QuantizedAttrSchema

```ts
type QuantizedAttrSchema = {
  key: string;
  min: number;
  max: number;
};
```

## Load lifecycle

### PointCloudLoadTelemetryEvent

```ts
type PointCloudLoadTelemetryEvent = {
  phase: "start" | "header" | "chunk" | "done" | "error" | "abort";
  progress?: number;   // 0-1, present on "chunk" and "done"
};
```

### PointCloudStatus

```ts
type PointCloudStatus = "idle" | "loading" | "ready" | "error" | "aborted";
```
