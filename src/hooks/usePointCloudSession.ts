import { useCallback } from "react";

export interface PointCloudSessionRecord {
  src: string;
  colorBy?: string;
  label?: string;
  updatedAtIso: string;
}

export function usePointCloudSession(storageKey = "pointflow.session.v1") {
  const saveSession = useCallback((record: Omit<PointCloudSessionRecord, "updatedAtIso">) => {
    if (typeof localStorage === "undefined") return;
    const next: PointCloudSessionRecord = {
      ...record,
      updatedAtIso: new Date().toISOString(),
    };
    localStorage.setItem(storageKey, JSON.stringify(next));
  }, [storageKey]);

  const restoreSession = useCallback((): PointCloudSessionRecord | null => {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PointCloudSessionRecord>;
      if (!parsed.src || typeof parsed.src !== "string") return null;
      return {
        src: parsed.src,
        colorBy: parsed.colorBy,
        label: parsed.label,
        updatedAtIso: parsed.updatedAtIso ?? new Date(0).toISOString(),
      };
    } catch {
      return null;
    }
  }, [storageKey]);

  const clearSession = useCallback(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(storageKey);
  }, [storageKey]);

  return { saveSession, restoreSession, clearSession };
}
