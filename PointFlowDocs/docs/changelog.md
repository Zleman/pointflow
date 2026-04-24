---
id: changelog
title: Changelog
sidebar_position: 99
---

# Changelog

## v0.1.1 — PCD/E57 support, GPU point picking, color-by fix

### Added

- **PCD format** — ASCII, binary, and binary-compressed (LZ4) variants. Auto-detected from `.pcd` extension. RGB float-bitcast unpacked to `red`/`green`/`blue` channels. ROS-native; works directly with ROS bag extracted clouds.
- **E57 format** — ASTM E2807 standard output of Leica, FARO, Trimble, and Matterport scanners. Bit-pack codec, multi-scan files, intensity normalisation, `colorRed`/`colorGreen`/`colorBlue` channels. Auto-detected from `.e57` extension.
- **GPU point picking on WebGPU** — on click, a second render pass in the same GPU command encoder draws all visible points into an R32Uint texture encoding ring-buffer slot indices. One pixel is copied to a staging buffer and read back within one frame (~16ms). DPR scaling applied for correct results on HiDPI displays. The WebGL path falls back to CPU `pickNearest` unchanged.
- **CI quality gate** — TypeScript typecheck and full test suite now run on every push in addition to the Vite build.

### Fixed

- **Stale closure in worker bridge** — `onRawIngest` in `usePointFlow` now reads from a ref updated on every render. A new callback takes effect without toggling `workerMode`.
- **Color-by attribute pipeline** — `availableAttributes` now uses `null` as the "not yet reported" sentinel instead of `[]`. The color dropdown no longer locks to `z` while COPC attributes are still loading.
- **React 19 peer compatibility** — upgraded `@react-three/drei` to v10, which declares React 19 in its peer range. `npm ls` no longer reports `ELSPROBLEMS`.

---

## v0.1.0 — Initial public release

### What's in this release

**Streaming ingest**
- Bounded ring buffer with configurable capacity. Memory never grows beyond `maxPoints`, no matter the stream rate or duration.
- Off-thread ingest via a dedicated ingest worker. Typed-array payloads are Transferred (zero-copy) across the thread boundary.
- Optional worker-side frustum prefilter (`workerCulling`) to discard off-screen points at ingest time.

**Rendering**
- WebGPU compute path with importance-weighted GPU sampling. A WGSL compute shader runs frustum culling, temporal window filtering, and per-point importance sampling in one pass. `drawIndirect` means zero CPU draw preparation.
- Automatic WebGL fallback for browsers without WebGPU support.
- LOD with auto-detection by camera distance.
- Frustum culling on both paths.
- Adaptive refresh rate.

**Importance engine**
- Unified importance score drives both buffer eviction (K=16 lookahead) and per-frame render sampling (GPU PCG hash).
- `importanceField`: any numeric attribute channel.
- `maxStalenessMs`: exponential recency decay with configurable half-life.
- `importanceSamplingEnabled`: GPU stochastic sampling on WebGPU.
- `fovStrength`: foveated boost for points near screen center.
- `accumulationMode`: full-detail rendering when camera is static.

**Static file loading**
- `<PointCloud>` for PLY (binary LE/BE/ASCII), XYZ/CSV/TXT, and LAS 1.0–1.4. Off-thread parsing, progressive rendering.
- `<PointCloudDropzone>` for drag-and-drop workflows.
- LAZ (compressed LAS) via opt-in `pointflow/laz` subpath. laz-perf WASM inlined — no CDN dependency.
- Unified source API: `src` accepts `string`, `URL`, `Request`, `File`, or `Blob`.
- `onLoadControls` for imperative cancellation.

**COPC streaming**
- `<CopcPointCloud>` from `pointflow/copc`. HTTP range requests, LRU tile cache, frustum+LOD selection.
- Prefetch strategies: `frustum-priority`, `depth-first`, `nearest`, `bandwidth-saver`.
- OPFS persistent tile cache. Decoded tiles survive page reload with zero network cost.
- Configurable GPU atlas tiers for memory tuning.

**Transport adapters**
- `createWebSocketAdapter` — JSON PointChunk messages.
- `createSSEAdapter` — Server-Sent Events.
- `createRosbridgeAdapter` — rosbridge v2 / `sensor_msgs/PointCloud2`.
- `createQuantizedAdapter` — 6 bytes/point binary encoding.
- `mergeChunkStreams` / `withSourceTag` — multi-source merging.

**Advanced features**
- CPU point picking. `onPointPick` callback with configurable radius and strategy.
- Temporal time window. GPU compute filter on WebGPU, zero CPU overhead.
- Dynamic buffer allocation. Buffers grow from `initialCapacity` toward `maxPoints`.
- `pointflow/config` module for shared defaults across components and hooks.
- Reproducible benchmark surface with fixed profiles, rolling p95, and JSON export.

### Performance (i7-13700HX, RTX 4060 Laptop, Chrome 147, Windows 11)

| Metric | Result |
|---|---|
| FPS (WebGPU, balanced, 50k points) | 163–166 |
| Rolling p95 frame time | < 50 ms |
| Ingest throughput | 20,000 pts/s |
| Test suite | 393 passing, 0 type errors |

### Package structure

```
pointflow          — main package (streaming + static loading)
pointflow/laz      — opt-in LAZ decoder (laz-perf WASM)
pointflow/copc     — opt-in COPC renderer
pointflow/config   — shared config module
```

### Breaking changes

None — this is the first public release.

---

For the full development history, see the [GitHub repository](https://github.com/Zleman/pointflow).
