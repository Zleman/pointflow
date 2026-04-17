import { extractFrustumPlanes, aabbInFrustum } from "./copc-frustum";
import type { AtlasManager } from "./copc-atlas-manager";

export interface CopcLodCutNode {
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  error: number;
  pointCount: number;
  childIds: number[];
}

export function computeCopcLodCut(
  nodes: CopcLodCutNode[],
  roots: readonly number[],
  atlas: AtlasManager,
  vpElements: number[],
  focalLength: number,
  lodThreshold: number,
  frustumCulling: boolean,
  touchAtlas = true,
): number[] {
  const planes = frustumCulling ? extractFrustumPlanes(vpElements) : null;
  const selected: number[] = [];
  const stack = [...roots];

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    const node   = nodes[nodeId];
    if (!node) continue;

    if (planes && !aabbInFrustum(planes,
      node.bboxMin[0], node.bboxMin[1], node.bboxMin[2],
      node.bboxMax[0], node.bboxMax[1], node.bboxMax[2],
    )) continue;

    const cx = (node.bboxMin[0] + node.bboxMax[0]) * 0.5;
    const cy = (node.bboxMin[1] + node.bboxMax[1]) * 0.5;
    const cz = (node.bboxMin[2] + node.bboxMax[2]) * 0.5;
    const vp = vpElements;
    const clipW = vp[3] * cx + vp[7] * cy + vp[11] * cz + vp[15];
    if (clipW <= 0) continue;

    const screenError = (node.error * focalLength) / clipW;
    const isLeaf      = node.childIds.length === 0;
    const hasLoadedChild = node.childIds.some(c => atlas.getSlot(c) !== -1);

    if (screenError < lodThreshold || isLeaf) {
      if (atlas.getSlot(nodeId) !== -1) {
        selected.push(nodeId);
        if (touchAtlas) atlas.touch(nodeId);
      }
    } else {
      for (const c of node.childIds) stack.push(c);
      if (!hasLoadedChild && atlas.getSlot(nodeId) !== -1) {
        selected.push(nodeId);
        if (touchAtlas) atlas.touch(nodeId);
      }
    }
  }
  return selected;
}
