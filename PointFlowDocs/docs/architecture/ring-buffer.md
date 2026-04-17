---
id: ring-buffer
title: Ring buffer
sidebar_position: 2
---

# Ring buffer

The ring buffer is how PointFlow keeps memory bounded. You set a ceiling and it stays there permanently, regardless of how much data arrives.

## Structure

The buffer is a fixed-size array of slots. Each slot holds one point: `x`, `y`, `z`, and a map of attribute values. New points go into the next available slot. When the buffer is full, the slot occupied by the "oldest" point (by the eviction policy) gets reused.

The write head advances forward. When it reaches the end, it wraps to the beginning. This is the classic ring structure. The "oldest" slot in pure FIFO eviction is always the one the write head is about to overwrite.

## Eviction

When the buffer is at capacity and a new point needs to be ingested, one existing point has to go. The default (no importance configured) is FIFO: the oldest point is evicted.

With importance configured, K=16 lookahead changes the eviction candidate:

```
incoming point → scan 16 oldest slots → evict the one with the lowest score
```

The scan is O(16) regardless of buffer size. If all 16 have the same importance (or no importance is configured), the lowest-scoring slot is always the oldest one, so the result is identical to FIFO. There's no overhead penalty for not using importance.

## Backpressure

When the ingest rate exceeds the eviction rate (i.e., more points arrive per second than the buffer can cycle), `isUnderPressure` becomes true. At that point, incoming points are still ingested and old ones are evicted — but the eviction-to-ingest ratio means you're cycling through the buffer quickly and each point's lifetime is short.

`droppedPoints` in `onStats` counts cumulative evictions since the last `reset()`. A high dropped count with `isUnderPressure: true` is expected behavior, not an error. It means the buffer is full and running at capacity.

## Pre-allocation vs dynamic allocation

By default, all buffer memory is allocated at mount:

```tsx
<StreamedPointCloud maxPoints={200_000} />
// allocates 200,000 point slots immediately
```

Dynamic allocation starts small:

```tsx
<StreamedPointCloud
  maxPoints={5_000_000}
  dynamicAlloc={{ initialCapacity: 1024, growthFactor: 2 }}
/>
// allocates 1,024 slots; grows toward 5M as points arrive
```

Growth triggers when the current capacity is full and below `maxPoints`. The buffer unrolls (data made contiguous), arrays are doubled, and the process continues. Growth is scheduled via `requestAnimationFrame` to avoid happening on the hot ingest path.

Pre-allocation is the right default for fixed-size production deployments where you know the buffer will fill. Dynamic allocation is useful for exploratory tools with large theoretical ceilings where you don't know how many points will actually arrive.

## Slot stability

A point's `slotIndex` is stable until it's evicted. You can use it to track a specific point across frames. But slots get reused aggressively when the buffer is under pressure, so `slotIndex` references become stale quickly in high-throughput streams.

`reset()` clears all slots but doesn't release allocated memory. The buffer keeps its grown capacity and new points start filling from slot 0.

## Testing the buffer guarantees

From a test:

```ts
const buffer = new PointBuffer({ maxPoints: 10 });

for (let i = 0; i < 20; i++) {
  buffer.push({ x: i, y: 0, z: 0, attributes: {} });
}

// Buffer has exactly 10 points — never exceeded
expect(buffer.totalPoints).toBe(10);

// The 10 most recent points are retained
const points = buffer.getSnapshot();
expect(points.map(p => p.x)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
```

With importance:

```ts
// High-importance points survive longer than low-importance
// After filling a buffer with mixed-importance points and pushing past capacity,
// more high-importance points are retained than in a pure FIFO buffer
```
