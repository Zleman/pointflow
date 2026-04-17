import { TEST_PROFILES, estimatedSuiteDurationSec } from "../test-suite";

export function fmtSec(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function getSuiteProgressMeta(suiteCurrentIdx: number, suiteTotalProfiles: number): { progressPct: number; remainingSec: number; estimatedSec: number } {
  const progressPct = suiteTotalProfiles > 0
    ? Math.round((suiteCurrentIdx / suiteTotalProfiles) * 100)
    : 0;
  const estimatedSec = estimatedSuiteDurationSec();
  const remainingProfiles = suiteTotalProfiles - suiteCurrentIdx;
  const avgSecPerProfile = estimatedSec / Math.max(1, TEST_PROFILES.filter((p) => !p.manual).length);
  const remainingSec = Math.round(remainingProfiles * avgSecPerProfile);
  return { progressPct, remainingSec, estimatedSec };
}
