function isDevRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}

export function getDeviceFromRenderer(renderer: unknown): GPUDevice | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const device = (renderer as any)?.backend?.device;
    if (device && typeof device.createBuffer === "function") return device as GPUDevice;
  } catch (err) {
    if (isDevRuntime()) {
      console.warn("[PointFlow] Failed to read WebGPU device from renderer backend.", err);
    }
  }
  return null;
}

export function getCanvasContextFromRenderer(renderer: unknown): GPUCanvasContext | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (renderer as any)?.backend?.context;
    if (ctx && typeof ctx.getCurrentTexture === "function") return ctx as GPUCanvasContext;
  } catch (err) {
    if (isDevRuntime()) {
      console.warn("[PointFlow] Failed to read WebGPU canvas context from renderer backend.", err);
    }
  }
  return null;
}
