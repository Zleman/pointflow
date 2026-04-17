---
id: transports
title: Transport adapters
sidebar_position: 5
---

# Transport adapters

The WebSocket, SSE, and ROS adapters share a similar shape: you pass a connection URL, a chunk callback, and optionally an error handler, and get back a stop function. The quantized adapter takes a WebSocket instance and a schema instead. Call the stop function to disconnect.

```tsx
import {
  createWebSocketAdapter,
  createSSEAdapter,
  createRosbridgeAdapter,
  createQuantizedAdapter,
  mergeChunkStreams,
  withSourceTag,
} from "pointflow";
```

---

## createWebSocketAdapter

Connects to a WebSocket and calls `onChunk` for each message that parses as a valid `PointChunk`.

```ts
const stop = createWebSocketAdapter(
  url: string,
  onChunk: (chunk: PointChunk) => void,
  onError?: (event: Event) => void,
): () => void;
```

Non-chunk messages (JSON that doesn't match the `PointChunk` shape, or non-JSON frames) are silently ignored.

---

## createSSEAdapter

Connects to a Server-Sent Events endpoint. Each `data:` event should carry a JSON-encoded `PointChunk`.

```ts
const stop = createSSEAdapter(
  url: string,
  onChunk: (chunk: PointChunk) => void,
  onError?: (error: Error) => void,
): () => void;
```

---

## createRosbridgeAdapter

Subscribes to a ROS topic via rosbridge v2 WebSocket protocol and translates `sensor_msgs/PointCloud2` messages.

```ts
const stop = createRosbridgeAdapter(
  wsUrl: string,
  topic: string,
  options: {
    fields?: Record<string, string>;  // ROS field name → PointFlow attribute key
    onChunk: (chunk: PointChunk) => void;
    onError?: (event: Event) => void;
  },
): () => void;
```

`x`, `y`, `z` are always extracted. Other fields need to be listed in `fields`.

---

## createQuantizedAdapter

Decodes compact binary WebSocket messages. Each point is 6 bytes (3 × uint16 XYZ) vs 12 bytes for float32.

```ts
const stop = createQuantizedAdapter(
  ws: WebSocket,
  schema: {
    attributes: Array<{
      key: string;
      min: number;
      max: number;
    }>;
  },
  onChunk: (chunk: PointChunk) => void,
): () => void;
```

The attributes array must match the server's channel order. Each attribute is dequantized with `value = min + (uint16 / 65535) × (max - min)`.

Calling `stop()` detaches the listener. It does NOT close the WebSocket — you're responsible for that.

---

## mergeChunkStreams

Fans in multiple chunk sources into one emit callback:

```ts
import { mergeChunkStreams } from "pointflow";

const stop = mergeChunkStreams([sourceA, sourceB], emit);
// call stop() to disconnect all sources
```

`sources` is an array of `ChunkSourceFactory` functions (each takes an emit callback and returns an unsubscribe). `emit` is the `ChunkEmitter` you want all sources to feed into. Returns an unsubscribe that stops all sources at once.

---

## withSourceTag

Wraps an emit callback to stamp a `sourceId` onto each chunk it receives:

```ts
import { withSourceTag } from "pointflow";

const taggedEmit = withSourceTag("lidar-front", emit);
adapter.connect(taggedEmit);
```

The first argument is the source ID string. The second is the `ChunkEmitter` to wrap. Returns a new `ChunkEmitter` that forwards chunks with `sourceId` set (won't overwrite an existing `sourceId`).

---

## detectWebGPUSupport

Asynchronous WebGPU capability check:

```ts
import { detectWebGPUSupport } from "pointflow";

const available: boolean = await detectWebGPUSupport();
```

---

## detectWebGPUSync

Synchronous check (less accurate — prefer `detectWebGPUSupport` when you can await):

```ts
import { detectWebGPUSync } from "pointflow";

const available = detectWebGPUSync();
```

---

## detectSabSupport

Checks SharedArrayBuffer availability (needed for some high-perf transfer paths):

```ts
import { detectSabSupport } from "pointflow";

const { available, crossOriginIsolated, message } = detectSabSupport();
// available: boolean
// crossOriginIsolated: boolean — whether COOP/COEP headers are set
// message: string — human-readable explanation
```
