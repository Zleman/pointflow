/**
 * Runtime Policy — tier detection, runtime modes, and constraint enforcement.
 *
 * Design goals:
 * 1. User constraints are a HARD CEILING — never exceeded regardless of mode.
 * 2. Tier L must be practical and stable (min budget, conservative defaults).
 * 3. Tier H scales above Tier M when Max Throughput is selected.
 * 4. Eco/Custom can deliberately cap throughput on high-end hardware.
 * 5. legacyMode: true bypasses all policy and reverts to pre-policy behavior.
 *
 * Tier detection uses capability signals (texture limits, WebGPU availability,
 * and coarse system capacity hints) with no vendor-string matching.
 * Override is always available via the `tier` option.
 */


export type TierLevel = "L" | "M" | "H";
export type RuntimeMode = "eco" | "balanced" | "max_throughput" | "custom";

/**
 * Hard ceilings that the policy MUST NOT exceed.
 * All fields are optional — unset means uncapped for that axis.
 */
export interface UserConstraints {
  /** Maximum retained points the render path may draw. */
  pointBudgetCap?: number;
  /** Minimum interval between visual refreshes in ms (inverted Hz cap). */
  updateCadenceMinMs?: number;
}

/** Static per-tier profile defaults. */
interface TierDefaults {
  /** Absolute maximum point budget when unconstrained at Max Throughput. */
  maxPoints: number;
  /** Visual refresh cadence at Balanced mode (ms). */
  balancedCadenceMs: number;
}

/** Computed active policy after tier × mode × constraints are applied. */
export interface ActivePolicy {
  /** Maximum rendered points for this frame cycle. Never exceeds user caps. */
  pointBudget: number;
  /** Target interval between visual GPU updates (ms). */
  updateCadenceMs: number;
  /** Whether snapshot builds and LOD materialisation are allowed this cycle. */
  expensivePassesEnabled: boolean;
  /** Runtime mode that produced this policy. */
  mode: RuntimeMode;
  /** Hardware tier used to compute this policy. */
  tier: TierLevel;
}

export interface TierDetectionSignals {
  webGpuAvailable?: boolean;
  hardwareConcurrency?: number;
  deviceMemoryGb?: number | null;
}

/** Max-throughput, unconstrained point budget and update cadence per tier. */
const TIER_DEFAULTS: Record<TierLevel, TierDefaults> = {
  L: { maxPoints: 200_000, balancedCadenceMs: 250  }, // 4 Hz
  M: { maxPoints: 500_000, balancedCadenceMs: 167  }, // 6 Hz
  H: { maxPoints: 1_000_000, balancedCadenceMs: 125 }, // 8 Hz
};

interface ModeFractions {
  /** Fraction of tier maxPoints applied as budget. */
  pointFraction: number;
  /** Multiplier on balancedCadenceMs (>1 = slower refresh). */
  cadenceMultiplier: number;
  expensivePasses: boolean;
}

const MODE_FRACTIONS: Record<RuntimeMode, ModeFractions> = {
  eco:            { pointFraction: 0.40, cadenceMultiplier: 2.0,  expensivePasses: false },
  balanced:       { pointFraction: 0.70, cadenceMultiplier: 1.0,  expensivePasses: true  },
  max_throughput: { pointFraction: 1.00, cadenceMultiplier: 0.625, expensivePasses: true  }, // 0.625 → 8 Hz at Tier L
  custom:         { pointFraction: 1.00, cadenceMultiplier: 1.0,  expensivePasses: true  },
};


/**
 * Compute the active policy for a given tier, mode, and user constraints.
 *
 * Precedence (highest wins):
 *   1. userConstraints  — HARD CEILING, never exceeded.
 *   2. mode policy table — sets envelope below user constraints.
 *   3. tier defaults    — foundation for mode calculations.
 */
export function computeActivePolicy(
  tier: TierLevel,
  mode: RuntimeMode,
  constraints: UserConstraints = {}
): ActivePolicy {
  const tierDef = TIER_DEFAULTS[tier];
  const modeFrac = MODE_FRACTIONS[mode];

  let pointBudget = Math.floor(tierDef.maxPoints * modeFrac.pointFraction);
  let updateCadenceMs = Math.round(tierDef.balancedCadenceMs * modeFrac.cadenceMultiplier);

  if (constraints.pointBudgetCap !== undefined) {
    pointBudget = Math.min(pointBudget, constraints.pointBudgetCap);
  }
  if (constraints.updateCadenceMinMs !== undefined) {
    updateCadenceMs = Math.max(updateCadenceMs, constraints.updateCadenceMinMs);
  }

  return {
    pointBudget,
    updateCadenceMs,
    expensivePassesEnabled: modeFrac.expensivePasses,
    mode,
    tier,
  };
}


/**
 * Determine hardware tier from capability signals.
 *
 * Strategy: use maxTextureSize plus coarse environment signals. This avoids
 * vendor/model parsing while still giving deterministic and tunable behavior.
 *
 * Tier assignment is deterministic: same hardware → same tier on every call.
 * Override is always available via the `tier` option in UsePointFlowOptions.
 *
 * @param maxTextureSize  gl.getParameter(gl.MAX_TEXTURE_SIZE) — defaults to 4096.
 * @param signals Optional environment hints. If omitted, defaults are read from
 *                navigator when available.
 */
export function detectTier(
  maxTextureSize = 4096,
  signals?: TierDetectionSignals | string
): TierLevel {
  const hints: TierDetectionSignals = typeof signals === "object" && signals !== null ? signals : {};

  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number; gpu?: unknown }) : undefined;
  const webGpuAvailable = hints.webGpuAvailable ?? (nav !== undefined && "gpu" in nav);
  const hardwareConcurrency = hints.hardwareConcurrency ?? nav?.hardwareConcurrency ?? 4;
  const deviceMemoryGb = hints.deviceMemoryGb ?? nav?.deviceMemory ?? null;

  const textureScore =
    maxTextureSize >= 32768 ? 3.0 :
    maxTextureSize >= 16384 ? 2.0 :
    maxTextureSize >= 8192 ? 1.0 : 0.0;

  const webGpuScore = webGpuAvailable ? 1.0 : 0.0;
  const cpuScore =
    hardwareConcurrency >= 16 ? 1.5 :
    hardwareConcurrency >= 12 ? 1.0 :
    hardwareConcurrency >= 8 ? 0.5 : 0.0;
  const memScore =
    deviceMemoryGb == null ? 0.5 :
    deviceMemoryGb >= 8 ? 1.0 :
    deviceMemoryGb >= 4 ? 0.5 : 0.0;

  const total = textureScore + webGpuScore + cpuScore + memScore;
  if (total >= 4.0) return "H";
  if (total >= 2.0) return "M";
  return "L";
}

export function detectTierFromEnvironment(): TierLevel {
  return detectTier();
}

/**
 * Attempt to read capability signals from an existing WebGL context.
 * Falls back to environment-level detection when WebGL is unavailable.
 */
export function detectTierFromContext(
  gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined
): TierLevel {
  if (gl == null) return detectTierFromEnvironment();
  const maxTextureSize = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) ?? 4096;
  return detectTier(maxTextureSize);
}


/** Telemetry snapshot for policy audit and benchmark comparison. */
export interface PolicyTelemetry {
  tier: TierLevel;
  tierSource: "detected" | "override";
  mode: RuntimeMode;
  constraints: UserConstraints;
  activePolicy: ActivePolicy;
  /** True when legacyMode: true bypasses all tier/mode policy. */
  legacyMode: boolean;
}

/** Build a telemetry record from current policy state. */
export function buildPolicyTelemetry(
  tier: TierLevel,
  tierSource: "detected" | "override",
  mode: RuntimeMode,
  constraints: UserConstraints,
  activePolicy: ActivePolicy,
  legacyMode: boolean
): PolicyTelemetry {
  return { tier, tierSource, mode, constraints, activePolicy, legacyMode };
}
