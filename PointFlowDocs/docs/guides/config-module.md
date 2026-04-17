---
id: config-module
title: Config module
sidebar_position: 8
---

# Config module

`pointflow/config` gives you one place to manage defaults across all PointFlow components and hooks. Useful when you have multiple scenes with the same configuration or when you want to enforce project-wide settings.

## Defining a config

```ts
// pointflow.config.ts
import { definePointFlowConfig } from "pointflow/config";

export const config = definePointFlowConfig({
  global: {
    rendererBackend: "auto",
    frustumCulling: true,
    adaptiveRefresh: false,
  },
  streamed: {
    lodLevels: 3,
    pickStrategy: "highestImportance",
  },
  pointCloud: {
    chunkSize: 10_000,
  },
  copc: {
    prefetchStrategy: "frustum-priority",
    maxConcurrent: 16,
  },
  hooks: {
    usePointFlow: {
      reactivePush: false,
    },
  },
});
```

Then pass it to any component or hook:

```tsx
import { config } from "./pointflow.config";

<StreamedPointCloud maxPoints={200_000} config={config} />
<PointCloud src="/scan.ply" config={config} />
<CopcPointCloud src={url} config={config} />

const state = usePointFlow({ maxPoints: 200_000, config });
```

## Precedence

When you provide both a config and explicit props, explicit props always win:

| Priority | Source |
|---|---|
| 1 (highest) | Explicit prop at the call site |
| 2 | Surface-level config (`streamed`, `pointCloud`, `copc`, `hooks`) |
| 3 | `global` config |
| 4 (lowest) | Built-in defaults |

So if your config sets `rendererBackend: "webgl"` globally but you pass `rendererBackend="webgpu"` on one component, that component uses WebGPU.

## Config sections

### `global`

Applies to all surfaces unless overridden at a more specific level.

```ts
global: {
  rendererBackend?: RendererBackend;  // "auto" | "webgl" | "webgpu"
  frustumCulling?: boolean;
  adaptiveRefresh?: boolean;
}
```

### `streamed`

Applies to `StreamedPointCloud` and `usePointFlow`.

```ts
streamed: {
  lodLevels?: number;
  pickStrategy?: PickStrategy;
  // ... other StreamedPointCloud-specific options
}
```

### `pointCloud`

Applies to `PointCloud` and `usePointCloud`.

```ts
pointCloud: {
  chunkSize?: number;
}
```

### `copc`

Applies to `CopcPointCloud`.

```ts
copc: {
  prefetchStrategy?: CopcPrefetchStrategy;
  maxConcurrent?: number;
  maxCacheMb?: number;
}
```

### `hooks`

Applies to hook-level behavior.

```ts
hooks: {
  usePointFlow?: {
    reactivePush?: boolean;
  };
}
```

## When to use it

A shared config object is most useful when:

- You have three or more scenes that all need the same backend and culling settings.
- You're building a component library on top of PointFlow and want to enforce consistent defaults.
- You want to toggle all scenes between WebGPU and WebGL from one place.

For one-off configurations, explicit props are simpler and clearer.
