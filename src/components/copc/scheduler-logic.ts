import { voxelBounds } from "../../copc/copc-frustum";

export type VoxelCandidate = { depth: number; x: number; y: number; z: number };
export type PrefetchStrategy = "frustum-priority" | "depth-first" | "nearest" | "bandwidth-saver";
export type CopcInfoForBounds = { cube: [number, number, number, number, number, number] };

export function sortCandidatesByStrategy(params: {
  strategy: PrefetchStrategy;
  candidates: VoxelCandidate[];
  info: CopcInfoForBounds;
  vpPresent: boolean;
  predictedCam: [number, number, number] | null;
  cameraPos: [number, number, number] | null;
}): void {
  const { strategy, candidates, info, vpPresent, predictedCam, cameraPos } = params;
  const distanceToPredicted = (key: VoxelCandidate): number => {
    if (!predictedCam) return 0;
    const bb = voxelBounds(key, info as any);
    const cx = (bb[0] + bb[3]) * 0.5;
    const cy = (bb[1] + bb[4]) * 0.5;
    const cz = (bb[2] + bb[5]) * 0.5;
    const dx = cx - predictedCam[0];
    const dy = cy - predictedCam[1];
    const dz = cz - predictedCam[2];
    return dx * dx + dy * dy + dz * dz;
  };

  if (strategy === "bandwidth-saver") {
    candidates.sort((a, b) => a.depth - b.depth);
    return;
  }

  if (strategy === "depth-first" || strategy === "frustum-priority") {
    candidates.sort((a, b) => {
      const depthOrder = b.depth - a.depth;
      if (depthOrder !== 0) return depthOrder;
      return distanceToPredicted(a) - distanceToPredicted(b);
    });
    return;
  }

  if (strategy === "nearest" && vpPresent && cameraPos) {
    const cam = predictedCam ?? cameraPos;
    candidates.sort((a, b) => {
      const aa = voxelBounds(a, info as any);
      const bb = voxelBounds(b, info as any);
      const acx = (aa[0] + aa[3]) * 0.5;
      const acy = (aa[1] + aa[4]) * 0.5;
      const acz = (aa[2] + aa[5]) * 0.5;
      const bcx = (bb[0] + bb[3]) * 0.5;
      const bcy = (bb[1] + bb[4]) * 0.5;
      const bcz = (bb[2] + bb[5]) * 0.5;
      const da = (acx - cam[0]) ** 2 + (acy - cam[1]) ** 2 + (acz - cam[2]) ** 2;
      const db = (bcx - cam[0]) ** 2 + (bcy - cam[1]) ** 2 + (bcz - cam[2]) ** 2;
      return da - db;
    });
  }
}
