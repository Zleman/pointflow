---
id: temporal-window
title: Temporal time window
sidebar_position: 7
---

# Temporal time window

`timeWindowMs` limits the render stage to points ingested within the last N milliseconds. Points older than the window are still in the buffer but don't render.

## Usage

```tsx
<StreamedPointCloud
  maxPoints={100_000}
  timeWindowMs={5_000}    // show only points from the last 5 seconds
/>
```

This is useful when:

- Your live feed updates a fixed area repeatedly and you only want the freshest readings.
- You're visualizing sensor sweeps and old positions should fade out.
- You need a sliding window view of a time-series point stream.

## The buffer is not the window

`timeWindowMs` is a render filter only. The ring buffer still accepts and retains points normally up to `maxPoints`. If you set `timeWindowMs={3000}` and `maxPoints={100_000}`, the buffer can hold 100,000 points but only those from the last 3 seconds render on any given frame.

This means you can widen the window later and immediately see older points that were buffered but not rendered.

## Telemetry

Use `onTemporalStats` to see how many points are in the window vs total:

```tsx
<StreamedPointCloud
  maxPoints={100_000}
  timeWindowMs={5_000}
  onTemporalStats={(stats) => {
    console.log(`in window: ${stats.windowedCount} / ${stats.totalCount}`);
    console.log(`oldest point age: ${stats.oldestPointAgeMs}ms`);
  }}
/>
```

## Implementation notes

On WebGPU, the time check runs in the compute shader alongside frustum culling. There's zero CPU overhead — the GPU filters points using a timestamp comparison. On WebGL, filtering runs inside `copyToTypedArrays` on the CPU.

Setting `timeWindowMs` to 0 or leaving it undefined disables the filter entirely.
