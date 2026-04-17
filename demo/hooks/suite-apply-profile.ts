import type { AttributeProfile } from "../constants";
import type { TestProfile } from "../test-suite";

export function applySuiteProfileSettings(
  profile: TestProfile,
  actions: {
    setDemoMode: (mode: "stream" | "file" | "compare") => void;
    setBenchmarkProfileId: (value: string) => void;
    setCustomMaxPoints: (value: number) => void;
    setMaxPoints: (value: number) => void;
    setCustomPointsPerChunk: (value: number) => void;
    setCustomIntervalMs: (value: number) => void;
    setCustomDurationSec: (value: number) => void;
    setAutoLod: (value: boolean) => void;
    setFrustumCulling: (value: boolean) => void;
    setRequestedBackend: (value: string) => void;
    setAttributeProfile: (value: AttributeProfile) => void;
    setColorBy: (value: string) => void;
    setImportanceField: (value: string) => void;
    setMaxStalenessMs: (value: number) => void;
    setImportanceSamplingEnabled: (value: boolean) => void;
    setTimeWindowMs: (value: number) => void;
  }
): void {
  actions.setDemoMode("stream");
  actions.setBenchmarkProfileId("custom");
  actions.setCustomMaxPoints(profile.maxPoints);
  actions.setMaxPoints(profile.maxPoints);
  actions.setCustomPointsPerChunk(profile.pointsPerChunk);
  actions.setCustomIntervalMs(profile.intervalMs);
  actions.setCustomDurationSec(profile.durationSec);
  actions.setAutoLod(profile.autoLod);
  actions.setFrustumCulling(profile.frustumCulling);
  actions.setRequestedBackend(profile.requestedBackend);
  actions.setAttributeProfile(profile.attributeProfile);
  actions.setColorBy(profile.colorBy);
  actions.setImportanceField(profile.importanceField);
  actions.setMaxStalenessMs(profile.maxStalenessMs);
  actions.setImportanceSamplingEnabled(profile.importanceSamplingEnabled);
  actions.setTimeWindowMs(profile.timeWindowMs);
}
