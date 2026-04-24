const PICK_SHADER = /* wgsl */`
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

@group(0) @binding(0) var<storage, read> positions   : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> visibleSlot : array<u32>;
@group(1) @binding(0) var<uniform>       uniforms    : Uniforms;

struct PickVert {
  @builtin(position)              pos : vec4<f32>,
  @location(0) @interpolate(flat) iid : u32,
}

@vertex fn vs_pick(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> PickVert {
  let pos        = positions[iid];
  let centerClip = uniforms.viewProj * vec4<f32>(pos.xyz, 1.0);
  let cornerX = select(-1.0, 1.0, vid == 1u || vid == 4u || vid == 5u);
  let cornerY = select(-1.0, 1.0, vid == 2u || vid == 3u || vid == 5u);
  let ndcOffX = cornerX * uniforms.pointSizePixels / max(uniforms.viewportWidth,  1.0);
  let ndcOffY = cornerY * uniforms.pointSizePixels / max(uniforms.viewportHeight, 1.0);
  var out: PickVert;
  out.pos = vec4<f32>(
    centerClip.x + ndcOffX * centerClip.w,
    centerClip.y + ndcOffY * centerClip.w,
    centerClip.z,
    centerClip.w
  );
  out.iid = iid;
  return out;
}

struct PickFrag {
  @location(0) slotPlusOne : u32,
}

@fragment fn fs_pick(in: PickVert) -> PickFrag {
  return PickFrag(visibleSlot[in.iid] + 1u);
}
`;

export function buildPickingPipeline(device: GPUDevice): GPURenderPipeline {
  const bgl0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX,   buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    ],
  });
  const bgl1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
    ],
  });
  const shaderModule = device.createShaderModule({ code: PICK_SHADER });
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] }),
    vertex:   { module: shaderModule, entryPoint: "vs_pick" },
    fragment: { module: shaderModule, entryPoint: "fs_pick", targets: [{ format: "r32uint" }] },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });
}

export function createPickingTexture(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    size:   [width, height],
    format: "r32uint",
    usage:  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
}

export function makePickingBindGroups(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  visiblePosBuf: GPUBuffer,
  visibleSlotBuf: GPUBuffer,
  uniformBuf: GPUBuffer,
): [GPUBindGroup, GPUBindGroup] {
  const bg0 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: visiblePosBuf  } },
      { binding: 1, resource: { buffer: visibleSlotBuf } },
    ],
  });
  const bg1 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(1),
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });
  return [bg0, bg1];
}
