import { describe, expect, it, vi } from "vitest";
import { submitFrame } from "../src/webgpu/render-pass";

function createHarness() {
  const computePass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    dispatchWorkgroups: vi.fn(),
    end: vi.fn(),
  };
  const renderPass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    drawIndirect: vi.fn(),
    end: vi.fn(),
  };
  const encoder = {
    clearBuffer: vi.fn(),
    beginComputePass: vi.fn(() => computePass),
    beginRenderPass: vi.fn(() => renderPass),
    copyBufferToBuffer: vi.fn(),
    resolveQuerySet: vi.fn(),
    finish: vi.fn(() => ({})),
  };
  const queue = { submit: vi.fn() };
  const device = {
    createCommandEncoder: vi.fn(() => encoder),
    queue,
  } as unknown as GPUDevice;
  const canvasContext = {
    getCurrentTexture: vi.fn(() => ({
      createView: vi.fn(() => ({})),
    })),
  } as unknown as GPUCanvasContext;
  const buffers = {
    indirectBuffer: {},
    visibleCountStagingBuffer: { mapState: "unmapped" },
  } as unknown as Parameters<typeof submitFrame>[2];
  const compute = {
    pipeline: {},
    bindGroup0: {},
    bindGroup1: {},
  } as unknown as Parameters<typeof submitFrame>[3];
  const render = {
    pipeline: {},
    bindGroup0: {},
    bindGroup1: {},
  } as unknown as Parameters<typeof submitFrame>[4];
  return { encoder, queue, renderPass, computePass, device, canvasContext, buffers, compute, render };
}

describe("submitFrame cadence", () => {
  it("still renders when compute is skipped", () => {
    const h = createHarness();
    submitFrame(
      h.device,
      h.canvasContext,
      h.buffers,
      h.compute,
      h.render,
      1000,
      null,
      { r: 0, g: 0, b: 0, a: 1 },
      null,
      false,
    );
    expect(h.encoder.beginRenderPass).toHaveBeenCalledTimes(1);
    expect(h.encoder.beginComputePass).not.toHaveBeenCalled();
    expect(h.encoder.clearBuffer).not.toHaveBeenCalled();
    expect(h.renderPass.drawIndirect).toHaveBeenCalledTimes(1);
    expect(h.queue.submit).toHaveBeenCalledTimes(1);
  });

  it("runs compute and render when compute is enabled", () => {
    const h = createHarness();
    submitFrame(
      h.device,
      h.canvasContext,
      h.buffers,
      h.compute,
      h.render,
      1000,
      null,
      { r: 0, g: 0, b: 0, a: 1 },
      null,
      true,
    );
    expect(h.encoder.beginComputePass).toHaveBeenCalledTimes(1);
    expect(h.computePass.dispatchWorkgroups).toHaveBeenCalledTimes(1);
    expect(h.encoder.clearBuffer).toHaveBeenCalledTimes(1);
    expect(h.encoder.beginRenderPass).toHaveBeenCalledTimes(1);
    expect(h.renderPass.drawIndirect).toHaveBeenCalledTimes(1);
    expect(h.queue.submit).toHaveBeenCalledTimes(1);
  });
});
