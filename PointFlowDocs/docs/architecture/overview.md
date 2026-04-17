---
id: overview
title: Architecture overview
sidebar_position: 1
---

# Architecture overview

PointFlow is a pipeline from raw chunk data to GPU draw call. Each stage is designed to do one job without interfering with the others.

## The pipeline

```
WebSocket / SSE / File
        |
   [Transport adapter]         ← normalizes to PointChunk
        |
   [Ingest worker]             ← off-thread: packs SoA typed arrays
        |
   [Ring buffer]               ← bounded: drops by importance score
        |
   [Render cadence]            ← throttles uploads to target Hz
        |
   [Compute shader / CPU]      ← frustum culling + importance sampling
        |
   [GPU draw]                  ← drawIndirect (WebGPU) or drawArrays (WebGL)
```

## Ingest

Chunks arrive on the main thread from whatever source you connect. If `workerMode` is enabled, they're transferred to a Web Worker immediately. The worker parses attribute data, packs everything into Structure-of-Arrays typed arrays (one Float32Array per channel), and posts the result back.

Transferable typed arrays cross the thread boundary with zero copy.

## Ring buffer

The ring buffer holds at most `maxPoints` points. When it's full and a new chunk arrives, the oldest points are evicted to make room.

Which "oldest" points get evicted is controlled by the importance engine. With no importance configuration, eviction is FIFO. With `importanceField` and `maxStalenessMs` set, the buffer prefers to evict old, low-importance points rather than just the oldest ones.

## Render cadence

The render loop runs at whatever rate `@react-three/fiber` drives it, but uploads are throttled to `visualRefreshRateHz` (default: 60 Hz). Every N frames, the current buffer contents are written into GPU-ready typed arrays and uploaded.

On WebGPU, this is a full-ring upload every tick. On WebGL, it goes through `copyToTypedArrays`, which applies frustum culling and LOD stride on the CPU.

## Compute shader (WebGPU)

The WebGPU path adds a compute pass between the upload and the draw call:

1. The compute shader reads all uploaded points.
2. It applies a 6-plane frustum test.
3. If importance sampling is enabled, it applies a per-point PCG hash and compares against the importance score.
4. Surviving points are atomically compacted into a second buffer.
5. `drawIndirect` draws from the compacted buffer. The CPU never knows how many points survived.

Double buffering ensures ingest and draw never contend on the same buffer.

## WebGL fallback

On WebGL, the same logical operations happen on the CPU in `copyToTypedArrays`. It reads the ring buffer, applies the frustum predicate, applies LOD stride, and writes into pre-allocated typed arrays that then upload to the GPU. There's no compute pass and no indirect draw.

The result is the same visible output. The cost is higher because frustum culling and LOD happen on the main thread before each draw.

## Policy engine

The policy engine sits between your configuration and the actual render parameters. It takes your `runtimeMode` and hardware `tier` and derives the effective `maxPoints` budget and update cadence. You can bypass it with `legacyMode: true` or override it precisely with `runtimeMode: "custom"` and explicit `constraints`.

## Key design decisions

**Bounded buffer over unbounded streaming:** Memory spikes in long-running dashboards are a common failure mode. A fixed ceiling is simpler to reason about and test than eviction strategies on an unbounded structure.

**Off-thread ingest:** Point data parsing is CPU-intensive. Keeping it off the main thread means render loops don't see ingest cost as jitter.

**K=16 eviction:** A full heap scan for the lowest-importance point would be O(N). K=16 gives importance-biased eviction at O(16) per eviction, which is invisible at any realistic buffer size.

**Unified importance function:** Using one score for both eviction and render sampling means the set of rendered points and the set of retained points have the same priority ordering. There's no situation where a high-importance point survives eviction but renders less often than a low-importance one.

**WebGPU opt-in, WebGL always-on:** WebGPU delivers better GPU utilization and removes the CPU-side culling loop. But browser support is still partial. Automatic fallback means you get the best available path without writing code for both.
