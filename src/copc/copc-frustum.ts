/**
 * COPC frustum / LOD tile selection.
 *
 * Pure math only — no Three.js imports — so this module is fully testable in jsdom.
 */

import type { VoxelKey, CopcInfo, CopcNode } from "./copc-types";
import { voxelKeyString } from "./copc-types";
import { DEFAULT_ATLAS_TIERS, maxAtlasPointsPerSlot } from "./copc-atlas-manager";

const DEFAULT_MAX_POINTS_PER_TILE = maxAtlasPointsPerSlot(DEFAULT_ATLAS_TIERS);

/**
 * Extract 6 frustum planes from a view-projection matrix stored in
 * column-major order (the WebGL / Three.js convention).
 *
 * Returns an array of 6 planes, each represented as [a, b, c, d] where the
 * plane equation is  a*x + b*y + c*z + d >= 0  for visible points.
 *
 * Standard Gribb-Hartmann method.
 */
export function extractFrustumPlanes(vpMatrix: number[]): number[][] {
  const m = vpMatrix; // column-major 4×4
  // Element (row r, col c) is at index r + c*4.
  const m00 = m[0],  m10 = m[1],  m20 = m[2],  m30 = m[3];
  const m01 = m[4],  m11 = m[5],  m21 = m[6],  m31 = m[7];
  const m02 = m[8],  m12 = m[9],  m22 = m[10], m32 = m[11];
  const m03 = m[12], m13 = m[13], m23 = m[14], m33 = m[15];

  // Row 3 of the matrix (0-indexed) — used to combine with other rows.
  // For column-major storage: row r, col c → m[r + c*4].
  const planes: number[][] = [
    // Left:   row3 + row0
    [m30 + m00, m31 + m01, m32 + m02, m33 + m03],
    // Right:  row3 - row0
    [m30 - m00, m31 - m01, m32 - m02, m33 - m03],
    // Bottom: row3 + row1
    [m30 + m10, m31 + m11, m32 + m12, m33 + m13],
    // Top:    row3 - row1
    [m30 - m10, m31 - m11, m32 - m12, m33 - m13],
    // Near:   row3 + row2
    [m30 + m20, m31 + m21, m32 + m22, m33 + m23],
    // Far:    row3 - row2
    [m30 - m20, m31 - m21, m32 - m22, m33 - m23],
  ];

  // Normalise each plane so the distance term is meaningful.
  for (const p of planes) {
    const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    if (len > 0) { p[0] /= len; p[1] /= len; p[2] /= len; p[3] /= len; }
  }

  return planes;
}


/**
 * Test whether an axis-aligned bounding box is inside or intersecting the
 * frustum defined by the given planes.
 *
 * Returns false only if the box is entirely outside at least one plane.
 */
export function aabbInFrustum(
  planes: number[][],
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): boolean {
  for (const [a, b, c, d] of planes) {
    // The "positive vertex" for this plane (the corner most in the direction
    // of the plane normal) must have a non-negative signed distance.
    const px = a >= 0 ? maxX : minX;
    const py = b >= 0 ? maxY : minY;
    const pz = c >= 0 ? maxZ : minZ;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}


/**
 * Compute the world-space AABB for a VoxelKey given the CopcInfo.
 * Returns [minX, minY, minZ, maxX, maxY, maxZ].
 */
export function voxelBounds(
  key: VoxelKey,
  info: CopcInfo,
): [number, number, number, number, number, number] {
  const [cx, cy, cz] = info.center;
  const hs = info.halfsize;

  // At depth 0 the root voxel is center ± halfsize.
  // At depth d, each voxel has side length (2 * halfsize) / 2^d.
  const step = (2 * hs) / Math.pow(2, key.depth);

  const minX = cx - hs + key.x * step;
  const minY = cy - hs + key.y * step;
  const minZ = cz - hs + key.z * step;
  const maxX = minX + step;
  const maxY = minY + step;
  const maxZ = minZ + step;

  return [minX, minY, minZ, maxX, maxY, maxZ];
}


/**
 * Compute a simple screen-space projected radius for a voxel given camera
 * position.  Higher value → more detail needed.
 */
function projectedRadius(
  key: VoxelKey,
  info: CopcInfo,
  cameraPos: [number, number, number],
): number {
  const [minX, minY, minZ, maxX, maxY, maxZ] = voxelBounds(key, info);
  const voxelRadius = ((maxX - minX) + (maxY - minY) + (maxZ - minZ)) / 6; // avg half-side

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  const dx = cx - cameraPos[0];
  const dy = cy - cameraPos[1];
  const dz = cz - cameraPos[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  return voxelRadius / Math.max(dist, 1);
}


/**
 * DFS from the root voxel key; for each node that is:
 *   1. Present in the nodes map
 *   2. Visible (AABB intersects frustum)
 *   3. Has a projected radius above the LOD threshold OR is at depth 0
 *
 * …include it in the result set. Children are explored only when the parent
 * was included and depth < maxDepth.
 */
export function selectVisibleTiles(
  nodes: Map<string, CopcNode>,
  info: CopcInfo,
  vpMatrix: number[],
  cameraPos: [number, number, number],
  lodThreshold = 0.002,
  maxDepth = 12,
  minPointsPerNode = 10,
  maxPointsPerTile = DEFAULT_MAX_POINTS_PER_TILE,
): VoxelKey[] {
  const planes = extractFrustumPlanes(vpMatrix);
  const result: VoxelKey[] = [];
  const stack: VoxelKey[] = [{ depth: 0, x: 0, y: 0, z: 0 }];

  while (stack.length > 0) {
    const key = stack.pop()!;
    const keyStr = voxelKeyString(key);

    const node = nodes.get(keyStr);
    if (!node) continue;
    if (node.byteSize === 0n) continue;

    const isSubtreePage = node.pointCount === -1n;
    const [minX, minY, minZ, maxX, maxY, maxZ] = voxelBounds(key, info);
    if (!aabbInFrustum(planes, minX, minY, minZ, maxX, maxY, maxZ)) continue;

    const pr = projectedRadius(key, info, cameraPos);
    const actualPoints = isSubtreePage ? 0 : Number(node.pointCount);
    const densityFactor = actualPoints > 0
      ? Math.min(1, Math.log10(actualPoints + 1) / 3)
      : 0;
    const adjustedPR = pr * Math.max(densityFactor, 0.5);
    const selected = key.depth === 0 || adjustedPR > lodThreshold;
    const isLeaf = !isSubtreePage && actualPoints < minPointsPerNode;
    const oversize = !isSubtreePage && actualPoints > maxPointsPerTile;

    if (!isSubtreePage && selected && !isLeaf && !oversize) {
      result.push(key);
    }

    const recurse =
      key.depth < maxDepth &&
      !isLeaf &&
      (oversize || isSubtreePage || selected || adjustedPR > lodThreshold * 0.3);

    if (recurse) {
      for (let cx = 0; cx <= 1; cx++) {
        for (let cy = 0; cy <= 1; cy++) {
          for (let cz = 0; cz <= 1; cz++) {
            stack.push({
              depth: key.depth + 1,
              x: key.x * 2 + cx,
              y: key.y * 2 + cy,
              z: key.z * 2 + cz,
            });
          }
        }
      }
    }
  }

  return result;
}

export function adaptCopcConcurrency(
  current: number,
  maxConcurrent: number,
  frameTimeMs: number,
  overBudgetStreak: number,
  underBudgetStreak: number,
): { next: number; overBudgetStreak: number; underBudgetStreak: number } {
  let over = overBudgetStreak;
  let under = underBudgetStreak;
  let next = current;

  if (frameTimeMs > 28) {
    over += 1;
    under = 0;
    if (over >= 3) {
      next = Math.max(2, current - 1);
      over = 0;
    }
  } else if (frameTimeMs < 15) {
    under += 1;
    over = 0;
    if (under >= 3) {
      next = Math.min(maxConcurrent, current + 1);
      under = 0;
    }
  } else {
    over = 0;
    under = 0;
  }

  return { next, overBudgetStreak: over, underBudgetStreak: under };
}

export function rotateCandidatesForFairness<T>(candidates: T[], cursor: number): T[] {
  if (candidates.length <= 1) return candidates;
  const start = cursor % candidates.length;
  if (start === 0) return candidates;
  return candidates.slice(start).concat(candidates.slice(0, start));
}

