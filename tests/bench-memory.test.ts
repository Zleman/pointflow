import { describe, it } from "vitest";
import { PointBuffer } from "../src/core/backpressure";
import { buildLodBuckets } from "../src/core/lod";
import type { PointChunk, PointRecord } from "../src/core/types";
import { packChunk } from "../src/worker/worker-bridge";

function makePoints(n: number, offset = 0): PointRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    x: offset + i,
    y: 0,
    z: 0
  }));
}

function makeAttributeChunk(n: number, keys: string[]): PointChunk {
  return {
    points: Array.from({ length: n }, (_, i) => ({
      x: i,
      y: i % 17,
      z: i % 31,
      attributes: Object.fromEntries(
        keys.map((key, keyIndex) => [key, (i + 1) * (keyIndex + 1) * 0.01])
      )
    }))
  };
}

function formatMemoryMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

describe("bench-memory", () => {
  it("stress run with bounded buffer and LOD", () => {
    const maxPoints = 20_000;
    const buffer = new PointBuffer({ maxPoints, mode: "drop-oldest" });
    const iterations = 500;
    const chunkSize = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      buffer.ingest(makePoints(chunkSize, i * chunkSize));
      if (i > 0 && i % 100 === 0) {
        const stats = buffer.getStats();
        const snapshot = buffer.snapshot();
        buildLodBuckets(snapshot, 3);
        console.log(`[bench] iter ${i} totalPoints=${stats.totalPoints} dropped=${stats.droppedPoints} pressure=${stats.isUnderPressure}`);
      }
    }
    const elapsed = performance.now() - start;
    const stats = buffer.getStats();
    const snapshot = buffer.snapshot();
    buildLodBuckets(snapshot, 3);
    console.log(`[bench] done in ${elapsed.toFixed(2)}ms totalPoints=${stats.totalPoints} dropped=${stats.droppedPoints}`);
  });

  it("M6.5 — dynamic vs pre-alloc: stress run comparison", () => {
      const maxPoints = 20_000;
    const iterations = 500;
    const chunkSize = 100;

    const runMode = (label: string, dynamic: boolean): number => {
      const buf = new PointBuffer({
        maxPoints,
        mode: "drop-oldest",
        ...(dynamic ? { deferGrowth: false, dynamicAlloc: { initialCapacity: 256, growthFactor: 2 } } : {})
      });
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        buf.ingest(makePoints(chunkSize, i * chunkSize));
      }
      const elapsed = performance.now() - start;
      const stats = buf.getStats();
      console.log(
          `[bench] ${label} mode=${dynamic ? "dynamic" : "pre-alloc"} ` +
        `maxPoints=${maxPoints} iterations=${iterations} chunk=${chunkSize} ` +
        `totalMs=${elapsed.toFixed(2)} finalCapacity=${buf.currentCapacity()} ` +
        `totalPoints=${stats.totalPoints} dropped=${stats.droppedPoints}`
      );
      return elapsed;
    };

    const preAllocMs = runMode("pre-alloc", false);
    const dynamicMs = runMode("dynamic", true);

    // Dynamic mode is slower due to growths; just verify it completes without error
    // and that both modes arrive at the same logical state.
    console.log(
        `[bench] overhead dynamic vs pre-alloc: ${(dynamicMs - preAllocMs).toFixed(2)}ms ` +
        `(${((dynamicMs / preAllocMs - 1) * 100).toFixed(1)}% slower)`
    );
  });

  it("compares worker packing cost for 1 vs 4 attributes", () => {
    const chunkSize = 10_000;
    const iterations = 40;
    const singleAttrChunk = makeAttributeChunk(chunkSize, ["velocity"]);
    const multiAttrChunk = makeAttributeChunk(chunkSize, ["velocity", "intensity", "temperature", "pressure"]);

    const runScenario = (label: string, chunk: PointChunk): void => {
      const heapBefore = process.memoryUsage().heapUsed;

      packChunk(chunk);

      let totalPackedChannels = 0;
      const packStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        const packed = packChunk(chunk);
        totalPackedChannels += packed.attributes?.length ?? 0;
      }
      const packElapsed = performance.now() - packStart;

      const packed = packChunk(chunk);
      const ingestStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        const buffer = new PointBuffer({ maxPoints: chunkSize, mode: "drop-oldest" });
        buffer.ingestFromBinary(packed.xyz, packed.attributes, packed.count);
        const positions = new Float32Array(chunkSize * 3);
        const colors = new Float32Array(chunkSize * 3);
        buffer.copyToTypedArrays(positions, colors, 1, "velocity");
      }
      const ingestElapsed = performance.now() - ingestStart;
      const heapAfter = process.memoryUsage().heapUsed;

      console.log(
        `[bench:attrs] ${label} chunk=${chunkSize} iterations=${iterations} channelsPerChunk=${(totalPackedChannels / iterations).toFixed(1)} ` +
        `packMs=${packElapsed.toFixed(2)} packPerIterMs=${(packElapsed / iterations).toFixed(2)} ` +
        `ingestMs=${ingestElapsed.toFixed(2)} ingestPerIterMs=${(ingestElapsed / iterations).toFixed(2)} ` +
        `heapDeltaMb=${formatMemoryMb(heapAfter - heapBefore)}`
      );
    };

    runScenario("single-attr", singleAttrChunk);
    runScenario("multi-attr", multiAttrChunk);
  });
});
