import { describe, expect, it } from "vitest";
import { createFrustumCullPool, updateFrustumPool } from "../src/core/frustum-culling";
import { makeCamera } from "./helpers/camera";

describe("createFrustumCullPool", () => {
  it("returns an object with frustum, matrix, v3, and predicate", () => {
    const pool = createFrustumCullPool();
    expect(pool.frustum).toBeDefined();
    expect(pool.matrix).toBeDefined();
    expect(pool.v3).toBeDefined();
    expect(typeof pool.predicate).toBe("function");
  });

  it("pool objects are reused across updateFrustumPool calls (no new allocation)", () => {
    const pool = createFrustumCullPool();
    const { frustum, matrix, v3, predicate } = pool;

    const c1 = makeCamera(0, 0, 10);
    const c2 = makeCamera(10, 0, 0);
    updateFrustumPool(pool, c1.projectionMatrix, c1.matrixWorldInverse);
    updateFrustumPool(pool, c2.projectionMatrix, c2.matrixWorldInverse);

    expect(pool.frustum).toBe(frustum);
    expect(pool.matrix).toBe(matrix);
    expect(pool.v3).toBe(v3);
    expect(pool.predicate).toBe(predicate);
  });
});

describe("updateFrustumPool + predicate: deterministic culling", () => {
  it("point at origin is visible when camera looks at origin", () => {
    const camera = makeCamera(0, 0, 10);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);
    expect(pool.predicate(0, 0, 0)).toBe(true);
  });

  it("point behind camera is not visible", () => {
    const camera = makeCamera(0, 0, 10);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);
    expect(pool.predicate(0, 0, 20)).toBe(false);
  });

  it("point beyond far plane is not visible", () => {
    const camera = makeCamera(0, 0, 10, 75, 0.1, 5);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);
    expect(pool.predicate(0, 0, 0)).toBe(false);
  });

  it("point within near/far range and in frustum is visible", () => {
    const camera = makeCamera(0, 0, 10, 75, 1, 20);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);
    expect(pool.predicate(0, 0, 0)).toBe(true);
  });

  it("is deterministic: same camera + same point always gives the same result", () => {
    const camera = makeCamera(0, 0, 10);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    const r1 = pool.predicate(0, 0, 0);
    const r2 = pool.predicate(0, 0, 0);
    const r3 = pool.predicate(0, 0, 0);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1).toBe(true);
  });

  it("frustum changes after updateFrustumPool: point invisible with old camera is visible after reorientation", () => {
    const pool = createFrustumCullPool();

    const c1 = makeCamera(0, 0, 10, 30);
    updateFrustumPool(pool, c1.projectionMatrix, c1.matrixWorldInverse);
    expect(pool.predicate(50, 0, 0)).toBe(false);

    const c2 = makeCamera(100, 0, 0, 75);
    updateFrustumPool(pool, c2.projectionMatrix, c2.matrixWorldInverse);
    expect(pool.predicate(50, 0, 0)).toBe(true);
  });

  it("narrow FOV excludes points wide of the axis", () => {
    const camera = makeCamera(0, 0, 10, 5, 0.1, 100);
    const pool = createFrustumCullPool();
    updateFrustumPool(pool, camera.projectionMatrix, camera.matrixWorldInverse);

    expect(pool.predicate(0, 0, 0)).toBe(true);   // center: visible
    expect(pool.predicate(5, 0, 0)).toBe(false);  // wide side: clipped
  });
});
