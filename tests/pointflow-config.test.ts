import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePointFlow } from "../src/hooks/usePointFlow";
import { usePointCloud } from "../src/hooks/usePointCloud";
import { definePointFlowConfig, resolvePointFlowConfig } from "../src/config";
import type { PointChunk, PointRecord } from "../src/core/types";

function makeChunk(n: number): PointChunk {
  const points: PointRecord[] = Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: 0 }));
  return { points };
}

function makeFakeWorker() {
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
  };
}

describe("pointflow config resolution", () => {
  it("merges nested config sections", () => {
    const base = definePointFlowConfig({
      global: { rendererBackend: "auto", frustumCulling: true },
      streamed: { lodLevels: 2 },
      hooks: { usePointFlow: { maxPoints: 100 } },
    });
    const overrides = definePointFlowConfig({
      global: { frustumCulling: false },
      streamed: { mode: "drop-newest" },
      hooks: { usePointFlow: { maxPoints: 250 } },
    });
    const resolved = resolvePointFlowConfig(base, overrides);
    expect(resolved.global?.rendererBackend).toBe("auto");
    expect(resolved.global?.frustumCulling).toBe(false);
    expect(resolved.streamed?.lodLevels).toBe(2);
    expect(resolved.streamed?.mode).toBe("drop-newest");
    expect(resolved.hooks?.usePointFlow?.maxPoints).toBe(250);
  });

  it("applies global defaults when explicit values are omitted", () => {
    const config = definePointFlowConfig({
      global: { maxPoints: 4 },
      hooks: { usePointFlow: { lodLevels: 2 } },
    });
    const { result } = renderHook(() => usePointFlow({ config }));
    act(() => {
      result.current.pushChunk(makeChunk(10));
    });
    expect(result.current.totalPoints).toBe(4);
  });

  it("uses streamed config over global config when no explicit value exists", () => {
    const config = definePointFlowConfig({
      global: { maxPoints: 3 },
      streamed: { maxPoints: 6 },
      hooks: { usePointFlow: { lodLevels: 2 } },
    });
    const { result } = renderHook(() => usePointFlow({ config }));
    act(() => {
      result.current.pushChunk(makeChunk(10));
    });
    expect(result.current.totalPoints).toBe(6);
  });

  it("uses explicit options over config values", () => {
    const config = definePointFlowConfig({
      global: { maxPoints: 3 },
      streamed: { maxPoints: 5 },
      hooks: { usePointFlow: { maxPoints: 8, lodLevels: 2 } },
    });
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 9, lodLevels: 2, config }),
    );
    act(() => {
      result.current.pushChunk(makeChunk(20));
    });
    expect(result.current.totalPoints).toBe(9);
  });

  it("uses pointCloud hook defaults for chunkSize precedence", () => {
    const worker = makeFakeWorker();
    const config = definePointFlowConfig({
      pointCloud: { chunkSize: 750 },
      hooks: { usePointCloud: { chunkSize: 250 } },
    });
    const { unmount } = renderHook(() =>
      usePointCloud("/scan.ply", {
        loaderFactory: () => worker as unknown as Worker,
        config,
      }),
    );
    const payload = worker.postMessage.mock.calls[0]?.[0] as { chunkSize: number };
    expect(payload.chunkSize).toBe(750);
    unmount();
  });

  it("uses explicit usePointCloud options over config values", () => {
    const worker = makeFakeWorker();
    const config = definePointFlowConfig({
      pointCloud: { chunkSize: 750 },
      hooks: { usePointCloud: { chunkSize: 250 } },
    });
    const { unmount } = renderHook(() =>
      usePointCloud("/scan.ply", {
        chunkSize: 125,
        loaderFactory: () => worker as unknown as Worker,
        config,
      }),
    );
    const payload = worker.postMessage.mock.calls[0]?.[0] as { chunkSize: number };
    expect(payload.chunkSize).toBe(125);
    unmount();
  });
});
