import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePointFlow } from "../src/hooks/usePointFlow";
import type { PointChunk, PointRecord } from "../src/core/types";

function makeChunk(n: number, start = 0): PointChunk {
  const points: PointRecord[] = Array.from({ length: n }, (_, i) => ({
    x: start + i,
    y: 0,
    z: 0
  }));
  return { points };
}

describe("usePointFlow", () => {
  it("pushing a chunk updates totalPoints correctly", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 10_000, lodLevels: 3 })
    );
    expect(result.current.totalPoints).toBe(0);
    act(() => {
      result.current.pushChunk(makeChunk(50));
    });
    expect(result.current.totalPoints).toBe(50);
    act(() => {
      result.current.pushChunk(makeChunk(30, 50));
    });
    expect(result.current.totalPoints).toBe(80);
  });

  it("pushing chunks beyond maxPoints triggers isUnderPressure: true", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 100, lodLevels: 2 })
    );
    expect(result.current.isUnderPressure).toBe(false);
    act(() => {
      result.current.pushChunk(makeChunk(150));
    });
    expect(result.current.isUnderPressure).toBe(true);
  });

  it("calling reset() clears totalPoints to 0 and droppedPoints to 0", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 50, lodLevels: 2 })
    );
    act(() => {
      result.current.pushChunk(makeChunk(100));
    });
    expect(result.current.totalPoints).toBe(50);
    expect(result.current.droppedPoints).toBeGreaterThan(0);
    act(() => {
      result.current.reset();
    });
    expect(result.current.totalPoints).toBe(0);
    expect(result.current.droppedPoints).toBe(0);
  });

  it("lodBuckets.length equals the lodLevels option passed in", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 1000, lodLevels: 5 })
    );
    expect(result.current.lodBuckets).toHaveLength(5);
  });

  it("responds to maxPoints change by reconfiguring buffer", () => {
    const { result, rerender } = renderHook(
      (opts) => usePointFlow(opts),
      { initialProps: { maxPoints: 100, lodLevels: 2 } }
    );
    act(() => {
      result.current.pushChunk(makeChunk(80));
    });
    expect(result.current.totalPoints).toBe(80);
    rerender({ maxPoints: 50, lodLevels: 2 });
    expect(result.current.totalPoints).toBe(0);
    act(() => {
      result.current.pushChunk(makeChunk(60));
    });
    expect(result.current.totalPoints).toBe(50);
  });

  it("responds to mode change by reconfiguring buffer", () => {
    const { result, rerender } = renderHook(
      (opts) => usePointFlow(opts),
      { initialProps: { maxPoints: 50, lodLevels: 2, mode: "drop-oldest" as const } }
    );

    act(() => {
      result.current.pushChunk(makeChunk(80));
    });
    expect(result.current.totalPoints).toBe(50);
    expect(result.current.droppedPoints).toBe(30);

    rerender({ maxPoints: 50, lodLevels: 2, mode: "drop-newest" as const });
    expect(result.current.totalPoints).toBe(0);
    expect(result.current.droppedPoints).toBe(0);

    act(() => {
      result.current.pushChunk(makeChunk(80));
    });
    expect(result.current.totalPoints).toBe(50);
    expect(result.current.droppedPoints).toBe(30);
  });

  it("supports decoupled ingest mode with explicit refresh", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 100, lodLevels: 2, reactivePush: false })
    );

    expect(result.current.totalPoints).toBe(0);
    act(() => {
      result.current.pushChunk(makeChunk(40));
    });
    expect(result.current.totalPoints).toBe(0);

    act(() => {
      result.current.refresh();
    });
    expect(result.current.totalPoints).toBe(40);
  });

  it("refreshStats updates counters without rebuilding point snapshots", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 100, lodLevels: 2, reactivePush: false })
    );

    expect(result.current.totalPoints).toBe(0);
    expect(result.current.points).toHaveLength(0);

    act(() => {
      result.current.pushChunk(makeChunk(20));
    });

    expect(result.current.totalPoints).toBe(0);
    expect(result.current.points).toHaveLength(0);

    act(() => {
      result.current.refreshStats();
    });

    expect(result.current.totalPoints).toBe(20);
    expect(result.current.points).toHaveLength(0);
  });

  it("accepts workerMode option and ingest works via fallback when Worker unavailable", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 100, lodLevels: 2, workerMode: true })
    );
    expect(result.current.totalPoints).toBe(0);
    act(() => {
      result.current.pushChunk(makeChunk(30));
    });
    expect(result.current.totalPoints).toBe(30);
  });

  it("renderIntoBuffers reads different AoS attributes when colorBy changes", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 100, lodLevels: 2 })
    );
    act(() => {
      result.current.pushChunk({
        points: [
          { x: 0, y: 0, z: 0, attributes: { velocity: 0.1, intensity: 0.9 } },
          { x: 1, y: 0, z: 0, attributes: { velocity: 0.9, intensity: 0.1 } }
        ]
      });
    });

    const positions = new Float32Array(6);
    const colors = new Float32Array(6);
    result.current.renderIntoBuffers(positions, colors, 1, "velocity");
    const velocityFirstRed = colors[0];
    const velocitySecondRed = colors[3];

    result.current.renderIntoBuffers(positions, colors, 1, "intensity");
    expect(colors[0]).toBeGreaterThan(colors[3]);
    expect(velocityFirstRed).toBeLessThan(velocitySecondRed);
  });

  it("reset in worker mode clears buffer so subsequent ingest is not polluted", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 50, lodLevels: 2, workerMode: true })
    );
    act(() => {
      result.current.pushChunk(makeChunk(40));
    });
    expect(result.current.totalPoints).toBe(40);
    act(() => {
      result.current.reset();
    });
    expect(result.current.totalPoints).toBe(0);
    act(() => {
      result.current.pushChunk(makeChunk(20));
    });
    expect(result.current.totalPoints).toBe(20);
  });

  it("applies runtime policy render budget and user cap precedence", () => {
    const { result } = renderHook(() =>
      usePointFlow({
        maxPoints: 1_000_000,
        lodLevels: 2,
        tier: "H",
        runtimeMode: "max_throughput",
        constraints: { pointBudgetCap: 3 }
      })
    );

    act(() => {
      result.current.pushChunk(makeChunk(20));
    });

    const positions = new Float32Array(60);
    const colors = new Float32Array(60);
    const rendered = result.current.renderIntoBuffers(positions, colors, 1, undefined);
    expect(rendered).toBe(3);
    expect(result.current.activePolicy.pointBudget).toBe(3);
  });

  it("legacyMode bypasses M4.5 policy cap and keeps render uncapped", () => {
    const { result } = renderHook(() =>
      usePointFlow({
        maxPoints: 50,
        lodLevels: 2,
        legacyMode: true,
        tier: "L",
        runtimeMode: "eco",
        constraints: { pointBudgetCap: 2 }
      })
    );

    act(() => {
      result.current.pushChunk(makeChunk(10));
    });

    const positions = new Float32Array(90);
    const colors = new Float32Array(90);
    const rendered = result.current.renderIntoBuffers(positions, colors, 1, undefined);
    expect(rendered).toBe(10);
    expect(Number.isFinite(result.current.activePolicy.pointBudget)).toBe(false);
  });

  it("survives repeated reset/push races in worker mode", () => {
    const { result } = renderHook(() =>
      usePointFlow({ maxPoints: 200, lodLevels: 2, workerMode: true })
    );

    for (let i = 0; i < 20; i++) {
      act(() => {
        result.current.pushChunk(makeChunk(30, i * 30));
      });
      act(() => {
        result.current.reset();
      });
      expect(result.current.totalPoints).toBe(0);
    }

    act(() => {
      result.current.pushChunk(makeChunk(25));
    });
    expect(result.current.totalPoints).toBe(25);
  });
});
