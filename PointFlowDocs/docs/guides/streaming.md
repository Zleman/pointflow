---
id: streaming
title: Live streaming
sidebar_position: 1
---

# Live streaming

This guide covers everything about streaming live point-cloud data into PointFlow: push methods, transport adapters, stream control, and reset behavior.

## The two push methods

### `pushChunk` — JSON objects

```ts
api.current?.pushChunk({
  points: [
    { x: 1.2, y: 0.4, z: 3.1, attributes: { velocity: 0.75, intensity: 0.4 } },
    { x: 1.3, y: 0.5, z: 3.0, attributes: { velocity: 0.80, intensity: 0.3 } },
  ],
});
```

Each point is a `PointRecord` with `x`, `y`, `z`, and an `attributes` object containing any numeric fields. This format is convenient for debugging and small-scale use. For high-rate feeds it adds allocation cost because each point is a JavaScript object.

### `pushBinary` — zero-allocation SoA

```ts
// xyz: Float32Array of length count * 3 (interleaved x,y,z)
// attributes: [{ key: "velocity", values: Float32Array }]
// count: number of points in this chunk

api.current?.pushBinary(xyzFloat32, [
  { key: "velocity",  values: velocityFloat32 },
  { key: "intensity", values: intensityFloat32 },
], count);
```

`pushBinary` bypasses the PointRecord layer. Arrays are Transferred to the worker thread with zero copy overhead. Use this for high-rate feeds where allocation cost is measurable.

## Transport adapters

PointFlow ships adapters that handle the WebSocket/SSE wire protocol for you, so you don't write the parsing glue.

### WebSocket (JSON)

```ts
import { createWebSocketAdapter } from "pointflow";

const stop = createWebSocketAdapter(
  "wss://lidar.example.com/stream",
  (chunk) => api.current?.pushChunk(chunk),
  (err) => console.error("ws error:", err),
);

// Call stop() to close the socket
```

The adapter parses each message as JSON and calls your callback only when the result is a valid `PointChunk`. Non-chunk messages are silently skipped.

### Server-Sent Events

```ts
import { createSSEAdapter } from "pointflow";

const stop = createSSEAdapter(
  "/api/points",
  (chunk) => api.current?.pushChunk(chunk),
);
```

SSE is a good choice for server stacks that don't need bidirectional communication. Flask, FastAPI, and Express all support it out of the box. Each `data:` event should carry a JSON-encoded `PointChunk`.

### ROS / rosbridge

```ts
import { createRosbridgeAdapter } from "pointflow";

const stop = createRosbridgeAdapter(
  "ws://robot:9090",
  "/velodyne_points",
  {
    fields: {
      intensity: "intensity",
      label: "classification",
    },
    onChunk: (chunk) => api.current?.pushChunk(chunk),
    onError: (e) => console.error(e),
  },
);
```

The rosbridge adapter speaks rosbridge v2 protocol and translates `sensor_msgs/PointCloud2` messages into `PointChunk` objects. The `fields` map connects ROS field names to PointFlow attribute keys. See the [ROS integration guide](/docs/guides/ros-integration) for setup details.

### Binary quantized transport

For bandwidth-sensitive feeds, the quantized adapter decodes compact binary messages where each point is 6 bytes instead of 12. See [Quantized transport](/docs/guides/quantized-transport).

### Merging multiple streams

```ts
import { mergeChunkStreams, withSourceTag } from "pointflow";

const merged = mergeChunkStreams([
  withSourceTag(stream1Chunks, "sensor-a"),
  withSourceTag(stream2Chunks, "sensor-b"),
]);
```

`mergeChunkStreams` combines multiple chunk iterables into one. `withSourceTag` adds a `source` field to each chunk so you can differentiate them downstream.

## Stream control

### Worker mode

By default, chunks are processed on the main thread. Enable worker mode to shift that cost to a Web Worker:

```tsx
<StreamedPointCloud
  workerMode={true}
  maxPoints={200_000}
/>
```

Worker mode uses `Transferable` typed arrays under the hood so there's no serialization cost for binary data. Falls back silently to main-thread processing if Worker creation fails.

### Worker-side culling

When worker mode is on, you can also filter points at ingest time based on the current camera frustum:

```tsx
<StreamedPointCloud
  workerMode={true}
  workerCulling={true}
  maxPoints={200_000}
/>
```

Points outside the frustum when they're ingested are discarded permanently. Good for live, view-centric feeds. Don't use it if you need full-history replay, because points you didn't see will be gone.

## Resetting the stream

Call `reset()` to clear all points and restart:

```ts
api.current?.reset();
```

This is useful when switching data sources, changing configuration, or running back-to-back benchmark passes. In dynamic allocation mode, the buffer keeps its grown capacity after reset (no shrink, to avoid reallocation churn on restart).

## Checking buffer age

`getOldestRetainedAgeMs()` tells you how old the oldest point in the buffer is:

```ts
const ageMs = api.current?.getOldestRetainedAgeMs() ?? 0;
```

Useful when you're using `maxStalenessMs` and want to verify the staleness guarantee is being enforced.

## Adaptive ingest

Under heavy load, the buffer fills and points start dropping. If you'd rather downsample incoming chunks than drop them hard, enable adaptive ingest:

```tsx
<StreamedPointCloud
  adaptiveIngest={true}
  maxPoints={200_000}
/>
```

When pressure is high, chunks are thinned before ingestion rather than accepted in full and then dropped. This spreads points more evenly over time rather than accepting a burst and then dropping a burst.

## Telemetry

`onStats` fires every frame with buffer state:

```tsx
<StreamedPointCloud
  onStats={({ totalPoints, droppedPoints, isUnderPressure }) => {
    // totalPoints: current buffer fill
    // droppedPoints: cumulative dropped since last reset
    // isUnderPressure: true when the buffer is full and dropping
  }}
/>
```

For ingest-level detail:

```tsx
<StreamedPointCloud
  onIngestTelemetry={({ phase, inputCount, outputCount, pressureRatio }) => {
    // phase: "chunk_ingested" | "chunk_throttled"
    // inputCount: points in the chunk before thinning
    // outputCount: points actually ingested
  }}
/>
```
