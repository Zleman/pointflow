---
id: performance
title: Performance tuning
sidebar_position: 10
---

# Performance tuning

PointFlow ships with sensible defaults that work well for most cases. This guide covers what the defaults are, when to change them, and what to look for when things are slow.

## Defaults at a glance

| Feature | Default | What it does |
|---|---|---|
| Frustum culling | On | Only visible points upload to GPU |
| Worker ingest | Off (on in StreamedPointCloud) | Chunks parse off the main thread |
| Spatial index | On | Grid-based cell tests replace per-point frustum checks |
| LOD | Auto (on above 500k) | Far points render at lower density |
| Adaptive refresh | Off | Refresh rate doesn't back off under load |
| Worker culling | Off | Points don't get filtered at ingest time |
| Importance sampling | Off | All points have equal render weight |

## Frustum culling

Frustum culling is on by default. Turn it off only if:

- Your cloud fits entirely on screen (culling adds overhead with no benefit).
- You need pixel-perfect accuracy and can't tolerate occasional near-frustum errors.

```tsx
<StreamedPointCloud frustumCulling={false} />
```

## Spatial index

A uniform-grid spatial index is on when frustum culling is on and LOD stride is 1. It groups points into cells and tests cells against the frustum rather than individual points. For large clouds where most points are off-screen, this can cut per-frame CPU cost significantly.

```tsx
<StreamedPointCloud spatialCulling={false} />  // disable if profiling shows it's not helping
```

The spatial index helps most when:
- More than 50% of points are outside the frustum.
- Your buffer is large (100k+ points).

It adds negligible overhead when most points are visible, but there's no reason to disable it unless you're seeing issues.

## Adaptive refresh

Adaptive refresh backs off the upload rate when frame times are long. It's off by default because it can cause visible stuttering if frame timing is inconsistent.

```tsx
<StreamedPointCloud adaptiveRefresh={true} />
```

Turn it on for dashboards with multiple widgets competing for render time. Keep it off for benchmarks and any scenario where consistent cadence matters.

## Worker-side culling

When enabled, the ingest worker filters out points outside the current frustum before packing. Points outside the frustum at ingest time are permanently discarded — they never enter the buffer.

```tsx
<StreamedPointCloud workerMode={true} workerCulling={true} />
```

Use this for live, view-centric feeds where you don't need a history of unseen points. It reduces buffer occupancy and cuts `copyToTypedArrays` iteration cost. Don't use it for replay scenarios where you might pan to reveal previously unseen areas.

## Runtime tiers and modes

PointFlow has a runtime policy system that adjusts point budgets and update cadence based on hardware capability.

```tsx
<StreamedPointCloud
  runtimeMode="max_throughput"   // "eco" | "balanced" | "max_throughput" | "custom"
/>
```

| Mode | Behavior |
|---|---|
| `eco` | Lower point budget, conservative thermal profile. |
| `balanced` | Default. Stable interactive target. |
| `max_throughput` | Full tier budget, highest update cadence. |
| `custom` | Full budget; use `constraints` to shape behavior precisely. |

For explicit control:

```tsx
<StreamedPointCloud
  runtimeMode="custom"
  constraints={{ pointBudgetCap: 500_000, updateCadenceMinMs: 33 }}
/>
```

## Backend selection

WebGPU is faster for large point clouds because frustum culling and importance sampling run in a compute shader. WebGL runs these on the CPU.

```tsx
<StreamedPointCloud rendererBackend="webgpu" />   // request WebGPU; falls back to WebGL
<StreamedPointCloud rendererBackend="webgl" />    // force WebGL
<StreamedPointCloud rendererBackend="auto" />     // default: WebGPU when available
```

### GPU selection on multi-GPU systems

On laptops with both an integrated and a discrete GPU, the two backends behave differently.

The WebGPU path respects the `powerPreference` prop, which defaults to `"high-performance"`. Chrome's WebGPU implementation passes this directly to the OS graphics API (D3D12 on Windows), which hands back the discrete GPU. In practice, no extra configuration is needed — WebGPU is already on the right card.

The WebGL path has no equivalent mechanism. Chrome's WebGL layer (ANGLE) picks whichever GPU the OS assigns to the browser process, which defaults to the integrated GPU for power saving on Optimus and similar hybrid-graphics systems. Forcing the discrete GPU for WebGL requires an OS-level override:

- **Windows:** Settings → System → Display → Graphics → add the browser executable → set to "High performance"
- **NVIDIA:** NVIDIA Control Panel → Manage 3D settings → Program settings → add the browser → set preferred graphics processor to "High-performance NVIDIA processor"

The practical consequence is that on a laptop, the WebGL fallback path is a double penalty: CPU-side culling and a weaker GPU. If you're seeing unexpectedly low WebGL performance on a machine you know has a discrete card, the GPU selection is the first thing to check.

## Measuring what you have

Add `renderMetricsRef` to get frame-by-frame metrics without React re-renders:

```tsx
const metricsRef = useRef(null);
const [display, setDisplay] = useState(null);

useEffect(() => {
  const id = setInterval(() => setDisplay({ ...metricsRef.current }), 500);
  return () => clearInterval(id);
}, []);

<StreamedPointCloud renderMetricsRef={metricsRef} />
```

`onStats` for buffer metrics:

```tsx
<StreamedPointCloud
  onStats={({ totalPoints, droppedPoints, isUnderPressure }) => { ... }}
/>
```

## Common issues

**FPS drops when buffer fills:** Enable adaptive refresh, or reduce `maxPoints` to keep the upload size down.

**High dropped point count:** Your ingest rate exceeds what the buffer can absorb at the current size. Increase `maxPoints`, enable adaptive ingest, or reduce your source's emission rate.

**Main thread stalls on ingest:** Make sure `workerMode` is on. It should be the default for `StreamedPointCloud`.

**WebGPU not activating:** Check `onRendererResolved`. If it reports `"webgl"`, your browser doesn't support WebGPU. Chrome and Edge (with the flag enabled) are the reliable choices.

**Large buffer, slow picking:** Picking is O(N) over all buffered points. Reduce `pickRadius` or use a smaller `maxPoints` for interactive sessions.
