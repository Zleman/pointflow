import type { PackedAttributeChannel, PointChunk } from "../core/types";
import { createIngestWorker } from "./worker-blob";
import type { FrustumPlaneData, IngestRequest, RangeHint, RawPoint } from "./worker-protocol";
import { isValidIngestResponse } from "./worker-protocol";

export type IngestCallback = (
  xyz: Float32Array,
  attributes: PackedAttributeChannel[] | undefined,
  count: number,
  requestId: number,
  rangeHints: Record<string, RangeHint>
) => void;

export type WorkerQueueEventPhase =
  | "dispatched"
  | "enqueued"
  | "coalesced"
  | "overflow_merged"
  | "overflow_dropped_oldest"
  | "reset"
  | "terminated";

export interface WorkerBridgeOptions {
  maxQueued?: number;
  maxCoalescePoints?: number;
  onQueueEvent?: (event: { phase: WorkerQueueEventPhase; queueLength: number; points: number }) => void;
}

/**
 * Pack a PointChunk into transferable typed arrays.
 *
 * Exported for testing and for callers that need synchronous main-thread packing
 * (e.g. the non-worker ingest path if range hints are desired). In worker mode
 * this function is no longer called on the main thread — packing is done inside
 * the worker (see worker-blob.ts). Kept here for backward compatibility.
 */
export function packChunk(chunk: PointChunk): {
  xyz: Float32Array;
  attributes: PackedAttributeChannel[] | undefined;
  count: number;
} {
  const { points } = chunk;
  const count = points.length;

  const attrKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (const p of points) {
    if (p.attributes) {
      for (const key of Object.keys(p.attributes)) {
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          attrKeys.push(key);
        }
      }
    }
  }

  const xyz = new Float32Array(count * 3);
  const attributes = attrKeys.length > 0
    ? attrKeys.map((key) => ({ key, values: new Float32Array(count), present: new Uint8Array(count) }))
    : undefined;
  const attributeIndex = new Map<string, PackedAttributeChannel>();
  for (const channel of attributes ?? []) {
    attributeIndex.set(channel.key, channel);
  }

  for (let i = 0; i < count; i++) {
    const p = points[i];
    const i3 = i * 3;
    xyz[i3] = p.x;
    xyz[i3 + 1] = p.y;
    xyz[i3 + 2] = p.z;
    if (p.attributes) {
      for (const [key, value] of Object.entries(p.attributes)) {
        const channel = attributeIndex.get(key);
        if (channel !== undefined) {
          channel.values[i] = value;
          channel.present[i] = 1;
        }
      }
    }
  }

  return { xyz, attributes, count };
}

/**
 * Main-thread side of the ingest worker protocol.
 *
 * Post sends raw point objects (structured clone) to the worker.
 * Worker performs AoS-to-SoA packing and range computation off-thread.
 * Response includes rangeHints passed through to the ingestFromBinary call.
 *
 * Accepts a pre-constructed Worker so the class is testable with a stub.
 * Use `createWorkerBridge` for production instantiation.
 */
export class WorkerBridge {
  private readonly worker: Worker;
  private readonly onIngest: IngestCallback;
  private readonly nextRequestIdRef: { current: number };
  private readonly workerCulling: boolean;
  private nextRequestId = 0;
  private currentFrustum: FrustumPlaneData | undefined = undefined;
  private minAcceptedRequestId = 0;
  private active = true;
  private inFlight = false;
  private readonly queue: Array<{ requestId: number; points: RawPoint[]; frustum?: FrustumPlaneData }> = [];
  private readonly maxQueued: number;
  private readonly maxCoalescePoints: number;
  private readonly onQueueEvent?: WorkerBridgeOptions["onQueueEvent"];

  constructor(
    worker: Worker,
    onIngest: IngestCallback,
    nextRequestIdRef: { current: number },
    workerCulling = false,
    options: WorkerBridgeOptions = {},
  ) {
    this.onIngest = onIngest;
    this.nextRequestIdRef = nextRequestIdRef;
    this.worker = worker;
    this.workerCulling = workerCulling;
    this.maxQueued = options.maxQueued ?? 4;
    this.maxCoalescePoints = options.maxCoalescePoints ?? 20_000;
    this.onQueueEvent = options.onQueueEvent;
    this.worker.onmessage = (e: MessageEvent) => {
      if (!this.active) return;
      if (!isValidIngestResponse(e.data)) return;
      const { xyz, attributes, count, requestId, rangeHints } = e.data;
      this.inFlight = false;
      if (requestId >= this.minAcceptedRequestId) {
        this.onIngest(xyz, attributes, count, requestId, rangeHints);
      }
      this.dispatchNext();
    };
    this.worker.onerror = (err) => {
      if (!this.active) return;
      console.warn("[PointFlow] Ingest worker error:", err);
      this.inFlight = false;
      this.dispatchNext();
    };
  }

  private emitQueueEvent(phase: WorkerQueueEventPhase, points: number): void {
    this.onQueueEvent?.({ phase, queueLength: this.queue.length, points });
  }

  private dispatch(item: { requestId: number; points: RawPoint[]; frustum?: FrustumPlaneData }): void {
    const msg: IngestRequest = {
      type: "INGEST",
      requestId: item.requestId,
      points: item.points,
      frustum: item.frustum,
    };
    this.inFlight = true;
    this.worker.postMessage(msg);
    this.emitQueueEvent("dispatched", item.points.length);
  }

  private dispatchNext(): void {
    if (this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.dispatch(next);
  }

  /**
   * Update the frustum planes used for worker-side culling.
   * Call once per render frame (from PointCloudScene.useFrame) when workerCulling is enabled.
   * planes must be a Float32Array of length 24: 6 planes × [nx, ny, nz, d].
   */
  setFrustum(planes: Float32Array): void {
    this.currentFrustum = { planes };
  }

  post(chunk: PointChunk): void {
    if (!this.active || chunk.points.length === 0) return;
    const requestId = this.nextRequestId++;
    this.nextRequestIdRef.current = this.nextRequestId;
    const queued = {
      requestId,
      points: chunk.points as RawPoint[],
      frustum: this.workerCulling ? this.currentFrustum : undefined,
    };

    if (!this.inFlight && this.queue.length === 0) {
      this.dispatch(queued);
      return;
    }

    const last = this.queue[this.queue.length - 1];
    if (last && (last.points.length + queued.points.length) <= this.maxCoalescePoints) {
      last.points = last.points.concat(queued.points);
      last.requestId = requestId;
      last.frustum = queued.frustum;
      this.emitQueueEvent("coalesced", queued.points.length);
      return;
    }

    if (this.queue.length >= this.maxQueued) {
      const tail = this.queue[this.queue.length - 1];
      if ((tail.points.length + queued.points.length) <= this.maxCoalescePoints) {
        tail.points = tail.points.concat(queued.points);
        tail.requestId = requestId;
        tail.frustum = queued.frustum;
        this.emitQueueEvent("overflow_merged", queued.points.length);
      } else {
        this.queue.shift();
        this.queue.push(queued);
        this.emitQueueEvent("overflow_dropped_oldest", queued.points.length);
      }
      return;
    }

    this.queue.push(queued);
    this.emitQueueEvent("enqueued", queued.points.length);
  }

  reset(minAcceptedRequestId: number): void {
    this.minAcceptedRequestId = minAcceptedRequestId;
    this.queue.length = 0;
    this.emitQueueEvent("reset", 0);
  }

  terminate(): void {
    this.active = false;
    this.queue.length = 0;
    this.emitQueueEvent("terminated", 0);
    this.worker.terminate();
  }
}

/**
 * Production factory. Throws if `Worker` or `URL.createObjectURL` is
 * unavailable. nextRequestIdRef is updated after requestId assignment so the
 * hook can treat it as the next id that will be issued after reset.
 */
export function createWorkerBridge(
  onIngest: IngestCallback,
  nextRequestIdRef: { current: number },
  workerCulling = false,
  options?: WorkerBridgeOptions,
): WorkerBridge {
  const worker = createIngestWorker();
  return new WorkerBridge(worker, onIngest, nextRequestIdRef, workerCulling, options);
}
