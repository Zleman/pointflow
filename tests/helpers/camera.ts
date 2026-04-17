import { PerspectiveCamera } from "three";

export function makeCamera(
  px: number,
  py: number,
  pz: number,
  fov = 75,
  near = 0.1,
  far = 1000
): PerspectiveCamera {
  const camera = new PerspectiveCamera(fov, 1, near, far);
  camera.position.set(px, py, pz);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}
