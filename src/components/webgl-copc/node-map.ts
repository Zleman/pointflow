import type { CopcIndex, VoxelKey } from "../../copc/copc-types";
import { voxelKeyString } from "../../copc/copc-types";
import { voxelBounds } from "../../copc/copc-frustum";

export interface CpuNode {
  nodeId: number;
  key: VoxelKey;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  error: number;
  pointCount: number;
  childIds: number[];
}

export function buildNodeMap(
  index: CopcIndex,
  maxDepth: number,
  keyToId: Map<string, number>,
  nodes: CpuNode[],
  roots: number[],
  maxNodes: number
): void {
  keyToId.clear();
  nodes.length = 0;
  roots.length = 0;

  const queue: VoxelKey[] = [{ depth: 0, x: 0, y: 0, z: 0 }];
  let head = 0;

  while (head < queue.length) {
    const key = queue[head++];
    const ks = voxelKeyString(key);
    if (!index.nodes.has(ks)) continue;
    const node = index.nodes.get(ks);
    if (!node) continue;
    if (node.byteSize === 0n || key.depth > maxDepth || keyToId.has(ks)) continue;

    const nodeId = nodes.length;
    if (nodeId >= maxNodes) break;
    keyToId.set(ks, nodeId);

    const [minX, minY, minZ, maxX, maxY, maxZ] = voxelBounds(key, index.info);
    nodes.push({
      nodeId,
      key,
      bboxMin: [minX, minY, minZ],
      bboxMax: [maxX, maxY, maxZ],
      error: index.info.spacing / Math.pow(2, key.depth),
      pointCount: node.pointCount === -1n ? 0 : Number(node.pointCount),
      childIds: [],
    });
    if (key.depth === 0) roots.push(nodeId);

    if (key.depth < maxDepth) {
      for (let cx = 0; cx <= 1; cx++) {
        for (let cy = 0; cy <= 1; cy++) {
          for (let cz = 0; cz <= 1; cz++) {
            queue.push({ depth: key.depth + 1, x: key.x * 2 + cx, y: key.y * 2 + cy, z: key.z * 2 + cz });
          }
        }
      }
    }
  }

  for (const entry of nodes) {
    if (entry.key.depth === 0) continue;
    const parentKey = {
      depth: entry.key.depth - 1,
      x: Math.floor(entry.key.x / 2),
      y: Math.floor(entry.key.y / 2),
      z: Math.floor(entry.key.z / 2),
    };
    const parentId = keyToId.get(voxelKeyString(parentKey));
    if (parentId !== undefined) nodes[parentId].childIds.push(entry.nodeId);
  }
}
