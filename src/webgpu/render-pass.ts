import type { ComputePipeline } from "./compute-pipeline";
import type { RenderPipeline } from "./point-pipeline";
import type { WebGPUPointBuffers } from "./buffers";

export interface FrameTimestampCtx {
  /** GPUQuerySet with 4 timestamp slots: computeBegin, computeEnd, renderBegin, renderEnd. */
  querySet: GPUQuerySet;
  /** GPU-side resolve buffer (QUERY_RESOLVE | COPY_SRC). */
  resolveBuffer: GPUBuffer;
  /** CPU-readable staging buffer (MAP_READ | COPY_DST). 4 × 8-byte timestamps. */
  stagingBuffer: GPUBuffer;
  lastComputeMs?: number;
  lastRenderMs?: number;
}

/**
 * Create timestamp query resources. Returns null if the device lacks the
 * "timestamp-query" feature.
 */
export function createTimestampCtx(device: GPUDevice): FrameTimestampCtx | null {
  if (!device.features.has("timestamp-query")) return null;
  const querySet = device.createQuerySet({ type: "timestamp", count: 4 });
  const resolveBuffer = device.createBuffer({
    size: 4 * 8,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const stagingBuffer = device.createBuffer({
    size: 4 * 8,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  return { querySet, resolveBuffer, stagingBuffer };
}

export function destroyTimestampCtx(ctx: FrameTimestampCtx): void {
  ctx.querySet.destroy();
  ctx.resolveBuffer.destroy();
  ctx.stagingBuffer.destroy();
}

/**
 * Encode and submit one frame in a SINGLE command buffer:
 *   1. Clear indirect[1] (instance count) to 0 via encoder.clearBuffer
 *   2. Compute pass: frustum cull + GPU LOD + compact
 *   3. Render pass: drawIndirect on compacted buffer (loadOp: "clear" — no gl.render() needed)
 *
 * Three.js's gl.render() is NOT called before this — our render pass owns the canvas.
 *
 * @param device          GPUDevice from Three.js WebGPU backend
 * @param canvasContext   GPUCanvasContext to get the current swap-chain texture
 * @param buffers         Point ring buffers
 * @param compute         Compute pipeline + bind groups
 * @param render          Render pipeline + bind groups
 * @param pointCount      Number of points currently in the GPU ring (0 = clear-only)
 * @param depthView       G: depth texture view matching canvas size
 * @param clearColor      Background clear color (default opaque black)
 * @param tsCtx           F: optional timestamp query context
 * @param onVisibleCount  Called async (1 frame stale) with actual drawn instance count
 */
export function submitFrame(
  device: GPUDevice,
  canvasContext: GPUCanvasContext,
  buffers: WebGPUPointBuffers,
  compute: ComputePipeline,
  render: RenderPipeline,
  pointCount: number,
  depthView: GPUTextureView | null,
  clearColor: GPUColorDict,
  tsCtx: FrameTimestampCtx | null,
  runCompute = true,
  onVisibleCount?: (count: number) => void
): void {
  const colorView = canvasContext.getCurrentTexture().createView();
  const encoder   = device.createCommandEncoder();

  if (pointCount > 0) {
    if (runCompute) {
      // Reset indirect[1] (instance count) to 0 inside the encoder.
      // indirect[0] = 6 (vertex count) was set permanently at buffer creation.
      encoder.clearBuffer(buffers.indirectBuffer, 4, 4);

      const computePass = encoder.beginComputePass(tsCtx ? {
        timestampWrites: { querySet: tsCtx.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      } : undefined);
      computePass.setPipeline(compute.pipeline);
      computePass.setBindGroup(0, compute.bindGroup0);
      computePass.setBindGroup(1, compute.bindGroup1);
      computePass.dispatchWorkgroups(Math.ceil(pointCount / 256));
      computePass.end();
    }

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        loadOp:     "clear",
        clearValue: clearColor,
        storeOp:    "store",
      }],
      // Depth attachment for correct point occlusion
      depthStencilAttachment: depthView ? {
        view:            depthView,
        depthLoadOp:     "clear",
        depthStoreOp:    "store",
        depthClearValue: 1.0,
      } : undefined,
      ...(tsCtx && runCompute ? {
        timestampWrites: { querySet: tsCtx.querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 },
      } : {}),
    });
    renderPass.setPipeline(render.pipeline);
    renderPass.setBindGroup(0, render.bindGroup0);
    renderPass.setBindGroup(1, render.bindGroup1);
    renderPass.drawIndirect(buffers.indirectBuffer, 0);
    renderPass.end();

    // Async visible-count readback: copy indirect[1] to staging (non-blocking).
    if (onVisibleCount && runCompute && buffers.visibleCountStagingBuffer.mapState === "unmapped") {
      encoder.copyBufferToBuffer(buffers.indirectBuffer, 4, buffers.visibleCountStagingBuffer, 0, 4);
    }

    // Resolve timestamps → staging
    if (tsCtx && runCompute) {
      encoder.resolveQuerySet(tsCtx.querySet, 0, 4, tsCtx.resolveBuffer, 0);
      if (tsCtx.stagingBuffer.mapState === "unmapped") {
        encoder.copyBufferToBuffer(tsCtx.resolveBuffer, 0, tsCtx.stagingBuffer, 0, 4 * 8);
      }
    }
  } else {
    // No points yet — just clear the canvas (no depth attachment, no pipeline).
    const clearPass = encoder.beginRenderPass({
      colorAttachments: [{
        view:       colorView,
        loadOp:     "clear",
        clearValue: clearColor,
        storeOp:    "store",
      }],
    });
    clearPass.end();
  }

  // ── Single submit: clear + compute + render in one command buffer ────────────
  device.queue.submit([encoder.finish()]);

  // Async visible-count readback (1 frame stale — non-blocking).
  if (pointCount > 0 && runCompute && onVisibleCount && buffers.visibleCountStagingBuffer.mapState === "unmapped") {
    buffers.visibleCountStagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const view  = new Uint32Array(buffers.visibleCountStagingBuffer.getMappedRange());
      const count = view[0];
      buffers.visibleCountStagingBuffer.unmap();
      onVisibleCount(count);
    }).catch(() => { /* GPU readback unavailable this frame */ });
  }

  // Async read GPU timestamps (non-blocking, result available next iteration).
  if (tsCtx && runCompute && tsCtx.stagingBuffer.mapState === "unmapped") {
    tsCtx.stagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const data = new BigInt64Array(tsCtx.stagingBuffer.getMappedRange());
      tsCtx.lastComputeMs = Number(data[1] - data[0]) / 1e6;
      tsCtx.lastRenderMs  = Number(data[3] - data[2]) / 1e6;
      tsCtx.stagingBuffer.unmap();
    }).catch(() => { /* timestamp unavailable */ });
  }
}
