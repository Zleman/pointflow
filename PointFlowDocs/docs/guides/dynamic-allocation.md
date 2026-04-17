---
id: dynamic-allocation
title: Dynamic buffer allocation
sidebar_position: 9
---

# Dynamic buffer allocation

By default, PointFlow pre-allocates the full `maxPoints` buffer at component mount. This is the safest choice for production: zero allocation cost during streaming, predictable memory from the first frame.

Dynamic allocation starts small and grows as points arrive. It trades a bit of complexity for a smaller initial footprint.

## Enabling it

```tsx
<StreamedPointCloud
  maxPoints={5_000_000}
  dynamicAlloc={{ initialCapacity: 1024, growthFactor: 2 }}
/>
```

| Option | Default | Description |
|---|---|---|
| `initialCapacity` | `min(1024, maxPoints)` | Slots allocated at construction. Must be ≥ 1 and ≤ `maxPoints`. |
| `growthFactor` | `2` | Multiplier applied each time the buffer fills and is below the ceiling. |

## How growth works

When the current capacity is full and below `maxPoints`, PointFlow doubles the allocated size (using `growthFactor`). The ring buffer unrolls so data stays contiguous, then the internal arrays are replaced. Growth is scheduled via `requestAnimationFrame` so it doesn't happen on the ingest hot path.

Capacity never exceeds `maxPoints`. Once at the ceiling, the normal drop policy applies.

## Reset behavior

`reset()` leaves the buffer at its current grown capacity. It doesn't shrink back to `initialCapacity`. This avoids reallocation churn when you restart a stream repeatedly. If you need to reclaim memory, unmount and remount the component.

## Tradeoffs

| | Pre-alloc (default) | Dynamic |
|---|---|---|
| Memory at mount | Full `maxPoints` | ~`initialCapacity` |
| Reallocation cost | None | O(size) per doubling — infrequent |
| Ingest hot-path | No branches | Same — growths are amortized |
| Best for | Known, fixed buffer size | Large ceilings, exploratory use |

## When dynamic allocation makes sense

The main case is a large `maxPoints` ceiling where you're not sure how many points you'll actually accumulate. If you set `maxPoints={5_000_000}` for an exploratory tool, pre-alloc dedicates ~240 MB up front. With dynamic alloc, you start at a few KB and grow only as needed.

For fixed-size production deployments where you know the buffer will fill, pre-alloc is simpler and faster. The full-size buffer is available immediately and there's no reallocation overhead.
