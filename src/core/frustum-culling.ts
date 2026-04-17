import { Frustum, Matrix4, Vector3 } from "three";

/**
 * Pool of Three.js objects for per-frame frustum culling.
 * Allocated once per PointCloudScene instance; mutated in-place each frame
 * to avoid per-frame GC pressure during camera motion.
 *
 * Usage:
 *   const pool = createFrustumCullPool();           // once at mount
 *   updateFrustumPool(pool, projMatrix, viewInv);   // once per frame
 *   buffer.copyToTypedArrays(..., pool.predicate);  // stable closure, no alloc
 */
export interface FrustumCullPool {
  readonly frustum: Frustum;
  /** Scratch matrix reused for projectionMatrix * matrixWorldInverse. */
  readonly matrix: Matrix4;
  /** Scratch Vector3 reused on each containsPoint call. */
  readonly v3: Vector3;
  /**
   * Stable predicate closure — valid after updateFrustumPool() for the frame.
   * The same function reference is reused across all frames; no per-frame closure.
   */
  readonly predicate: (x: number, y: number, z: number) => boolean;
}

/** Allocate a FrustumCullPool. Call once per PointCloudScene instance. */
export function createFrustumCullPool(): FrustumCullPool {
  const frustum = new Frustum();
  const matrix = new Matrix4();
  const v3 = new Vector3();
  return {
    frustum,
    matrix,
    v3,
    predicate: (x: number, y: number, z: number) =>
      frustum.containsPoint(v3.set(x, y, z)),
  };
}

/**
 * Update the pool's frustum in-place from the camera's current matrices.
 * Zero allocations. Call once per frame before using pool.predicate.
 *
 * @param projectionMatrix   camera.projectionMatrix
 * @param matrixWorldInverse camera.matrixWorldInverse (updated by R3F each frame)
 */
export function updateFrustumPool(
  pool: FrustumCullPool,
  projectionMatrix: Matrix4,
  matrixWorldInverse: Matrix4
): void {
  pool.matrix.multiplyMatrices(projectionMatrix, matrixWorldInverse);
  pool.frustum.setFromProjectionMatrix(pool.matrix);
}
