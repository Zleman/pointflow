---
id: installation
title: Installation
sidebar_position: 1
---

# Installation

## Prerequisites

PointFlow requires these peer dependencies in your project:

| Package | Version |
|---|---|
| `react` | ≥ 18 |
| `react-dom` | ≥ 18 |
| `three` | ≥ 0.160 |
| `@react-three/fiber` | ≥ 8 |
| `@react-three/drei` | ≥ 9 |

Install them if you don't already have them:

```bash
npm install three @react-three/fiber @react-three/drei
```

## Install PointFlow

```bash
npm install pointflow
```

That's the base package. It includes `StreamedPointCloud`, `PointCloud`, `CopcPointCloud`, `usePointFlow`, and all transport adapters.

## Optional subpackages

Two features are opt-in to keep the base bundle small:

### LAZ support

LAZ is compressed LAS. If you don't need it, you pay zero bundle cost. When you do, import from `pointflow/laz`:

```bash
# No extra install needed — pointflow/laz is a subpath of the same package
```

```tsx
import { createLazLoader } from "pointflow/laz";

<PointCloud src="/scan.laz" loaderFactory={createLazLoader} />
```

The laz-perf WASM binary (~210 KB) is base64-inlined in the worker. No CDN, no separate fetch, no server config.

### COPC support

COPC (Cloud Optimized Point Cloud) is a format for streaming LiDAR data from S3 or any static host via HTTP range requests. Import from `pointflow/copc`:

```tsx
import { CopcPointCloud } from "pointflow/copc";

<CopcPointCloud src="https://s3.amazonaws.com/bucket/scan.copc.laz" />
```

## TypeScript

PointFlow ships with full TypeScript types. No `@types/` package is needed. All props, methods, and callbacks are typed.

## WebGPU and browser support

| Browser | Renderer used |
|---|---|
| Chrome / Edge | WebGPU (compute + indirect draw) |
| Firefox | WebGL (automatic fallback) |
| Safari | WebGL (WebGPU is experimental) |

PointFlow detects support at runtime and picks the best available path. You don't need to check or configure anything. If you want to force one path, pass `rendererBackend="webgl"` or `rendererBackend="webgpu"` to any component.

## Bundler notes

PointFlow publishes ES modules. Vite, webpack 5, and Parcel all work without configuration. If you're using an older bundler or a monorepo with shared node_modules, make sure `three` and `@react-three/fiber` resolve to a single instance. Multiple instances of `three` in the same page will cause render errors.

## Next

[Quick start](/docs/getting-started/quick-start) walks you through your first streaming scene.
