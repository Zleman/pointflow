import type { BenchmarkPassResult } from "../benchmark";
import type { FeatureSnapshot } from "./useBenchmarkRunner";
import type { SuiteFeatureMetrics, SuiteProfileResult, TestProfile } from "../test-suite";

export function buildFeatureMetrics(snapshot: FeatureSnapshot): SuiteFeatureMetrics {
  return {
    effectiveLodLevel: snapshot.effectiveLodLevel,
    cameraDistance: snapshot.cameraDistance,
    oldestRetainedAgeMs: snapshot.oldestRetainedAgeMs > 0 ? snapshot.oldestRetainedAgeMs : undefined,
    windowedCount: snapshot.temporalWindowedCount > 0 ? snapshot.temporalWindowedCount : undefined,
    totalCount: snapshot.temporalTotalCount > 0 ? snapshot.temporalTotalCount : undefined,
    windowedRatio: snapshot.temporalTotalCount > 0
      ? snapshot.temporalWindowedCount / snapshot.temporalTotalCount
      : undefined,
  };
}

export function createSuiteProfileResult(
  profile: TestProfile,
  passResult: BenchmarkPassResult,
  featureMetrics: SuiteFeatureMetrics
): SuiteProfileResult {
  return {
    profileId: profile.id,
    profileLabel: profile.label,
    profileDescription: profile.description,
    passResult,
    featureMetrics,
    capturedAt: new Date().toISOString(),
  };
}

export function createSkippedSuiteResult(profile: TestProfile): SuiteProfileResult {
  return {
    profileId: profile.id,
    profileLabel: profile.label,
    profileDescription: profile.description,
    passResult: {} as BenchmarkPassResult,
    featureMetrics: {},
    capturedAt: new Date().toISOString(),
    skipped: true,
  };
}
