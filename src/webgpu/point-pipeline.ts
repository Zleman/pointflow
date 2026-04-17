import type { WebGPUPointBuffers } from "./buffers";

const POINT_SHADER = /* wgsl */`
struct Uniforms {
  viewProj        : mat4x4<f32>,
  planes          : array<vec4<f32>, 6>,
  pointCount      : u32,
  attrMin         : f32,
  attrMax         : f32,
  colorMode       : u32,
  pointSizePixels : f32,
  viewportWidth   : f32,
  viewportHeight  : f32,
  lodFarDist      : f32,
  cameraPos       : vec4<f32>,
}

@group(0) @binding(0) var<storage, read> positions  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> attributes : array<f32>;
@group(1) @binding(0) var<uniform>       uniforms   : Uniforms;

struct VertOut {
  @builtin(position) clip  : vec4<f32>,
  @location(0)        color : vec3<f32>,
}

fn attrColor(t: f32) -> vec3<f32> {
  let c0 = vec3<f32>(0.05, 0.03, 0.53);
  let c1 = vec3<f32>(0.94, 0.23, 0.50);
  let c2 = vec3<f32>(0.99, 0.91, 0.15);
  let u  = clamp(t, 0.0, 1.0);
  if (u < 0.5) { return mix(c0, c1, u * 2.0); }
  return mix(c1, c2, (u - 0.5) * 2.0);
}

@vertex fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VertOut {
  let pos  = positions[iid];
  let attr = attributes[iid];
  let centerClip = uniforms.viewProj * vec4<f32>(pos.xyz, 1.0);
  let cornerX = select(-1.0, 1.0, vid == 1u || vid == 4u || vid == 5u);
  let cornerY = select(-1.0, 1.0, vid == 2u || vid == 3u || vid == 5u);
  let ndcOffX = cornerX * uniforms.pointSizePixels / max(uniforms.viewportWidth,  1.0);
  let ndcOffY = cornerY * uniforms.pointSizePixels / max(uniforms.viewportHeight, 1.0);
  var out: VertOut;
  out.clip = vec4<f32>(
    centerClip.x + ndcOffX * centerClip.w,
    centerClip.y + ndcOffY * centerClip.w,
    centerClip.z,
    centerClip.w
  );
  if (uniforms.colorMode == 1u) {
    let range = max(uniforms.attrMax - uniforms.attrMin, 1e-6);
    let t     = clamp((attr - uniforms.attrMin) / range, 0.0, 1.0);
    out.color = attrColor(t);
  } else if (uniforms.colorMode == 2u) {
    // Packed R8G8B8 — unpacked from the u32 bitcast stored in the attribute slot.
    let packed = bitcast<u32>(attr);
    out.color = vec3<f32>(
      f32(packed & 0xFFu) / 255.0,
      f32((packed >> 8u) & 0xFFu) / 255.0,
      f32((packed >> 16u) & 0xFFu) / 255.0,
    );
  } else {
    out.color = vec3<f32>(0.87843137, 0.87843137, 0.87843137);
  }
  return out;
}

struct FragOut {
  @location(0) color : vec4<f32>,
}

@fragment fn fs(in: VertOut) -> FragOut {
  return FragOut(vec4<f32>(in.color, 1.0));
}
`;

export interface RenderPipeline {
  pipeline: GPURenderPipeline;
  bindGroup0: GPUBindGroup;
  bindGroup1: GPUBindGroup;
  readonly bindGroupLayout0: GPUBindGroupLayout;
  readonly bindGroupLayout1: GPUBindGroupLayout;
}

export function createRenderPipeline(
  device: GPUDevice,
  buffers: WebGPUPointBuffers,
  uniformBuffer: GPUBuffer,
  canvasFormat: GPUTextureFormat
): RenderPipeline {
  const bgl0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });
  const bgl1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  });

  const shaderModule = device.createShaderModule({ code: POINT_SHADER });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] }),
    vertex: { module: shaderModule, entryPoint: "vs" },
    fragment: {
      module: shaderModule,
      entryPoint: "fs",
      targets: [{ format: canvasFormat }],
    },
    primitive: { topology: "triangle-list" },
    // Depth testing — points closer to camera occlude farther ones.
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  const bindGroup0 = makeRenderBindGroup0(device, bgl0, buffers);
  const bindGroup1 = device.createBindGroup({
    layout: bgl1,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  return { pipeline, bindGroup0, bindGroup1, bindGroupLayout0: bgl0, bindGroupLayout1: bgl1 };
}

export function makeRenderBindGroup0(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  buffers: WebGPUPointBuffers
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: buffers.visiblePositionBuffer } },
      { binding: 1, resource: { buffer: buffers.visibleAttributeBuffer } },
    ],
  });
}
