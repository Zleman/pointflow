/**
 * M5 integration tests: LOD + frustum culling render path.
 *
 * Covers:
 * - Rendered point count decreases when camera sees only part of the scene.
 * - Rendered count changes with camera pose (wide vs narrow view).
 * - Attribute / color accounting is correct when culling is active.
 * - Pooling: predicate reference is stable across simulated frames (no allocation spike).
 * - Benchmark: LOD/frustum off vs on comparison (console output).
 */

import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three";
import { PointBuffer } from "../src/core/backpressure";
import { createFrustumCullPool, updateFrustumPool } from "../src/core/frustum-culling";
import type { PointRecord } from "../src/core/types";
import { makeCamera } from "./helpers/camera";

function makeBuffer(points: PointRecord[]): PointBuffer {
  const buffer = new PointBuffer({ maxPoints: points.length, mode: "drop-oldest" });
  buffer.ingest(points);
  return buffer;
}

function copyAll(buffer: PointBuffer, n: number, predicate?: (x: number, y: number, z: number) => boolean): number {
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  return buffer.copyToTypedArrays(positions, colors, 1, undefined, undefined, predicate);
}


describe("M5: frustum culling reduces rendered point count", () => {
  it("all points rendered without a predicate (baseline)", () => {
    const points: PointRecord[] = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ];
    const buffer = makeBuffer(points);
    const n = copyAll(buffer, points.length);
    expect(n).toBe(3);
  });

  it("fewer points rendered when camera looks away from most of the cloud", () => {
    const points: PointRecord[] = Array.from({ length: 50 }, (_, i) => ({
      x: i * 2, y: 0, z: 0,
    }));
    const buffer = makeBuffer(points);

    const camera = makeCamera(0, 0, 30, 15, 0.1, 100);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    const nWithCulling = copyAll(buffer, points.length, pool.predicate);
    const nWithout = copyAll(buffer, points.length);

    expect(nWithCulling).toBeLessThan(nWithout);
    expect(nWithout).toBe(50);
    expect(nWithCulling).toBeGreaterThan(0);
  });

  it("rendered count changes with camera pose: wide vs narrow view", () => {
    const points: PointRecord[] = [
      { x: 0,   y: 0, z: 0 },   // near axis
      { x: 0,   y: 0, z: -5 },  // near axis
      { x: 100, y: 0, z: 0 },   // far side
      { x: 200, y: 0, z: 0 },   // far side
    ];
    const buffer = makeBuffer(points);
    const pool = createFrustumCullPool();

    const narrowCamera = makeCamera(0, 0, 20, 10, 0.1, 100);
    updateFrustumPool(pool, narrowCamera.projectionMatrix, narrowCamera.matrixWorldInverse);
    const nNarrow = copyAll(buffer, points.length, pool.predicate);

    const wideCamera = makeCamera(0, 0, 20, 170, 0.1, 1000);
    updateFrustumPool(pool, wideCamera.projectionMatrix, wideCamera.matrixWorldInverse);
    const nWide = copyAll(buffer, points.length, pool.predicate);

    expect(nWide).toBeGreaterThan(nNarrow);
  });

  it("LOD stride + frustum culling both reduce count independently", () => {
    const points: PointRecord[] = Array.from({ length: 100 }, (_, i) => ({
      x: i, y: 0, z: 0,
    }));
    const buffer = makeBuffer(points);
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);

    const nLodOnly = buffer.copyToTypedArrays(positions, colors, 2, undefined);
    expect(nLodOnly).toBe(50);

    const camera = makeCamera(0, 0, 30, 10, 0.1, 100);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);
    const nLodAndFrustum = buffer.copyToTypedArrays(positions, colors, 2, undefined, undefined, pool.predicate);

    expect(nLodAndFrustum).toBeLessThanOrEqual(nLodOnly);
  });
});

describe("M5: color/attribute accounting with frustum culling active", () => {
  it("written positions match the visible subset only", () => {
    const points: PointRecord[] = [
      { x: 0,   y: 0, z: 0 },
      { x: 500, y: 0, z: 0 },
    ];
    const buffer = makeBuffer(points);
    const positions = new Float32Array(6);
    const colors = new Float32Array(6);

    const camera = makeCamera(0, 0, 10, 10, 0.1, 100);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    const n = buffer.copyToTypedArrays(positions, colors, 1, undefined, undefined, pool.predicate);

    expect(n).toBe(1);
    expect(positions[0]).toBeCloseTo(0);
    expect(positions[1]).toBeCloseTo(0);
    expect(positions[2]).toBeCloseTo(0);
  });

  it("color values are written for visible points with colorBy active", () => {
    const points: PointRecord[] = [
      { x: 0, y: 0, z: 0,  attributes: { intensity: 0.0 } },
      { x: 0, y: 0, z: -3, attributes: { intensity: 1.0 } },
    ];
    const buffer = makeBuffer(points);
    const positions = new Float32Array(6);
    const colors = new Float32Array(6);

    const camera = makeCamera(0, 0, 10, 90, 0.1, 100);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    const n = buffer.copyToTypedArrays(positions, colors, 1, "intensity", undefined, pool.predicate);

    expect(n).toBe(2);
    const c0 = [colors[0], colors[1], colors[2]];
    const c1 = [colors[3], colors[4], colors[5]];
    expect(c0).not.toEqual(c1);
  });

  it("count return value matches number of points actually written", () => {
    const points: PointRecord[] = Array.from({ length: 10 }, (_, i) => ({
      x: i, y: 0, z: 0,
    }));
    const buffer = makeBuffer(points);
    const positions = new Float32Array(30);
    const colors = new Float32Array(30);

    const camera = makeCamera(0, 0, 30, 20, 0.1, 100);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    const n = buffer.copyToTypedArrays(positions, colors, 1, undefined, undefined, pool.predicate);

    const visibleXs = points
      .filter((p) => pool.predicate(p.x, p.y, p.z))
      .map((p) => p.x);
    expect(n).toBe(visibleXs.length);
    for (let i = 0; i < n; i++) {
      expect(positions[i * 3]).toBe(visibleXs[i]);
    }
    for (let i = n; i < 10; i++) {
      expect(positions[i * 3]).toBe(0);
    }
  });
});

describe("M5: pooling — no allocation spikes during camera motion", () => {
  it("predicate reference is stable across 200 simulated frames", () => {
    const pool = createFrustumCullPool();
    const camera = new PerspectiveCamera(75, 1, 0.1, 1000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const initialPredicate = pool.predicate;
    const initialFrustum = pool.frustum;
    const initialMatrix = pool.matrix;
    const initialV3 = pool.v3;

    for (let frame = 0; frame < 200; frame++) {
      const angle = (frame / 200) * Math.PI * 2;
      camera.position.set(Math.cos(angle) * 10, 0, Math.sin(angle) * 10);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

      expect(pool.predicate).toBe(initialPredicate);
      expect(pool.frustum).toBe(initialFrustum);
      expect(pool.matrix).toBe(initialMatrix);
      expect(pool.v3).toBe(initialV3);
    }
  });

  it("copyToTypedArrays with predicate produces consistent results across repeated calls", () => {
    const points: PointRecord[] = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 }, // outside narrow frustum
    ];
    const buffer = makeBuffer(points);
    const camera = makeCamera(0, 0, 10, 20, 0.1, 100);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    const results = Array.from({ length: 5 }, () => copyAll(buffer, points.length, pool.predicate));
    expect(new Set(results).size).toBe(1); // all identical
    expect(results[0]).toBeGreaterThan(0);
    expect(results[0]).toBeLessThan(3);
  });
});

describe("M5: bench — LOD/frustum off vs on comparison", () => {
  it("measures render cost with and without frustum culling (100k points, 100 frames)", () => {
    const N = 100_000;
    const pts: PointRecord[] = Array.from({ length: N }, (_, i) => ({
      x: (i / N) * 1000 - 500,
      y: ((i * 7) % 20) - 10,
      z: ((i * 13) % 20) - 10,
    }));
    const buffer = makeBuffer(pts);
    const positions = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);

    const camera = new PerspectiveCamera(60, 1, 0.1, 200);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    const FRAMES = 100;

    let totalNoCull = 0;
    const t0NoCull = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      totalNoCull += buffer.copyToTypedArrays(positions, colors, 1, undefined);
    }
    const msNoCull = performance.now() - t0NoCull;

    let totalCull = 0;
    const t0Cull = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      totalCull += buffer.copyToTypedArrays(positions, colors, 1, undefined, undefined, pool.predicate);
    }
    const msCull = performance.now() - t0Cull;

    const avgNoCull = totalNoCull / FRAMES;
    const avgCull = totalCull / FRAMES;

    console.log(
      `[bench:m5] points=${N} frames=${FRAMES} ` +
      `noCull avgPts=${avgNoCull.toFixed(0)} ${msNoCull.toFixed(1)}ms | ` +
      `frustumCull avgPts=${avgCull.toFixed(0)} ${msCull.toFixed(1)}ms ` +
      `reduction=${(((avgNoCull - avgCull) / avgNoCull) * 100).toFixed(1)}%`
    );
    expect(avgCull).toBeLessThanOrEqual(avgNoCull);
  }, 15000);

  it("release matrix smoke keeps frustum benefit across consecutive runs", () => {
    const N = 40_000;
    const pts: PointRecord[] = Array.from({ length: N }, (_, i) => ({
      x: (i / N) * 600 - 300,
      y: ((i * 7) % 40) - 20,
      z: ((i * 13) % 40) - 20,
    }));
    const buffer = makeBuffer(pts);
    const positions = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const camera = new PerspectiveCamera(60, 1, 0.1, 200);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    const passes: boolean[] = [];
    for (let run = 0; run < 3; run++) {
      let noCull = 0;
      let cull = 0;
      for (let f = 0; f < 30; f++) {
        noCull += buffer.copyToTypedArrays(positions, colors, 1, undefined);
        cull += buffer.copyToTypedArrays(positions, colors, 1, undefined, undefined, pool.predicate);
      }
      passes.push(cull <= noCull);
    }
    expect(passes.every(Boolean)).toBe(true);
  });
});
