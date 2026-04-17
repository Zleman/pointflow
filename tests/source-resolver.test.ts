import { describe, expect, test, vi } from "vitest";
import { resolvePointCloudSource } from "../src/parsers/source-resolver";

describe("resolvePointCloudSource", () => {
  test("resolves string URLs", () => {
    const out = resolvePointCloudSource("/scan.ply");
    expect(out.url).toBe("/scan.ply");
    expect(out.sourceKind).toBe("url");
    out.revoke();
  });

  test("resolves URL object", () => {
    const out = resolvePointCloudSource(new URL("https://example.com/a.ply"));
    expect(out.url).toBe("https://example.com/a.ply");
    expect(out.sourceKind).toBe("url");
    out.revoke();
  });

  test("resolves Request object", () => {
    const out = resolvePointCloudSource(new Request("https://example.com/a.ply"));
    expect(out.url).toBe("https://example.com/a.ply");
    expect(out.sourceKind).toBe("request");
    out.revoke();
  });

  test("appends extension hint for File sources", () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    });
    const createSpy = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    const revokeSpy = URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
    const file = new File(["x y z"], "scan.laz", { type: "application/octet-stream" });
    const out = resolvePointCloudSource(file);
    expect(out.sourceKind).toBe("file");
    expect(out.url).toBe("blob:test#.laz");
    out.revoke();
    expect(createSpy).toHaveBeenCalledWith(file);
    expect(revokeSpy).toHaveBeenCalledWith("blob:test");
    vi.unstubAllGlobals();
  });
});
