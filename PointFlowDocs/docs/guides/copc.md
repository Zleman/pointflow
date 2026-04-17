---
id: copc
title: COPC streaming
sidebar_position: 3
---

# COPC streaming

COPC (Cloud Optimized Point Cloud) lets you stream LiDAR data from S3, GCS, or any static host using HTTP range requests. No server infrastructure needed. `<CopcPointCloud>` fetches only the octree nodes visible in the current camera frustum, loads coarse tiles first, and refines as you zoom.

## Basic usage

```tsx
import { CopcPointCloud } from "pointflow/copc";

<CopcPointCloud
  src="https://s3.amazonaws.com/bucket/scan.copc.laz"
  colorBy="intensity"
/>
```

The first fetch reads the COPC header (a few KB). Then tile fetching begins for the current viewport. Coarse tiles load first, finer tiles stream in as you interact.

## Prefetch strategies

Control how tiles are prioritized:

```tsx
<CopcPointCloud
  src={src}
  prefetchStrategy="nearest"    // default: "frustum-priority"
/>
```

| Strategy | Behavior |
|---|---|
| `frustum-priority` | Tiles closest to the frustum center load first. Good for exploration. |
| `depth-first` | Shallow (coarse) tiles load before deep (fine) tiles. Best initial overview. |
| `nearest` | Nearest tiles to the camera position load first. Good for inspection. |
| `bandwidth-saver` | Limits concurrent fetches aggressively. For slow or metered connections. |

## Persistent tile cache (OPFS)

Enable `persistCache` to store decoded tiles in the browser's Origin Private File System. On next visit, previously loaded tiles render instantly with zero network cost:

```tsx
<CopcPointCloud
  src={src}
  persistCache={true}
/>
```

OPFS is silently ignored on environments where it's unavailable (Safari before 17, some privacy modes). The renderer falls back to memory-only caching.

You can tune the in-memory tier separately:

```tsx
<CopcPointCloud
  src={src}
  maxCacheMb={256}        // in-memory LRU budget in MB (default: 512)
  persistCache={true}     // also persist to OPFS
/>
```

## Concurrent fetches

`maxConcurrent` controls how many tile HTTP requests run in parallel:

```tsx
<CopcPointCloud
  src={src}
  maxConcurrent={32}    // default: 16
/>
```

Higher values load faster on fast connections. On slow or metered connections, reducing it avoids competing requests.

## LOD threshold

`lodThreshold` sets the screen-space geometric error cutoff. Lower values request finer tiles at the same zoom level:

```tsx
<CopcPointCloud
  src={src}
  lodThreshold={0.005}    // default: 0.01 — lower = finer detail
/>
```

## Atlas tier configuration

COPC uses a GPU-resident atlas to store tile point data. The atlas is divided into tiers based on point count per tile. You can override the default tier sizes if your dataset has unusual tile distributions:

```tsx
import type { AtlasTierConfig } from "pointflow/copc";

const tiers: AtlasTierConfig[] = [
  { slotCount: 8192, pointsPerSlot: 512   },   // small tiles
  { slotCount: 512,  pointsPerSlot: 8192  },   // mid tiles
  { slotCount: 64,   pointsPerSlot: 65536 },   // large tiles
];

<CopcPointCloud src={src} atlasTiers={tiers} />
```

Default tiers use roughly 280 MB of GPU memory. Total memory = `sum(slotCount × pointsPerSlot) × 16 bytes`.

The defaults work for most COPC files. Customize when:
- Your file has mostly small leaf tiles — reduce or remove the large tier.
- Your root tiles have more than 65,536 points — increase `pointsPerSlot` on the large tier.
- You want to cap GPU memory use — reduce `slotCount` values.

## Point picking

COPC supports the same `onPointPick` callback as `StreamedPointCloud`:

```tsx
<CopcPointCloud
  src={src}
  onPointPick={(pt) => {
    console.log(pt.x, pt.y, pt.z);
    console.log(pt.attributes);
  }}
/>
```

## Migrating from earlier versions

If you were using `<CopcPointCloud>` before v0.1.0, several props changed:

| Old prop | Status | What to do |
|---|---|---|
| `maxPoints` | Ignored | Remove it. Atlas tiers control capacity now. |
| `pollIntervalMs` | Ignored | Remove it. Tile loading is RAF-driven. |
| `workerMode` | Ignored | Remove it. Rendering is always direct WebGPU/WebGL. |

A minimal migration:

```tsx
// Before
<CopcPointCloud src="/scan.copc.laz" maxPoints={500_000} pollIntervalMs={500} workerMode />

// After — just remove the deprecated props
<CopcPointCloud src="/scan.copc.laz" />
```

## S3 and CORS

COPC fetches use HTTP range requests. Your S3 bucket (or equivalent) needs CORS configured to allow `Range` header requests from your origin:

```json
[
  {
    "AllowedOrigins": ["https://your-app.example.com"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Range", "Accept-Ranges"]
  }
]
```

Public buckets (like the PDAL sample data) already have the right CORS policy.
