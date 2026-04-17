export const LOD_DISTANCE_NEAR = 50;
export const LOD_DISTANCE_FAR = 200;

export function lodLevelFromCameraDistance(distance: number): number {
  if (distance < LOD_DISTANCE_NEAR) return 0;
  if (distance <= LOD_DISTANCE_FAR) return 1;
  return 2;
}

export function hasCameraMoved(
  current: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number },
  previous: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number },
  epsilon = 1e-5
): boolean {
  return (
    Math.abs(current.x - previous.x) > epsilon
    || Math.abs(current.y - previous.y) > epsilon
    || Math.abs(current.z - previous.z) > epsilon
    || Math.abs(current.qx - previous.qx) > epsilon
    || Math.abs(current.qy - previous.qy) > epsilon
    || Math.abs(current.qz - previous.qz) > epsilon
    || Math.abs(current.qw - previous.qw) > epsilon
  );
}
