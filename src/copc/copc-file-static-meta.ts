import type { CopcFileStaticMeta, CopcHierarchyCompleteness } from "../core/types";
import type { CopcIndex, VoxelKey } from "./copc-types";
import { voxelKeyString } from "./copc-types";
import { DEFAULT_ATLAS_TIERS, maxAtlasPointsPerSlot } from "./copc-atlas-manager";

function computeHierarchyCompleteness(
  nodes: CopcIndex["nodes"],
  maxPointsPerSlot: number,
): CopcHierarchyCompleteness {
  const nodesByDepth = new Map<number, number>();
  let nodesWithChildren = 0;
  let nodesWithoutChildren = 0;
  let nodesOversizeNoChildren = 0;
  let maxDepthFound = 0;

  for (const node of nodes.values()) {
    const depth = node.key.depth;
    nodesByDepth.set(depth, (nodesByDepth.get(depth) ?? 0) + 1);
    maxDepthFound = Math.max(maxDepthFound, depth);

    let hasChildren = false;
 outer:
    for (let cx = 0; cx <= 1; cx++) {
      for (let cy = 0; cy <= 1; cy++) {
        for (let cz = 0; cz <= 1; cz++) {
          const childKey: VoxelKey = {
            depth: depth + 1,
            x: node.key.x * 2 + cx,
            y: node.key.y * 2 + cy,
            z: node.key.z * 2 + cz,
          };
          if (nodes.has(voxelKeyString(childKey))) {
            hasChildren = true;
            break outer;
          }
        }
      }
    }

    if (hasChildren) {
      nodesWithChildren++;
    } else {
      nodesWithoutChildren++;
      const pc = Number(node.pointCount);
      if (pc > maxPointsPerSlot) {
        nodesOversizeNoChildren++;
      }
    }
  }

  const totalNodes = nodesWithChildren + nodesWithoutChildren;
  const completenessRatio = totalNodes > 0 ? nodesWithChildren / totalNodes : 0;

  return {
    totalNodes,
    nodesWithChildren,
    nodesWithoutChildren,
    nodesOversizeNoChildren,
    completenessRatio,
    maxDepthFound,
    nodesByDepth: Object.fromEntries(nodesByDepth),
  };
}

export function buildCopcFileStaticMeta(
  index: CopcIndex,
  opts: {
    sourceLabel: string | null;
    sourceSrc: string;
    maxCacheMb: number;
    maxConcurrent: number;
    persistCache: boolean;
    maxDepthUser: number;
  },
): CopcFileStaticMeta {
  const { info, lasHeader, nodes } = index;
  const h = info.halfsize;
  const c = info.center;
  const bboxMin: [number, number, number] = [c[0] - h, c[1] - h, c[2] - h];
  const bboxMax: [number, number, number] = [c[0] + h, c[1] + h, c[2] + h];

  let maxTreeDepth = 0;
  for (const keyStr of nodes.keys()) {
    const d = Number.parseInt(keyStr.split("-")[0] ?? "", 10);
    if (!Number.isNaN(d)) maxTreeDepth = Math.max(maxTreeDepth, d);
  }

  let declared = 0n;
  for (const n of nodes.values()) {
    if (n.pointCount >= 0n) declared += n.pointCount;
  }

  const cap = BigInt(Number.MAX_SAFE_INTEGER);
  const declaredTotalPointsCapped = declared > cap;
  const declaredTotalPoints = declaredTotalPointsCapped
    ? Number.MAX_SAFE_INTEGER
    : Number(declared);

  const dx = bboxMax[0] - bboxMin[0];
  const dy = bboxMax[1] - bboxMin[1];
  const dz = bboxMax[2] - bboxMin[2];
  const bboxHalfDiagonalM = Math.hypot(dx, dy, dz) / 2;
  const bboxCubeSpaceDiagonalM = Math.sqrt(3) * 2 * h;

  const maxSlot = maxAtlasPointsPerSlot(DEFAULT_ATLAS_TIERS);
  const hierarchyCompleteness = computeHierarchyCompleteness(nodes, maxSlot);
  if (hierarchyCompleteness.nodesOversizeNoChildren > 0) {
    console.warn(
      `[COPC] Hierarchy: ${hierarchyCompleteness.nodesOversizeNoChildren} oversize nodes have no children ` +
      `in the index. Close-range views may look sparse in those regions. ` +
      `Consider regenerating COPC with a deeper hierarchy.`,
    );
  }

  return {
    sourceLabel: opts.sourceLabel,
    sourceSrc: opts.sourceSrc,
    indexNodeCount: nodes.size,
    maxTreeDepth,
    declaredTotalPoints,
    declaredTotalPointsCapped,
    copcSpacing: info.spacing,
    copcHalfsize: h,
    center: [c[0], c[1], c[2]],
    bboxMin,
    bboxMax,
    bboxHalfDiagonalM,
    bboxCubeSpaceDiagonalM,
    gpsMin: info.gpsMin,
    gpsMax: info.gpsMax,
    lasPointFormat: lasHeader.pointFormat,
    lasPointRecLen: lasHeader.pointRecLen,
    lasAttributeKeys: [...lasHeader.attributeKeys],
    maxCacheMb: opts.maxCacheMb,
    maxConcurrent: opts.maxConcurrent,
    persistCache: opts.persistCache,
    maxDepthUser: opts.maxDepthUser,
    hierarchyCompleteness,
  };
}
