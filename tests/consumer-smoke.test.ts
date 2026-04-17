import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("consumer smoke imports", () => {
  test("main entry declaration exports expected symbols", () => {
    const dts = readFileSync(resolve(process.cwd(), "dist/index.d.ts"), "utf8");
    expect(dts).toContain("PointCloudDropzone");
    expect(dts).toContain("mergeChunkStreams");
    expect(dts).toContain("usePointCloudSession");
    expect(dts).toContain('export * from "./config"');
  });

  test("laz subpath declaration exports laz loader", () => {
    const dts = readFileSync(resolve(process.cwd(), "dist/laz.d.ts"), "utf8");
    expect(dts).toContain("createLazLoader");
  });

  test("copc subpath declaration exports component and strategy type", () => {
    const dts = readFileSync(resolve(process.cwd(), "dist/copc/index.d.ts"), "utf8");
    expect(dts).toContain("CopcPointCloud");
    expect(dts).toContain("CopcPrefetchStrategy");
  });

  test("config subpath declaration exports config helpers", () => {
    const dts = readFileSync(resolve(process.cwd(), "dist/config/index.d.ts"), "utf8");
    expect(dts).toContain('export * from "./pointflow-config"');
  });
});
