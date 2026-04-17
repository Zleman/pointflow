import type { Matrix4, Plane, Vector3 } from "three";

/**
 * Uniform buffer layout (256 bytes total):
 *
 * offset   0 (64B): mat4x4<f32>      viewProj
 * offset  64 (96B): vec4<f32>[6]     frustumPlanes
 * offset 160  (4B): u32              pointCount
 * offset 164  (4B): f32              attrMin
 * offset 168  (4B): f32              attrMax
 * offset 172  (4B): u32              colorMode   (0=white, 1=mapped, 2=rgb packed)
 * offset 176  (4B): f32              pointSizePixels
 * offset 180  (4B): f32              viewportWidth
 * offset 184  (4B): f32              viewportHeight
 * offset 188  (4B): f32              lodFarDist  (C: GPU LOD far threshold)
 * offset 192 (16B): vec4<f32>        cameraPos   (C: GPU LOD camera position, w unused)
 * offset 208  (4B): u32              importanceSamplingEnabled
 * offset 212  (4B): u32              frameSeed
 * offset 216  (4B): f32              importanceMin
 * offset 220  (4B): f32              importanceMax
 * offset 224  (4B): f32              fovStrength
 * offset 228  (4B): f32              nowRelEpoch  (epoch-relative now, ms)
 * offset 232  (4B): f32              timeWindowMs (0 = disabled)
 * offset 236  (4B): u32              timeWindowEnabled
 * offset 240–255: reserved / padding
 */
export const UNIFORM_BUFFER_SIZE = 256;

export function createUniformBuffer(device: GPUDevice): GPUBuffer {
  return device.createBuffer({
    size: UNIFORM_BUFFER_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

const _scratch = new ArrayBuffer(UNIFORM_BUFFER_SIZE);
const _f32     = new Float32Array(_scratch);
const _u32     = new Uint32Array(_scratch);

export function writeUniforms(
  device: GPUDevice,
  uniformBuffer: GPUBuffer,
  viewProjMatrix: Matrix4,
  frustumPlanes: Plane[],
  pointCount: number,
  attrMin: number,
  attrMax: number,
  colorMode: 0 | 1 | 2,
  pointSizePixels: number,
  viewportWidth: number,
  viewportHeight: number,
  lodFarDist: number,
  cameraPosition: Vector3,
  importanceSamplingEnabled: 0 | 1 = 0,
  frameSeed: number = 0,
  importanceMin: number = 0,
  importanceMax: number = 1,
  fovStrength: number = 0,
  nowRelEpoch: number = 0,
  timeWindowMs: number = 0,
): void {
  const me = viewProjMatrix.elements;
  for (let i = 0; i < 16; i++) _f32[i] = me[i];

  for (let i = 0; i < 6; i++) {
    const p    = frustumPlanes[i];
    const base = 16 + i * 4;
    _f32[base]     = p.normal.x;
    _f32[base + 1] = p.normal.y;
    _f32[base + 2] = p.normal.z;
    _f32[base + 3] = p.constant;
  }

  _u32[40] = pointCount;
  _f32[41] = attrMin;
  _f32[42] = attrMax;
  _u32[43] = colorMode;
  _f32[44] = pointSizePixels;
  _f32[45] = viewportWidth;
  _f32[46] = viewportHeight;
  _f32[47] = lodFarDist;
  // cameraPos at offset 192 (f32 index 48-51); vec4 alignment = 16 bytes = index 48
  _f32[48] = cameraPosition.x;
  _f32[49] = cameraPosition.y;
  _f32[50] = cameraPosition.z;
  _f32[51] = 0.0;

  // importance sampling uniforms at offset 208 (f32 index 52)
  _u32[52] = importanceSamplingEnabled;
  _u32[53] = frameSeed;
  _f32[54] = importanceMin;
  _f32[55] = importanceMax;

  // Foveated importance strength at offset 224 (f32 index 56)
  _f32[56] = fovStrength;

  // Temporal time window at offset 228–236 (f32 indices 57–59)
  _f32[57] = nowRelEpoch;
  _f32[58] = timeWindowMs;
  _u32[59] = (timeWindowMs > 0) ? 1 : 0;

  device.queue.writeBuffer(uniformBuffer, 0, _scratch, 0, UNIFORM_BUFFER_SIZE);
}
