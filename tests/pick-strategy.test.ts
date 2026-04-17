import { describe, expect, test } from "vitest";
import { pickNearestPoint, type PickBuffer } from "../src/core/point-buffer-queries";

function identityVp(): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

function makeBuf(): PickBuffer {
  return {
    size: 2,
    capacity: 2,
    head: 0,
    xs: new Float32Array([0, 0.001]),
    ys: new Float32Array([0, 0.001]),
    zs: new Float32Array([0.5, 0.5]),
    importanceBuffer: new Float32Array([0.2, 0.9]),
    items: [{ x: 0, y: 0, z: 0.5, attributes: { a: 1 } }, { x: 0.001, y: 0.001, z: 0.5, attributes: { a: 2 } }],
    packedAttrValuesByKey: new Map(),
    packedAttrPresenceByKey: new Map(),
    slotTimestampMs: new Float32Array([10, 100]),
  };
}

describe("pick strategy", () => {
  test("highestImportance prefers importance over distance", () => {
    const hit = pickNearestPoint(makeBuf(), identityVp(), 400, 300, 800, 600, 20, "highestImportance");
    expect(hit?.attributes.a).toBe(2);
  });

  test("nearest prefers nearest point", () => {
    const hit = pickNearestPoint(makeBuf(), identityVp(), 400, 300, 800, 600, 20, "nearest");
    expect(hit?.attributes.a).toBe(1);
  });

  test("recentFirst prefers newest point", () => {
    const hit = pickNearestPoint(makeBuf(), identityVp(), 400, 300, 800, 600, 20, "recentFirst");
    expect(hit?.attributes.a).toBe(2);
  });
});
