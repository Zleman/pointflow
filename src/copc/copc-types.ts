/**
 * COPC type definitions.
 * Covers VoxelKey, CopcInfo, CopcNode, CopcIndex, and the minimal LAS header
 * fields needed to decode tiles with laz-perf ChunkDecoder.
 */

export interface VoxelKey {
  depth: number;
  x: number;
  y: number;
  z: number;
}

/** Stable string key for Maps / Sets. */
export function voxelKeyString(k: VoxelKey): string {
  return `${k.depth}-${k.x}-${k.y}-${k.z}`;
}

export function parseVoxelKeyString(s: string): VoxelKey {
  const [depth, x, y, z] = s.split("-").map(Number);
  return { depth, x, y, z };
}


export interface CopcInfo {
  center: [number, number, number];
  halfsize: number;
  spacing: number;
  rootHierOffset: bigint;
  rootHierSize: bigint;
  gpsMin: number;
  gpsMax: number;
}


export interface CopcNode {
  key: VoxelKey;
  offset: bigint;
  byteSize: bigint;
  /** -1n = nested hierarchy page at offset, size byteSize (not LAZ data). */
  pointCount: bigint;
}


export interface CopcLasHeader {
  pointFormat: number;
  pointRecLen: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  /** centroid derived from bounding box (minX+maxX)/2 etc. */
  centroidX: number;
  centroidY: number;
  centroidZ: number;
  /** Attribute keys available for this point format. */
  attributeKeys: string[];
}


export interface CopcIndex {
  info: CopcInfo;
  lasHeader: CopcLasHeader;
  nodes: Map<string, CopcNode>;
}
