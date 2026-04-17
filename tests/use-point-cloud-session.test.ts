import { describe, expect, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePointCloudSession } from "../src/hooks/usePointCloudSession";

describe("usePointCloudSession", () => {
  test("saves and restores session record", () => {
    const { result } = renderHook(() => usePointCloudSession("pf.session.test"));
    result.current.clearSession();
    result.current.saveSession({ src: "/scan.ply", colorBy: "intensity", label: "scan" });
    const restored = result.current.restoreSession();
    expect(restored?.src).toBe("/scan.ply");
    expect(restored?.colorBy).toBe("intensity");
    expect(restored?.label).toBe("scan");
    result.current.clearSession();
  });
});
