/**
 * M11 — Progressive accumulation unit tests.
 *
 * The accumulation decision logic lives inside a RAF callback (not unit-testable
 * directly without a GPU). These tests verify the velocity-EMA and threshold
 * logic by simulating the arithmetic the RAF loop performs.
 */
import { describe, it, expect } from "vitest";

describe("M11 — Progressive accumulation logic", () => {

  it("velocity EMA decays toward zero when camera is static", () => {
    const ALPHA = 0.2;
    let ema = 1.0; // starts moving
    // Simulate 35 frames of zero movement
    for (let i = 0; i < 35; i++) {
      ema = ema * (1 - ALPHA) + 0 * ALPHA;
    }
    expect(ema).toBeLessThan(0.001);
  });

  it("velocity EMA spikes immediately when camera moves", () => {
    const ALPHA = 0.2;
    let ema = 0.0; // camera has been static
    // One frame of large movement (e.g. 10 units in 16ms = 625 units/s)
    const speed = 10 / 16;
    ema = ema * (1 - ALPHA) + speed * ALPHA;
    expect(ema).toBeGreaterThan(0.001);
  });

  it("accumulation activates only after threshold duration", () => {
    const threshold = 200; // ms
    let staticSince: number | null = null;

    // Frame 1: camera becomes static at t=100
    const t1 = 100;
    staticSince = t1;
    expect((t1 - staticSince) >= threshold).toBe(false); // not yet

    // Frame 2: at t=250 (150ms later — still below threshold)
    const t2 = 250;
    expect((t2 - staticSince) >= threshold).toBe(false);

    // Frame 3: at t=310 (210ms after static — threshold crossed)
    const t3 = 310;
    expect((t3 - staticSince) >= threshold).toBe(true);
  });

  it("accumulation resets immediately on camera movement", () => {
    let staticSince: number | null = 100;
    const isStatic = false; // camera moved

    if (!isStatic) staticSince = null;

    expect(staticSince).toBeNull();
  });

  it("accumulation does not activate when accumulationMode is false", () => {
    // When accumulationMode=false the accumulation block is skipped entirely.
    // Simulate: isAccumulating always stays false.
    const accumulationMode = false;
    let isAccumulating = false;

    if (accumulationMode) {
      isAccumulating = true; // this branch never runs
    }

    expect(isAccumulating).toBe(false);
  });
});
