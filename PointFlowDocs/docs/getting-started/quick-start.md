---
id: quick-start
title: Quick start
sidebar_position: 2
---

# Quick start

This gets you from zero to a live streaming point cloud in a few minutes. We'll cover the streaming case first, then the static file case.

## Streaming from a WebSocket

### 1. Mount the component

```tsx
import { StreamedPointCloud, type StreamedPointCloudRef } from "pointflow";
import { useRef } from "react";

export function LiveScene() {
  const api = useRef<StreamedPointCloudRef>(null);

  return (
    <StreamedPointCloud
      maxPoints={200_000}
      colorBy="velocity"
      onReady={(ref) => { api.current = ref; }}
    />
  );
}
```

`maxPoints` is the hard memory ceiling. The buffer will never exceed this count. `colorBy` maps a numeric attribute to a colour gradient. `onReady` gives you the API handle once the GPU pipeline is ready.

### 2. Connect your data source

```tsx
import { useEffect, useRef } from "react";
import { StreamedPointCloud, type StreamedPointCloudRef } from "pointflow";

export function LiveScene() {
  const api = useRef<StreamedPointCloudRef>(null);

  useEffect(() => {
    const ws = new WebSocket("wss://your-lidar.example.com/stream");

    ws.onmessage = (event) => {
      const chunk = JSON.parse(event.data);
      // chunk shape: { points: [{ x, y, z, attributes: { velocity: 0.8 } }] }
      api.current?.pushChunk(chunk);
    };

    return () => ws.close();
  }, []);

  return (
    <StreamedPointCloud
      maxPoints={200_000}
      colorBy="velocity"
      onReady={(ref) => { api.current = ref; }}
    />
  );
}
```

That's it for the basic case. Points render as they arrive.

### 3. Use a transport adapter (optional)

If your server sends JSON PointChunk messages, PointFlow's WebSocket adapter handles the parsing for you:

```tsx
import { createWebSocketAdapter } from "pointflow";

useEffect(() => {
  const stop = createWebSocketAdapter(
    "wss://your-lidar.example.com/stream",
    (chunk) => api.current?.pushChunk(chunk),
  );
  return stop; // closes the socket on unmount
}, []);
```

For high-rate feeds, the binary adapter cuts wire cost in half. See [Quantized transport](/docs/guides/quantized-transport) for details.

## Loading a static file

```tsx
import { PointCloud } from "pointflow";

export function FileScene() {
  return (
    <PointCloud
      src="/scans/building.ply"
      colorBy="intensity"
    />
  );
}
```

Progressive rendering starts immediately. Points appear as they parse, not after the whole file loads.

`src` accepts a URL string, a `File` object, a `Blob`, a `URL` instance, or a `Request`. So a file picker works like this:

```tsx
const [file, setFile] = useState<File | null>(null);

return (
  <>
    <input type="file" accept=".ply,.xyz,.las,.laz" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
    {file && <PointCloud src={file} colorBy="intensity" />}
  </>
);
```

For LAZ files, pass `loaderFactory={createLazLoader}` from `pointflow/laz`. For COPC, use `CopcPointCloud` from `pointflow/copc`.

## What you get out of the box

With no extra configuration, PointFlow:

- Picks WebGPU or WebGL based on what the browser supports.
- Runs ingest in a Web Worker.
- Enables frustum culling (only visible points upload).
- Auto-enables LOD for large point counts.

You can tune all of these. See the [Performance guide](/docs/guides/performance) and individual guides for details.

## Checking what's rendering

Add `onStats` to see buffer stats on each frame:

```tsx
<StreamedPointCloud
  maxPoints={200_000}
  onStats={(stats) => {
    console.log(`points: ${stats.totalPoints}, dropped: ${stats.droppedPoints}`);
  }}
/>
```

Or use `onRendererResolved` to confirm which GPU path is active:

```tsx
<StreamedPointCloud
  onRendererResolved={(backend) => {
    console.log("using:", backend); // "webgpu" or "webgl"
  }}
/>
```

## Next steps

- [Streaming guide](/docs/guides/streaming) covers the full streaming API including binary push, worker mode, and stream reset.
- [Static files](/docs/guides/static-files) covers all supported formats.
- [Importance engine](/docs/guides/importance-engine) shows how to bias the buffer toward high-value points.
- [API reference](/docs/api/streamed-point-cloud) documents every prop on `StreamedPointCloud`.
