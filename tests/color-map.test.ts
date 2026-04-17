import { describe, expect, it } from "vitest";
import { mapScalarToRgb, writeScalarToRgbBuffer } from "../src/core/color-map";

describe("mapScalarToRgb", () => {
  it("clamps values below min and above max", () => {
    const low = mapScalarToRgb(-10, 0, 100, "blue-red");
    const high = mapScalarToRgb(1000, 0, 100, "blue-red");

    expect(low).toEqual({ r: 30, g: 80, b: 240 });
    expect(high).toEqual({ r: 240, g: 60, b: 40 });
  });

  it("maps midpoint in grayscale", () => {
    const mid = mapScalarToRgb(50, 0, 100, "grayscale");
    expect(mid).toEqual({ r: 128, g: 128, b: 128 });
  });

  it("handles zero range safely", () => {
    const color = mapScalarToRgb(5, 10, 10, "grayscale");
    expect(color).toEqual({ r: 128, g: 128, b: 128 });
  });

  it("writes normalized RGB values to Float32Array", () => {
    const out = new Float32Array(3);
    writeScalarToRgbBuffer(50, 0, 100, out, 0, "grayscale");
    expect(out[0]).toBeCloseTo(128 / 255, 6);
    expect(out[1]).toBeCloseTo(128 / 255, 6);
    expect(out[2]).toBeCloseTo(128 / 255, 6);
  });

  it("matches mapScalarToRgb output for the same scalar", () => {
    const rgb = mapScalarToRgb(25, 0, 100, "blue-red");
    const out = new Float32Array(3);
    writeScalarToRgbBuffer(25, 0, 100, out, 0, "blue-red");
    expect(out[0]).toBeCloseTo(rgb.r / 255, 6);
    expect(out[1]).toBeCloseTo(rgb.g / 255, 6);
    expect(out[2]).toBeCloseTo(rgb.b / 255, 6);
  });

  it("writes to arbitrary buffer offsets without mutating unrelated entries", () => {
    const out = new Float32Array(9);
    writeScalarToRgbBuffer(50, 0, 100, out, 3, "blue-red");

    expect(out[0]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[6]).toBe(0);
    expect(out[3]).toBeGreaterThan(0);
    expect(out[4]).toBeGreaterThan(0);
    expect(out[5]).toBeGreaterThan(0);
  });
});
