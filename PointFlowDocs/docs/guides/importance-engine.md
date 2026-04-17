---
id: importance-engine
title: Importance engine
sidebar_position: 4
---

# Importance engine

The importance engine controls two things at once: which points survive when the buffer is full (eviction), and which points get drawn on each frame (render sampling). Both use the same score, so the points that matter most are also the points you see most.

## The score

```
score(p) = importance(p) × recency(p)
```

**importance** comes from a numeric attribute you choose. High velocity, high uncertainty, high intensity — whatever matters for your use case.

**recency** applies an exponential decay based on how long ago a point was ingested. Points that arrived recently score higher than old points with the same importance value.

When both signals are off, all scores are equal and eviction is exactly FIFO.

## Enabling importance

Set `importanceField` to the attribute key you want to use:

```tsx
<StreamedPointCloud
  maxPoints={100_000}
  importanceField="uncertainty"
  colorBy="uncertainty"
/>
```

Points with a higher `uncertainty` attribute will survive evictions longer than low-uncertainty points.

## Recency decay

`maxStalenessMs` sets the half-life of the recency factor. A point ingested `maxStalenessMs` milliseconds ago has recency weight 0.5. A point ingested `2 × maxStalenessMs` ago has weight 0.25:

```tsx
<StreamedPointCloud
  maxPoints={100_000}
  importanceField="uncertainty"
  maxStalenessMs={5000}    // 5 second half-life
/>
```

This is useful for live feeds where old sensor data should naturally fade out and be replaced by fresh readings.

## Auto-select importance field

Pass `"auto"` and PointFlow picks the field from the first chunk:

```tsx
<StreamedPointCloud
  importanceField="auto"
/>
```

It prefers `"intensity"` if present, otherwise uses the first available attribute channel. The field is locked in after the first chunk.

## GPU importance sampling

On the WebGPU path, you can also bias which points get drawn each frame based on importance. This is separate from eviction.

```tsx
<StreamedPointCloud
  maxPoints={100_000}
  importanceField="uncertainty"
  importanceSamplingEnabled={true}
/>
```

The WGSL compute shader applies a per-point PCG hash each frame. A point with importance 1.0 always passes. A point with importance 0.1 passes roughly 10% of frames. The frame seed is quantized to 500 ms to prevent strobing.

This is a no-op on the WebGL path — the same importance field still drives eviction, but per-frame sampling runs uniformly.

## Foveated rendering

Boost importance for points near the screen center:

```tsx
<StreamedPointCloud
  importanceSamplingEnabled={true}
  fovStrength={1}    // 0 = off (default), 1 = moderate, 3 = strong
/>
```

Points near the center of the viewport are sampled more frequently. Only active on WebGPU with `importanceSamplingEnabled`.

## Accumulation mode

When the camera stops moving, you often want full-detail rendering rather than stochastic sampling:

```tsx
<StreamedPointCloud
  importanceSamplingEnabled={true}
  accumulationMode={true}
  accumulationThresholdMs={200}    // default: 200ms
  onAccumulationChange={(active) => {
    console.log(active ? "full detail" : "streaming");
  }}
/>
```

After the camera has been static for `accumulationThresholdMs`, the sampling gate opens and all buffered points render. It switches back to stochastic sampling immediately on camera movement. WebGPU only.

## How eviction works

K=16 lookahead: when the buffer is full and a new point needs to be ingested, PointFlow scans the 16 oldest slots and evicts the one with the lowest score. This is O(16) per eviction regardless of buffer size.

When importance is uniform and staleness is off, the lowest-scoring slot is always the oldest one, so eviction is identical to FIFO. The K=16 scan adds no overhead in that case because `worstOffset` is always 0.

## Performance impact

The importance engine adds minimal overhead:

| Metric | Result |
|---|---|
| FPS / p95 regression with importance enabled | ≤ 5% |
| High-importance retention vs FIFO baseline | ≥ 70% vs 50% |
| Density ratio (high vs low importance regions) | ≥ 5x |

The eviction scan is O(16) per chunk. The GPU sampling shader has no measurable impact on frame time because it runs in the same compute pass as frustum culling.
