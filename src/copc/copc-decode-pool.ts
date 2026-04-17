export interface DecodeJob<T> {
  nodeKey: string;
  tileBytes: ArrayBuffer;
  pointCount: number;
  resolve: (result: T | null) => void;
}

export interface DecodeWorkerSlot<T> {
  worker: Worker;
  busy: boolean;
  job: DecodeJob<T> | null;
}

export function ensureDecodePool<T>(params: {
  workerFactory: (() => Worker) | null;
  maxConcurrent: number;
  decodeWorkers: DecodeWorkerSlot<T>[];
  onTileReady: (data: unknown, job: DecodeJob<T>) => T | null;
  onPump: () => void;
}): void {
  const { workerFactory, maxConcurrent, decodeWorkers, onTileReady, onPump } = params;
  if (!workerFactory || decodeWorkers.length > 0) return;
  const poolSize = Math.max(1, Math.min(maxConcurrent, 4));
  for (let i = 0; i < poolSize; i++) {
    const worker = workerFactory();
    const slot: DecodeWorkerSlot<T> = { worker, busy: false, job: null };
    worker.onmessage = (e: MessageEvent) => {
      const currentJob = slot.job;
      slot.busy = false;
      slot.job = null;
      if (!currentJob) return;
      currentJob.resolve(onTileReady(e.data, currentJob));
      onPump();
    };
    worker.onerror = (e) => {
      const currentJob = slot.job;
      slot.busy = false;
      slot.job = null;
      if (currentJob) {
        console.error("[CopcSource] tile worker onerror:", currentJob.nodeKey, e.message ?? e);
        currentJob.resolve(null);
      }
      onPump();
    };
    decodeWorkers.push(slot);
  }
}

export function pumpDecodeQueue<T>(params: {
  destroyed: boolean;
  decodeWorkers: DecodeWorkerSlot<T>[];
  decodeQueue: DecodeJob<T>[];
  makeDecodeRequest: (job: DecodeJob<T>) => unknown;
}): void {
  const { destroyed, decodeWorkers, decodeQueue, makeDecodeRequest } = params;
  if (destroyed) {
    if (decodeQueue.length > 0) {
      const queued = decodeQueue.splice(0, decodeQueue.length);
      for (const job of queued) job.resolve(null);
    }
    return;
  }
  for (const slot of decodeWorkers) {
    if (slot.busy) continue;
    const job = decodeQueue.shift();
    if (!job) return;
    slot.busy = true;
    slot.job = job;
    slot.worker.postMessage(makeDecodeRequest(job), [job.tileBytes]);
  }
}
