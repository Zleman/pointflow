---
id: point-picking
title: Point picking
sidebar_position: 5
---

# Point picking

`onPointPick` gives you the world coordinates and attributes of the point closest to where the user clicked. It works on both `StreamedPointCloud` and `PointCloud`.

## Basic setup

```tsx
<StreamedPointCloud
  maxPoints={100_000}
  colorBy="intensity"
  onPointPick={(pt) => {
    console.log(`clicked at (${pt.x.toFixed(2)}, ${pt.y.toFixed(2)}, ${pt.z.toFixed(2)})`);
    console.log("intensity:", pt.attributes.intensity);
  }}
/>
```

The callback fires on `pointerdown` inside the canvas when a point is found within `pickRadius` CSS pixels of the click.

## What you get back

```ts
type PickedPoint = {
  x: number;           // world-space position
  y: number;
  z: number;
  attributes: Record<string, number>;  // all ingested attribute channels
  screenDist: number;  // distance from the click center in CSS px
  slotIndex: number;   // ring buffer slot (stable until next eviction)
  confidence: number;  // 0-1 proximity confidence
};
```

`slotIndex` is stable until the point is evicted. You can use it to track a specific point across frames, but don't rely on it surviving a `reset()` or heavy buffer pressure.

## Pick radius

```tsx
<StreamedPointCloud
  pickRadius={12}     // default: 8 CSS pixels
  onPointPick={...}
/>
```

Larger values make it easier to click dense clouds. Smaller values give more precision on sparse clouds.

## Pick strategy

When multiple points fall within the radius, `pickStrategy` decides which one wins:

```tsx
<StreamedPointCloud
  pickStrategy="highestImportance"    // default
  onPointPick={...}
/>
```

| Strategy | Behavior |
|---|---|
| `highestImportance` | Returns the point with the highest importance attribute value. Screen distance is the tiebreaker. |
| `nearest` | Returns the point with the smallest screen distance from the click. |
| `recentFirst` | Returns the most recently ingested point within the radius. |

## How it works

**WebGPU path (default when available):** On click, a second render pass runs in the same GPU command encoder. It draws all visible points into an R32Uint texture, encoding each point's ring-buffer slot index. One pixel under the cursor is copied to a staging buffer and read back asynchronously — the result arrives within one frame (~16ms at 60fps). No CPU iteration over the point buffer.

**WebGL path (fallback):** On every frame, the scene component writes the current VP matrix to a shared ref. On `pointerdown`, `PointBuffer.pickNearest()` projects all buffered points into screen space in O(N) and returns the best match within `pickRadius`.

For large buffers on the WebGL path (500k+ points), picking can take a few milliseconds. If that's a concern, reduce `pickRadius` to narrow the candidate set, or debounce the `pointerdown` handler. The WebGPU path has no such overhead.

## Null result

The callback is not called when the click misses all points. If you need to know when a click missed, use `pointerdown` on the canvas element directly and compare:

```tsx
const lastPick = useRef(null);

<StreamedPointCloud
  onPointPick={(pt) => { lastPick.current = pt; }}
/>

// in a canvas pointerdown handler:
// if lastPick.current was not just updated, it's a miss
```
