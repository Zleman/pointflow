import { describe, expect, test, vi } from "vitest";
import { mergeChunkStreams, withSourceTag } from "../src/transport/merge-adapter";
import type { PointChunk } from "../src/core/types";

describe("merge adapter", () => {
  test("withSourceTag injects sourceId and receivedAt", () => {
    const seen: PointChunk[] = [];
    const emit = withSourceTag("lidar-A", (chunk) => seen.push(chunk));
    emit({ points: [{ x: 1, y: 2, z: 3 }] });
    expect(seen[0].sourceId).toBe("lidar-A");
    expect(typeof seen[0].receivedAt).toBe("number");
  });

  test("mergeChunkStreams wires cleanup for all sources", () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    const merged: PointChunk[] = [];
    const stop = mergeChunkStreams(
      [
        (emit) => { emit({ points: [{ x: 0, y: 0, z: 0 }] }); return stopA; },
        (emit) => { emit({ points: [{ x: 1, y: 1, z: 1 }] }); return stopB; },
      ],
      (chunk) => merged.push(chunk),
    );
    expect(merged).toHaveLength(2);
    stop();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
  });
});
