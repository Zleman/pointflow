import { createRenderWorker } from "./render-worker-blob";

export type ScanResultCallback = (
  positions: Float32Array,
  colors: Float32Array,
  count: number
) => void;

/**
 * Main-thread bridge for the render worker.
 *
 * The render worker maintains its own SoA ring buffer. The main thread feeds it
 * via ingestSoA (Transferable, zero-copy) and requests off-thread scans via scan().
 * Only one scan is in flight at a time — if scan() is called while a previous scan
 * is pending, it returns false and the caller should skip (stale geometry remains).
 */
export class RenderWorkerBridge {
  private readonly worker: Worker;
  private pendingCallback: ScanResultCallback | null = null;
  private scanRequestId = 0;

  constructor(worker: Worker, capacity: number) {
    this.worker = worker;
    this.worker.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; positions: Float32Array; colors: Float32Array; count: number };
      if (d.type === "SCAN_RESULT") {
        const cb = this.pendingCallback;
        this.pendingCallback = null;
        // Fire callback first — it copies the visible slice into pre-allocated
        // main-thread buffers so the worker pair is no longer needed.
        if (cb) cb(d.positions, d.colors, d.count);
        // Return the pair immediately after the copy.
        // Pairs from the worker's early-exit path have byteLength === 0 (ephemeral
        // new Float32Array(0), not from freePairs) — don't return those or the
        // pool is corrupted.
        if (d.positions.byteLength > 0) {
          this.worker.postMessage(
            { type: "RETURN_BUFFERS", positions: d.positions, colors: d.colors },
            [d.positions.buffer as ArrayBuffer, d.colors.buffer as ArrayBuffer]
          );
        }
      }
    };
    this.worker.onerror = (err) => {
      console.warn("[PointFlow] Render worker error:", err);
    };
    this.worker.postMessage({ type: "INIT", capacity });
  }

  /**
   * Forward a raw ingest chunk to the worker's ring buffer.
   * xyz and attr are transferred (zero-copy) — do not use them after this call.
   */
  ingestSoA(xyz: Float32Array, attr: Float32Array | null, count: number, isRgb = false): void {
    if (count === 0) return;
    const transferables: ArrayBuffer[] = [xyz.buffer as ArrayBuffer];
    if (attr) transferables.push(attr.buffer as ArrayBuffer);
    this.worker.postMessage({ type: "INGEST_SoA", xyz, attr, count, isRgb }, transferables);
  }

  /**
   * Request an off-thread frustum cull + color scan.
   * Returns false when a scan is already in flight (caller keeps stale geometry).
   * frustumPlanes: 24 floats (6 × [nx,ny,nz,d]), or null to skip culling.
   * colorMode: 0 = attribute blue-red, 1 = uniform white.
   */
  scan(
    frustumPlanes: Float32Array | null,
    lodStride: number,
    colorMode: number,
    callback: ScanResultCallback
  ): boolean {
    if (this.pendingCallback !== null) return false;
    this.pendingCallback = callback;
    this.worker.postMessage({
      type: "SCAN",
      requestId: this.scanRequestId++,
      frustumPlanes,
      lodStride,
      colorMode,
    });
    return true;
  }

  reset(): void {
    // Nulling pendingCallback is enough — any in-flight SCAN_RESULT will be
    // received with cb===null, the pair will still be returned to the worker.
    this.pendingCallback = null;
    this.worker.postMessage({ type: "RESET" });
  }

  terminate(): void {
    this.pendingCallback = null;
    this.worker.terminate();
  }
}

/**
 * Factory. Returns null if Worker creation fails (restrictive CSP, test env, etc).
 */
export function createRenderWorkerBridge(capacity: number): RenderWorkerBridge | null {
  try {
    const worker = createRenderWorker();
    return new RenderWorkerBridge(worker, capacity);
  } catch {
    return null;
  }
}
