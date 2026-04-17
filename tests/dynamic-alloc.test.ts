/**
* Dynamic Buffer Allocation acceptance tests.
 *
 * Acceptance criteria:
 * 1. Pre-alloc path unchanged when dynamicAlloc is absent.
 * 2. Dynamic path: buffer starts at initialCapacity, grows as points are
 *    added, does not exceed maxPoints, and ingest/render correctness matches
 *    the pre-alloc path for the same stream.
 * 3. isUnderPressure reflects the hard ceiling (maxPoints) in both modes.
 */

import { describe, expect, it } from "vitest";
import { PointBuffer } from "../src/core/backpressure";
import type { PointRecord } from "../src/core/types";

function makePoints(n: number, start = 0): PointRecord[] {
  return Array.from({ length: n }, (_, i) => ({ x: start + i, y: 0, z: 0 }));
}

// ─── Pre-alloc path (no regression) ───────────────────────────────────────────

describe("pre-alloc path (dynamicAlloc absent)", () => {
  it("currentCapacity equals maxPoints from construction", () => {
    const buf = new PointBuffer({ maxPoints: 500, mode: "drop-oldest" });
    expect(buf.currentCapacity()).toBe(500);
  });

  it("capacity does not change after ingesting many points", () => {
    const buf = new PointBuffer({ maxPoints: 100, mode: "drop-oldest" });
    buf.ingest(makePoints(500));
    expect(buf.currentCapacity()).toBe(100);
  });

  it("isUnderPressure once buffer is at maxPoints", () => {
    const buf = new PointBuffer({ maxPoints: 5, mode: "drop-oldest" });
    buf.ingest(makePoints(5));
    expect(buf.getStats().isUnderPressure).toBe(true);
  });

  it("isUnderPressure is false while below maxPoints", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });
    buf.ingest(makePoints(5));
    expect(buf.getStats().isUnderPressure).toBe(false);
  });

  it("drop policy and copyToTypedArrays unchanged", () => {
    const buf = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    buf.ingest(makePoints(6));
    expect(buf.getStats().totalPoints).toBe(4);
    expect(buf.getStats().droppedPoints).toBe(2);
    const pos = new Float32Array(12);
    const col = new Float32Array(12);
    expect(buf.copyToTypedArrays(pos, col, 1, undefined)).toBe(4);
  });
});

// ─── Dynamic path ─────────────────────────────────────────────────────────────

describe("dynamic path (dynamicAlloc enabled)", () => {
  it("currentCapacity starts at initialCapacity, not maxPoints", () => {
    const buf = new PointBuffer({
      maxPoints: 100_000,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 64 }
    });
    expect(buf.currentCapacity()).toBe(64);
  });

  it("defaults initialCapacity to min(1024, maxPoints) when not specified", () => {
    const bufLarge = new PointBuffer({ maxPoints: 50_000, mode: "drop-oldest", deferGrowth: false, dynamicAlloc: {} });
    expect(bufLarge.currentCapacity()).toBe(1024);

    const bufSmall = new PointBuffer({ maxPoints: 200, mode: "drop-oldest", deferGrowth: false, dynamicAlloc: {} });
    expect(bufSmall.currentCapacity()).toBe(200);
  });

  it("capacity grows when buffer fills and is below maxPoints", () => {
    const buf = new PointBuffer({
      maxPoints: 10_000,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 4, growthFactor: 2 }
    });
    expect(buf.currentCapacity()).toBe(4);
    buf.ingest(makePoints(5)); // fills initial 4 → triggers growth
    expect(buf.currentCapacity()).toBeGreaterThan(4);
  });

  it("capacity does not exceed maxPoints", () => {
    const buf = new PointBuffer({
      maxPoints: 10,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 4, growthFactor: 3 }
    });
    buf.ingest(makePoints(50));
    expect(buf.currentCapacity()).toBeLessThanOrEqual(10);
  });

  it("all ingested data is retained correctly after growth", () => {
    const buf = new PointBuffer({
      maxPoints: 100,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 4, growthFactor: 2 }
    });
    const pts = makePoints(20); // triggers multiple doublings
    buf.ingest(pts);

    const snap = buf.snapshot();
    expect(snap).toHaveLength(20);
    snap.forEach((p, i) => expect(p.x).toBe(i));
  });

  it("copyToTypedArrays produces identical output to pre-alloc for the same stream", () => {
    const pts = makePoints(30);

    const pre = new PointBuffer({ maxPoints: 50, mode: "drop-oldest" });
    pre.ingest(pts);
    const prePosArr = new Float32Array(150);
    const preColArr = new Float32Array(150);
    const preN = pre.copyToTypedArrays(prePosArr, preColArr, 1, undefined);

    const dyn = new PointBuffer({
      maxPoints: 50,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 4, growthFactor: 2 }
    });
    dyn.ingest(pts);
    const dynPosArr = new Float32Array(150);
    const dynColArr = new Float32Array(150);
    const dynN = dyn.copyToTypedArrays(dynPosArr, dynColArr, 1, undefined);

    expect(dynN).toBe(preN);
    expect(Array.from(dynPosArr.subarray(0, dynN * 3))).toEqual(Array.from(prePosArr.subarray(0, preN * 3)));
    expect(Array.from(dynColArr.subarray(0, dynN * 3))).toEqual(Array.from(preColArr.subarray(0, preN * 3)));
  });

  it("ring-buffer wrap correctness after multiple growths (drop-oldest at maxPoints)", () => {
    const buf = new PointBuffer({
      maxPoints: 8,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 2, growthFactor: 2 }
    });
    buf.ingest(makePoints(12)); // fills to maxPoints=8, drops 4
    const snap = buf.snapshot();
    expect(snap).toHaveLength(8);
    expect(snap[0].x).toBe(4); // oldest retained = index 4
    expect(snap[7].x).toBe(11);
  });

  it("drop-newest: discards incoming once at maxPoints", () => {
    const buf = new PointBuffer({
      maxPoints: 5,
      mode: "drop-newest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 2, growthFactor: 2 }
    });
    buf.ingest(makePoints(10));
    const snap = buf.snapshot();
    expect(snap).toHaveLength(5);
    expect(snap.map((p) => p.x)).toEqual([0, 1, 2, 3, 4]);
    expect(buf.getStats().droppedPoints).toBe(5);
  });

  it("isUnderPressure becomes true only at maxPoints, not at intermediate capacity", () => {
    const buf = new PointBuffer({
      maxPoints: 16,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 4, growthFactor: 2 }
    });
    buf.ingest(makePoints(4)); // fills initial cap; triggers grow to 8 — not at maxPoints
    expect(buf.getStats().isUnderPressure).toBe(false);
    buf.ingest(makePoints(12)); // now at maxPoints=16
    expect(buf.getStats().isUnderPressure).toBe(true);
  });

  it("ingestFromBinary triggers growth and data survives intact", () => {
    const buf = new PointBuffer({
      maxPoints: 200,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 8, growthFactor: 2 }
    });
    const count = 20;
    const xyz = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      xyz[i * 3] = i + 0.5;
      xyz[i * 3 + 1] = 0;
      xyz[i * 3 + 2] = 0;
    }
    buf.ingestFromBinary(xyz, undefined, count);

    expect(buf.getStats().totalPoints).toBe(count);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const n = buf.copyToTypedArrays(pos, col, 1, undefined);
    expect(n).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(pos[i * 3]).toBeCloseTo(i + 0.5);
    }
  });

  it("ingestFromBinary with packed attributes survives growth", () => {
    const buf = new PointBuffer({
      maxPoints: 500,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 4, growthFactor: 2 }
    });
    const count = 10;
    const xyz = new Float32Array(count * 3);
    const velValues = new Float32Array(count);
    const velPresent = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      xyz[i * 3] = i;
      velValues[i] = i * 0.1;
      velPresent[i] = 1;
    }
    buf.ingestFromBinary(xyz, [{ key: "velocity", values: velValues, present: velPresent }], count);

    const snap = buf.snapshot();
    expect(snap).toHaveLength(count);
    snap.forEach((p, i) => {
      expect(p.x).toBe(i);
      expect(p.attributes?.velocity).toBeCloseTo(i * 0.1);
    });
  });

  it("reset clears data; capacity stays at grown size (no shrink)", () => {
    const buf = new PointBuffer({
      maxPoints: 1000,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 4, growthFactor: 2 }
    });
    buf.ingest(makePoints(100));
    const capAfterGrowth = buf.currentCapacity();
    expect(capAfterGrowth).toBeGreaterThan(4);

    buf.reset();
    expect(buf.getStats().totalPoints).toBe(0);
    expect(buf.getStats().droppedPoints).toBe(0);
    // Buffer stays at grown size after reset (no shrink — avoids re-alloc churn)
    expect(buf.currentCapacity()).toBe(capAfterGrowth);
  });

  it("custom growthFactor is respected", () => {
    const buf = new PointBuffer({
      maxPoints: 10_000,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 10, growthFactor: 3 }
    });
    buf.ingest(makePoints(11)); // should trigger one growth: 10 * 3 = 30
    expect(buf.currentCapacity()).toBe(30);
  });

  it("colorBy attribute is preserved correctly across growth", () => {
    const pts: PointRecord[] = Array.from({ length: 20 }, (_, i) => ({
      x: i, y: 0, z: 0, attributes: { v: i * 0.1 }
    }));
    const buf = new PointBuffer({
      maxPoints: 100,
      mode: "drop-oldest",
      deferGrowth: false, dynamicAlloc: { initialCapacity: 4, growthFactor: 2 }
    });
    buf.ingest(pts);

    const pos = new Float32Array(60);
    const col = new Float32Array(60);
    const n = buf.copyToTypedArrays(pos, col, 1, "v");
    expect(n).toBe(20);
    // Colors should be a gradient: first point bluer, last point redder
    expect(col[0]).toBeLessThan(col[(n - 1) * 3]); // r channel increases
  });
});
