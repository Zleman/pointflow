import computeShaderSource from "./compute-cull.wgsl?raw";
import type { WebGPUPointBuffers } from "./buffers";

export interface ComputePipeline {
  pipeline: GPUComputePipeline;
  /** Bind group 0: storage buffers (source ring + compacted output + indirect). */
  bindGroup0: GPUBindGroup;
  /** Bind group 1: uniform buffer. */
  bindGroup1: GPUBindGroup;
  readonly bindGroupLayout0: GPUBindGroupLayout;
  readonly bindGroupLayout1: GPUBindGroupLayout;
}

export function createComputePipeline(
  device: GPUDevice,
  buffers: WebGPUPointBuffers,
  uniformBuffer: GPUBuffer
): ComputePipeline {
  const bgl0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }, // timestamps
    ],
  });
  const bgl1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ],
  });

  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] }),
    compute: {
      module: device.createShaderModule({ code: computeShaderSource }),
      entryPoint: "main",
    },
  });

  const bindGroup0 = makeComputeBindGroup0(device, bgl0, buffers);
  const bindGroup1 = device.createBindGroup({
    layout: bgl1,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  return { pipeline, bindGroup0, bindGroup1, bindGroupLayout0: bgl0, bindGroupLayout1: bgl1 };
}

/**
 * Build bind group 0 for the compute pipeline.
 * Single source ring buffer (no double-buffer slot needed — A: incremental GPU ring).
 */
export function makeComputeBindGroup0(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  buffers: WebGPUPointBuffers
): GPUBindGroup {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: buffers.positionBuffer } },
      { binding: 1, resource: { buffer: buffers.attributeBuffer } },
      { binding: 2, resource: { buffer: buffers.visiblePositionBuffer } },
      { binding: 3, resource: { buffer: buffers.visibleAttributeBuffer } },
      { binding: 4, resource: { buffer: buffers.indirectBuffer } },
      { binding: 5, resource: { buffer: buffers.timestampBuffer } },
    ],
  });
}
