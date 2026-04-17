import { describe, expect, it } from "vitest";
import { PointBuffer } from "../src/core/backpressure";
import type { PointRecord } from "../src/core/types";

function makePoints(n: number, start = 0): PointRecord[] {
  return Array.from({ length: n }, (_, i) => ({ x: start + i, y: 0, z: 0 }));
}

describe("PointBuffer", () => {
  it("drops oldest points when mode is drop-oldest", () => {
    const buffer = new PointBuffer({ maxPoints: 5, mode: "drop-oldest" });
    buffer.ingest(makePoints(3, 0));
    buffer.ingest(makePoints(4, 3));

    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(5);
    expect(snapshot[0].x).toBe(2);
    expect(snapshot[4].x).toBe(6);
    expect(buffer.getStats().droppedPoints).toBe(2);
  });

  it("drops newest points when mode is drop-newest", () => {
    const buffer = new PointBuffer({ maxPoints: 5, mode: "drop-newest" });
    buffer.ingest(makePoints(3, 0));
    buffer.ingest(makePoints(4, 3));

    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(5);
    expect(snapshot[0].x).toBe(0);
    expect(snapshot[4].x).toBe(4);
    expect(buffer.getStats().droppedPoints).toBe(2);
  });

  it("snapshot returns newest points in insertion order after ring-buffer wrap", () => {
    const buffer = new PointBuffer({ maxPoints: 3, mode: "drop-oldest" });
    const pts = Array.from({ length: 6 }, (_, i) => ({ x: i, y: 0, z: 0 }));
    buffer.ingest(pts);

    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0].x).toBe(3);
    expect(snapshot[1].x).toBe(4);
    expect(snapshot[2].x).toBe(5);
    expect(buffer.getStats().droppedPoints).toBe(3);
  });

  it("copyToTypedArrays writes xyz and returns point count at stride 1", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    buffer.ingest([{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }]);
    const positions = new Float32Array(12);
    const colors = new Float32Array(12);
    const count = buffer.copyToTypedArrays(positions, colors, 1, undefined);
    expect(count).toBe(2);
    expect(positions[0]).toBe(1);
    expect(positions[1]).toBe(2);
    expect(positions[2]).toBe(3);
    expect(positions[3]).toBe(4);
    expect(positions[4]).toBe(5);
    expect(positions[5]).toBe(6);
    expect(colors[0]).toBe(1); // white
    expect(colors[1]).toBe(1);
    expect(colors[2]).toBe(1);
  });

  it("copyToTypedArrays at stride 2 samples every other point", () => {
    const buffer = new PointBuffer({ maxPoints: 6, mode: "drop-oldest" });
    buffer.ingest(Array.from({ length: 6 }, (_, i) => ({ x: i, y: 0, z: 0 })));
    const positions = new Float32Array(18);
    const colors = new Float32Array(18);
    const count = buffer.copyToTypedArrays(positions, colors, 2, undefined);
    expect(count).toBe(3);
    expect(positions[0]).toBe(0);
    expect(positions[3]).toBe(2);
    expect(positions[6]).toBe(4);
  });

  it("copyToTypedArrays returns 0 after reset", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    buffer.ingest([{ x: 1, y: 2, z: 3 }]);
    buffer.reset();
    const positions = new Float32Array(12);
    const colors = new Float32Array(12);
    const count = buffer.copyToTypedArrays(positions, colors, 1, undefined);
    expect(count).toBe(0);
  });

  it("copyToTypedArrays throws for non-positive stride", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    buffer.ingest([{ x: 1, y: 2, z: 3 }]);
    const positions = new Float32Array(12);
    const colors = new Float32Array(12);

    expect(() => buffer.copyToTypedArrays(positions, colors, 0, undefined)).toThrow(
      "stride must be a positive integer"
    );
    expect(() => buffer.copyToTypedArrays(positions, colors, -1, undefined)).toThrow(
      "stride must be a positive integer"
    );
  });

  it("ingestFromBinary writes xyz into SoA and is readable via copyToTypedArrays", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    const xyz = new Float32Array([1, 2, 3, 4, 5, 6]);
    buffer.ingestFromBinary(xyz, undefined, 2);

    expect(buffer.getStats().totalPoints).toBe(2);
    const positions = new Float32Array(12);
    const colors = new Float32Array(12);
    const count = buffer.copyToTypedArrays(positions, colors, 1, undefined);
    expect(count).toBe(2);
    expect(positions[0]).toBe(1);
    expect(positions[1]).toBe(2);
    expect(positions[2]).toBe(3);
    expect(positions[3]).toBe(4);
  });

  it("ingestFromBinary snapshot synthesizes PointRecord for binary slots", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    buffer.ingestFromBinary(new Float32Array([10, 20, 30]), undefined, 1);
    const snap = buffer.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].x).toBe(10);
    expect(snap[0].y).toBe(20);
    expect(snap[0].z).toBe(30);
  });

  it("ingestFromBinary produces equivalent getStats as ingest on same input", () => {
    const pts = Array.from({ length: 6 }, (_, i) => ({ x: i, y: 0, z: 0 }));
    const xyz = new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z]));

    const bufAoS = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    bufAoS.ingest(pts);

    const bufBin = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    bufBin.ingestFromBinary(xyz, undefined, 6);

    expect(bufBin.getStats()).toEqual(bufAoS.getStats());
  });

  it("ingestFromBinary respects drop-newest backpressure", () => {
    const buffer = new PointBuffer({ maxPoints: 2, mode: "drop-newest" });
    buffer.ingestFromBinary(
      new Float32Array([1, 0, 0, 2, 0, 0, 3, 0, 0]),
      undefined, 3
    );
    expect(buffer.getStats().totalPoints).toBe(2);
    expect(buffer.getStats().droppedPoints).toBe(1);
  });

  it("ingestFromBinary mixes correctly with AoS ingest for snapshot and copyToTypedArrays", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    buffer.ingest([{ x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }]);
    buffer.ingestFromBinary(new Float32Array([30, 0, 0, 40, 0, 0]), undefined, 2);

    expect(buffer.getStats().totalPoints).toBe(4);
    const snap = buffer.snapshot();
    expect(snap.map((p) => p.x)).toEqual([10, 20, 30, 40]);
    const positions = new Float32Array(12);
    const colors = new Float32Array(12);
    const n = buffer.copyToTypedArrays(positions, colors, 1, undefined);
    expect(n).toBe(4);
    expect(positions[0]).toBe(10);
    expect(positions[9]).toBe(40);
  });

  it("resets points and pressure counters", () => {
    const buffer = new PointBuffer({ maxPoints: 3, mode: "drop-oldest" });
    buffer.ingest(makePoints(5));
    expect(buffer.getStats().droppedPoints).toBeGreaterThan(0);

    buffer.reset();

    expect(buffer.snapshot()).toHaveLength(0);
    expect(buffer.getStats().droppedPoints).toBe(0);
    expect(buffer.getStats().isUnderPressure).toBe(false);
  });

  it("binary-ingested multi-attribute channels remain correct across colorBy switches", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    const xyz = new Float32Array([1, 0, 0, 2, 0, 0, 3, 0, 0]);
    buffer.ingestFromBinary(xyz, [
      { key: "velocity", values: new Float32Array([0.2, 0.5, 0.8]), present: new Uint8Array([1, 1, 1]) },
      { key: "intensity", values: new Float32Array([0.8, 0.5, 0.2]), present: new Uint8Array([1, 1, 1]) }
    ], 3);

    const positions = new Float32Array(27);
    const colors = new Float32Array(27);
    buffer.copyToTypedArrays(positions, colors, 1, "velocity");
    expect(positions[0]).toBe(1);
    expect(positions[3]).toBe(2);
    expect(positions[6]).toBe(3);
    const r0 = colors[0];
    const r1 = colors[3];
    const r2 = colors[6];
    expect(r0).toBeLessThanOrEqual(1);
    expect(r1).toBeLessThanOrEqual(1);
    expect(r2).toBeLessThanOrEqual(1);
    expect(r0).toBeLessThan(r2);

    buffer.copyToTypedArrays(positions, colors, 1, "intensity");
    expect(colors[0]).toBeGreaterThan(colors[6]);

    buffer.copyToTypedArrays(positions, colors, 1, "velocity");
    expect(colors[0]).toBe(r0);
    expect(colors[3]).toBe(r1);
    expect(colors[6]).toBe(r2);
  });

  it("binary-ingested snapshot reconstructs multi-attribute payloads", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    const xyz = new Float32Array([1, 0, 0, 2, 0, 0]);
    buffer.ingestFromBinary(xyz, [
      { key: "velocity", values: new Float32Array([0.5, 0.6]), present: new Uint8Array([1, 1]) },
      { key: "intensity", values: new Float32Array([0.9, 0]), present: new Uint8Array([1, 0]) }
    ], 2);

    const snapshot = buffer.snapshot();
    expect(snapshot[0].attributes?.velocity).toBeCloseTo(0.5);
    expect(snapshot[0].attributes?.intensity).toBeCloseTo(0.9);
    expect(snapshot[1].attributes?.velocity).toBeCloseTo(0.6);
    expect(snapshot[1].attributes?.intensity).toBeUndefined();
  });

  it("binary-ingested points use 0 for non-packed colorBy attribute", () => {
    const buffer = new PointBuffer({ maxPoints: 4, mode: "drop-oldest" });
    const xyz = new Float32Array([1, 0, 0, 2, 0, 0]);
    buffer.ingestFromBinary(xyz, [
      { key: "velocity", values: new Float32Array([0.5, 0.5]), present: new Uint8Array([1, 1]) }
    ], 2);

    const positions = new Float32Array(18);
    const colors = new Float32Array(18);
    const n = buffer.copyToTypedArrays(positions, colors, 1, "otherKey");
    expect(n).toBe(2);
    expect(positions[0]).toBe(1);
    expect(positions[3]).toBe(2);
    expect(colors[0]).toBe(colors[3]);
    expect(colors[1]).toBe(colors[4]);
    expect(colors[2]).toBe(colors[5]);
  });

  it("range cache starts dirty and becomes clean after first colorBy render", () => {
    const buffer = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });
    buffer.ingest([{ x: 0, y: 0, z: 0, attributes: { v: 1 } }]);

    expect(buffer.getRangeCache().dirty).toBe(true);

    const positions = new Float32Array(30);
    const colors = new Float32Array(30);
    buffer.copyToTypedArrays(positions, colors, 1, "v");

    expect(buffer.getRangeCache().dirty).toBe(false);
  });

  it("range cache is marked dirty when drop-oldest evicts current extremum", () => {
    const buffer = new PointBuffer({ maxPoints: 3, mode: "drop-oldest" });
    buffer.ingest([
      { x: 0, y: 0, z: 0, attributes: { v: 1 } },
      { x: 1, y: 0, z: 0, attributes: { v: 5 } },
      { x: 2, y: 0, z: 0, attributes: { v: 8 } },
    ]);

    const positions = new Float32Array(9);
    const colors = new Float32Array(9);
    buffer.copyToTypedArrays(positions, colors, 1, "v");
    expect(buffer.getRangeCache().dirty).toBe(false);

    buffer.ingest([{ x: 3, y: 0, z: 0, attributes: { v: 6 } }]);
    expect(buffer.getRangeCache().dirty).toBe(true);
  });

  it("generation stamps prevent stale binary attributes from leaking on slot reuse", () => {
    const buffer = new PointBuffer({ maxPoints: 2, mode: "drop-oldest" });
    buffer.ingestFromBinary(
      new Float32Array([1, 0, 0, 2, 0, 0]),
      [{ key: "velocity", values: new Float32Array([0.5, 0.8]), present: new Uint8Array([1, 1]) }],
      2
    );

    buffer.ingestFromBinary(new Float32Array([3, 0, 0]), [], 1);
    const snapshot = buffer.snapshot();
    const reused = snapshot.find((p) => p.x === 3);

    expect(reused).toBeDefined();
    expect(reused!.attributes?.velocity).toBeUndefined();
  });

  it("copyToTypedArrays respects renderBudget cap", () => {
    const buffer = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });
    buffer.ingest(Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0, z: 0 })));

    const positions = new Float32Array(30);
    const colors = new Float32Array(30);
    const count = buffer.copyToTypedArrays(positions, colors, 1, undefined, 3);

    expect(count).toBe(3);
  });
});
