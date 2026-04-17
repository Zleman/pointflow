import type { AttributePackingMode, DynamicAllocOptions, GPUPowerPreference, PickStrategy, RendererBackend } from "../core/types";
import type { BackpressurePolicy } from "../core/types";
import type { RuntimeMode, TierLevel, UserConstraints } from "../core/runtime-policy";
import type { CopcPrefetchStrategy } from "../components/CopcPointCloud";

export interface PointFlowGlobalConfig {
  maxPoints?: number;
  rendererBackend?: RendererBackend;
  powerPreference?: GPUPowerPreference;
  colorBy?: string;
  frustumCulling?: boolean;
  tier?: TierLevel;
  runtimeMode?: RuntimeMode;
  constraints?: UserConstraints;
  adaptiveRefresh?: boolean;
  adaptiveIngest?: boolean;
  autoTunePolicy?: boolean;
  pickRadius?: number;
  pickStrategy?: PickStrategy;
}

export interface PointFlowStreamedConfig {
  maxPoints?: number;
  lodLevels?: number;
  rendererBackend?: RendererBackend;
  powerPreference?: GPUPowerPreference;
  colorBy?: string;
  frustumCulling?: boolean;
  mode?: BackpressurePolicy["mode"];
  reactivePush?: boolean;
  workerMode?: boolean;
  tier?: TierLevel;
  runtimeMode?: RuntimeMode;
  constraints?: UserConstraints;
  legacyMode?: boolean;
  dynamicAlloc?: DynamicAllocOptions;
  spatialCulling?: boolean;
  workerCulling?: boolean;
  importanceField?: string;
  maxStalenessMs?: number;
  timeWindowMs?: number;
  lodLevel?: number;
  autoLod?: boolean;
  visualRefreshRateHz?: number;
  adaptiveRefresh?: boolean;
  adaptiveIngest?: boolean;
  autoTunePolicy?: boolean;
  pickRadius?: number;
  pickStrategy?: PickStrategy;
  importanceSamplingEnabled?: boolean;
  fovStrength?: number;
  accumulationMode?: boolean;
  accumulationThresholdMs?: number;
}

export interface PointFlowPointCloudConfig {
  maxPoints?: number;
  rendererBackend?: RendererBackend;
  colorBy?: string;
  frustumCulling?: boolean;
  autoLod?: boolean;
  lodLevel?: number;
  visualRefreshRateHz?: number;
  adaptiveRefresh?: boolean;
  adaptiveIngest?: boolean;
  chunkSize?: number;
  loaderFactory?: () => Worker;
  tier?: TierLevel;
  runtimeMode?: RuntimeMode;
  pickRadius?: number;
  pickStrategy?: PickStrategy;
  fovStrength?: number;
  accumulationMode?: boolean;
  accumulationThresholdMs?: number;
}

export interface PointFlowCopcConfig {
  maxCacheMb?: number;
  persistCache?: boolean;
  maxConcurrent?: number;
  prefetchStrategy?: CopcPrefetchStrategy;
  maxDepth?: number;
  lodThreshold?: number;
  rendererBackend?: RendererBackend;
  powerPreference?: GPUPowerPreference;
  colorBy?: string;
  frustumCulling?: boolean;
  basePointSize?: number;
  attributePacking?: AttributePackingMode;
}

export interface PointFlowUsePointFlowConfig {
  maxPoints?: number;
  lodLevels?: number;
  mode?: BackpressurePolicy["mode"];
  reactivePush?: boolean;
  workerMode?: boolean;
  tier?: TierLevel;
  runtimeMode?: RuntimeMode;
  constraints?: UserConstraints;
  legacyMode?: boolean;
  dynamicAlloc?: DynamicAllocOptions;
  spatialCulling?: boolean;
  workerCulling?: boolean;
  importanceField?: string;
  maxStalenessMs?: number;
  timeWindowMs?: number;
  adaptiveIngest?: boolean;
  autoTunePolicy?: boolean;
}

export interface PointFlowUsePointCloudConfig {
  chunkSize?: number;
  loaderFactory?: () => Worker;
}

export interface PointFlowHooksConfig {
  usePointFlow?: PointFlowUsePointFlowConfig;
  usePointCloud?: PointFlowUsePointCloudConfig;
}

export interface PointFlowConfig {
  global?: PointFlowGlobalConfig;
  streamed?: PointFlowStreamedConfig;
  pointCloud?: PointFlowPointCloudConfig;
  copc?: PointFlowCopcConfig;
  hooks?: PointFlowHooksConfig;
}

function mergeSection<T extends object>(base?: T, overrides?: T): T | undefined {
  if (!base && !overrides) return undefined;
  return { ...(base ?? {}), ...(overrides ?? {}) } as T;
}

export function definePointFlowConfig<T extends PointFlowConfig>(config: T): T {
  return config;
}

export function resolvePointFlowConfig(base?: PointFlowConfig, overrides?: PointFlowConfig): PointFlowConfig {
  return {
    global: mergeSection(base?.global, overrides?.global),
    streamed: mergeSection(base?.streamed, overrides?.streamed),
    pointCloud: mergeSection(base?.pointCloud, overrides?.pointCloud),
    copc: mergeSection(base?.copc, overrides?.copc),
    hooks: {
      usePointFlow: mergeSection(base?.hooks?.usePointFlow, overrides?.hooks?.usePointFlow),
      usePointCloud: mergeSection(base?.hooks?.usePointCloud, overrides?.hooks?.usePointCloud),
    },
  };
}

export function resolveConfigValue<T>(builtIn: T, ...values: Array<T | undefined>): T {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return builtIn;
}
