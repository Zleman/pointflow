---
id: config
title: Config module
sidebar_position: 6
---

# Config module (pointflow/config)

`definePointFlowConfig` creates a typed config object that you can pass to any component or hook to set shared defaults.

```ts
import { definePointFlowConfig } from "pointflow/config";
```

## definePointFlowConfig

```ts
function definePointFlowConfig(config: PointFlowConfigInput): PointFlowConfig;
```

### Config shape

```ts
type PointFlowConfigInput = {
  global?: {
    rendererBackend?: "auto" | "webgpu" | "webgl";
    powerPreference?: "high-performance" | "low-power" | "default";
    frustumCulling?: boolean;
    adaptiveRefresh?: boolean;
  };
  streamed?: {
    lodLevels?: number;
    pickStrategy?: PickStrategy;
    // ... other StreamedPointCloud options
  };
  pointCloud?: {
    chunkSize?: number;
    // ... other PointCloud options
  };
  copc?: {
    prefetchStrategy?: CopcPrefetchStrategy;
    maxConcurrent?: number;
    maxCacheMb?: number;
  };
  hooks?: {
    usePointFlow?: {
      reactivePush?: boolean;
    };
  };
};
```

## Example

```ts
// pointflow.config.ts
import { definePointFlowConfig } from "pointflow/config";

export const config = definePointFlowConfig({
  global: {
    rendererBackend: "auto",
    frustumCulling: true,
  },
  streamed: {
    lodLevels: 3,
  },
  copc: {
    prefetchStrategy: "nearest",
    maxConcurrent: 32,
  },
});
```

```tsx
import { config } from "./pointflow.config";

<StreamedPointCloud maxPoints={200_000} config={config} />
<PointCloud src="/scan.ply" config={config} />
<CopcPointCloud src={url} config={config} />
```

## Precedence

Explicit props at the call site always override config values. See [Config module guide](/docs/guides/config-module) for the full precedence table.

## resolvePointFlowConfig

```ts
import { resolvePointFlowConfig } from "pointflow/config";
```

Resolves a partial config input to a normalized `PointFlowConfig` object. Useful for testing or building wrapper components that accept partial config.
