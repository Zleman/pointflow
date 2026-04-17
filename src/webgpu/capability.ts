import type { RendererBackend } from "../core/types";

export function detectWebGPUSync(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export async function detectWebGPUSupport(): Promise<boolean> {
  if (!detectWebGPUSync()) return false;
  try {
    const adapter = await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

export function resolveRenderer(requested: RendererBackend | undefined): Exclude<RendererBackend, "auto"> {
  if (requested === "webgl") return "webgl";
  const gpuAvailable = detectWebGPUSync();
  if (requested === "webgpu") return gpuAvailable ? "webgpu" : "webgl";
  // "auto" or undefined → WebGPU when available
  return gpuAvailable ? "webgpu" : "webgl";
}
