---
id: intro
title: Introduction
sidebar_position: 1
---

# PointFlow

PointFlow is a React library for rendering live point-cloud streams without frame drops, memory growth, or browser stalls.

Most point-cloud renderers assume static data. When your data is live, naive approaches fail in three predictable ways. Memory grows without bound as points accumulate. The main thread stalls because parsing and packing happen on it. And the renderer wastes its budget drawing points that don't matter, because it has no way to know which ones do.

PointFlow is built specifically for the live-data case.

## What it does

At the core is a **bounded ring buffer**. You set a ceiling and it stays there forever, no matter how fast the stream is. When the buffer is full, old points are evicted. Which old points get evicted is determined by an importance score, so the points that survive are the ones that matter most.

**Ingest runs off the main thread** in a Web Worker. Chunks arrive, get parsed and packed, and come back ready to upload. The render loop never touches raw chunk data.

**Rendering uses WebGPU** when the browser supports it, with automatic WebGL fallback. The WebGPU path runs frustum culling and importance-weighted sampling in a compute shader, so CPU work per frame is minimal. On WebGL, the same logic runs on the CPU.

Beyond live streams, PointFlow also handles static files. PLY, XYZ, LAS, LAZ, and COPC all load progressively off-thread.

## When to use it

PointFlow is the right choice when:

- Your data is live. WebSocket, SSE, ROS, or any push-based source.
- Memory bounds matter. Dashboards, long-running visualizations, or any context where you can't let memory grow indefinitely.
- You want GPU-accelerated rendering in React without building the plumbing yourself.
- You're loading large static files and want progressive rendering.

## When not to use it

PointFlow isn't the right choice if:

- You're rendering a single static point cloud and don't need streaming or importance scoring. `Three.js Points` with a `BufferGeometry` is simpler and faster for that case.
- You need a full 3D scene editor or annotation tool. PointFlow is a renderer, not a CAD environment.
- You're targeting a server-side rendering context. The library uses browser APIs and won't run in Node outside a test environment.

## How it fits into your stack

PointFlow wraps `@react-three/fiber` and handles everything from the WebSocket message down to the GPU draw call. You don't need to manage Three.js geometries, typed arrays, or render loops. You push chunks and PointFlow draws them.

```tsx
import { StreamedPointCloud } from "pointflow";
import { useRef } from "react";

export function Scene() {
  const api = useRef(null);

  return (
    <StreamedPointCloud
      maxPoints={200_000}
      colorBy="intensity"
      onReady={(ref) => { api.current = ref; }}
    />
  );
}

// Push from anywhere
api.current?.pushChunk({ points: [{ x: 1, y: 2, z: 3, attributes: { intensity: 0.8 } }] });
```

## The problem it replaces

Building reliable point-cloud streaming in the browser from scratch means solving half a dozen hard problems before you render a single point: a bounded buffer with sensible eviction, a worker boundary that doesn't copy data twice, a WebGPU compute pipeline with a correct WebGL fallback, an LOD system, a tile fetcher for COPC files. Each of those is weeks of work on its own. Together they're months.

PointFlow is that solved layer. The library is 14,000 lines of source, 393 passing tests, and has been in development since November 2025. Drop it in and focus on what your application actually does.

## Next steps

- [Install PointFlow](/docs/getting-started/installation) and check the prerequisites.
- [Quick start](/docs/getting-started/quick-start) gets you rendering live points in under five minutes.
- [Guides](/docs/guides/streaming) cover each feature in depth.
- [API reference](/docs/api/streamed-point-cloud) documents every prop and method.
