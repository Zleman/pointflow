/**
 * usePointCloud
 *
 * Manages file loading state for the <PointCloud> component.
 * Can also be used standalone to observe loading progress when the caller
 * manages the scene separately.
 *
 * The hook drives a loader worker (PLY / XYZ) and exposes:
 *   status   — 'idle' | 'loading' | 'ready' | 'error'
 *   progress — 0–1 (fraction of file parsed)
 *   detectedPointCount — vertex count from the file header (null until known)
 *   error    — Error object when status === 'error'
 *   abort()  — imperatively cancel the in-flight load and reset to 'idle'
 *
 * Race-safety: each effect run is assigned a monotonic `loadId`. Worker message
 * handlers check `loadIdRef.current === myLoadId` before applying state; stale
 * messages from a previous src are silently dropped. This prevents "ghost chunks"
 * when the user swaps files quickly.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { createLoaderWorker, type LoaderWorkerMessage } from "../parsers/loader-worker-blob";
import type { DenseAttributeChannel, StreamedPointCloudRef } from "../components/StreamedPointCloud";
import type { PointCloudLoadTelemetryEvent } from "../core/types";
import { toPointFlowError } from "../core/errors";
import { resolvePointCloudSource, type PointCloudSource } from "../parsers/source-resolver";
import type { PointFlowConfig } from "../config";
import { resolveConfigValue } from "../config";

export type PointCloudStatus = "idle" | "loading" | "ready" | "error";

export interface UsePointCloudOptions {
  /** Points emitted per ingest call. Smaller = more frequent updates, lower latency. Default: 10 000. */
  chunkSize?: number;
  /**
   * Point budget hint for the loader worker. When the file declares more points
   * than this, the LAZ/LAS decoder applies stride sampling so the emitted set
   * fits within the budget rather than flooding the ring buffer with the tail of
   * the scan. Should match the ring buffer capacity (maxPoints on the component).
   */
  pointBudget?: number;
  onProgress?: (progress: number) => void;
  onError?: (error: Error) => void;
  /** Called when the loader HEADER is parsed (attribute keys from file). */
  onAvailableAttributes?: (attributeKeys: string[]) => void;
  /**
   * Factory function that creates the loader worker. Defaults to the standard
   * loader (PLY / XYZ / LAS). Pass `createLazLoader` from `pointflow/laz` to
   * also support LAZ (compressed LAS) files without paying the WASM cost in
   * the base bundle.
   *
   * @example
   * import { createLazLoader } from "pointflow/laz";
   * usePointCloud(src, { loaderFactory: createLazLoader });
   */
  loaderFactory?: () => Worker;
  onTelemetry?: (event: PointCloudLoadTelemetryEvent) => void;
  config?: PointFlowConfig;
}

export interface UsePointCloudResult {
  status: PointCloudStatus;
  /** 0–1. Fraction of the file that has been parsed and ingested. */
  progress: number;
  /** Vertex count reported in the file header. Null until the header has been parsed. */
  detectedPointCount: number | null;
  error: Error | null;
  /** Call with the StreamedPointCloud API once the scene mounts. */
  onSceneReady: (api: StreamedPointCloudRef) => void;
  /**
   * Imperatively cancel the in-flight load. Terminates the worker, revokes any
   * object URL created for a File/Blob src, and resets status to 'idle'.
   * Safe to call when no load is in progress (no-op).
   */
  abort: () => void;
}

export function usePointCloud(
  src: PointCloudSource | null | undefined,
  options: UsePointCloudOptions = {}
): UsePointCloudResult {
  const [status, setStatus] = useState<PointCloudStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [detectedPointCount, setDetectedPointCount] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const sceneRef = useRef<StreamedPointCloudRef | null>(null);
  const pendingRef = useRef<Array<{ xyz: Float32Array; attributes: DenseAttributeChannel[]; count: number }>>([]);

  // Monotonic counter — each effect run claims one ID. Message handlers check
  // that the ID still matches before applying state, dropping stale messages.
  const loadIdRef = useRef(0);

  // Worker and revoke refs allow abort() to cancel the current load imperatively.
  const workerRef       = useRef<Worker | null>(null);
  const currentRevokeRef = useRef<(() => void) | null>(null);
  const currentSourceKindRef = useRef<"url" | "request" | "file" | "blob">("url");

  // Stable refs for callbacks so the effect closure doesn't go stale.
  const onProgressRef = useRef(options.onProgress);
  const onErrorRef    = useRef(options.onError);
  const onAvailableAttributesRef = useRef(options.onAvailableAttributes);
  const onTelemetryRef = useRef(options.onTelemetry);
  onProgressRef.current = options.onProgress;
  onErrorRef.current    = options.onError;
  onAvailableAttributesRef.current = options.onAvailableAttributes;
  onTelemetryRef.current = options.onTelemetry;

  const hookConfig = options.config?.hooks?.usePointCloud;
  const pointCloudConfig = options.config?.pointCloud;
  const chunkSize = resolveConfigValue(10_000, options.chunkSize, pointCloudConfig?.chunkSize, hookConfig?.chunkSize);
  const loaderFactory = options.loaderFactory ?? pointCloudConfig?.loaderFactory ?? hookConfig?.loaderFactory ?? createLoaderWorker;

  useEffect(() => {
    if (!src) {
      setStatus("idle");
      setProgress(0);
      setDetectedPointCount(null);
      setError(null);
      return;
    }

    setStatus("loading");
    setProgress(0);
    setDetectedPointCount(null);
    setError(null);
    pendingRef.current = [];

    // Claim this load's ID. Any message handler that sees a different value
    // in loadIdRef knows it belongs to a stale run and discards the message.
    const myLoadId = ++loadIdRef.current;

    let resolvedSource: ReturnType<typeof resolvePointCloudSource>;
    try {
      resolvedSource = resolvePointCloudSource(src);
      currentSourceKindRef.current = resolvedSource.sourceKind;
      currentRevokeRef.current = resolvedSource.revoke;
    } catch (causeValue) {
      const err = toPointFlowError("PF_INVALID_SOURCE", "Invalid point cloud source.", causeValue);
      setStatus("error");
      setError(err);
      onErrorRef.current?.(err);
      onTelemetryRef.current?.({
        phase: "error",
        sourceKind: "url",
        message: err.message,
      });
      return;
    }
    onTelemetryRef.current?.({
      phase: "start",
      sourceKind: resolvedSource.sourceKind,
      progress: 0,
    });

    const worker = loaderFactory();
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<LoaderWorkerMessage>) => {
      // Drop messages from a previous load (src changed while worker was running).
      if (loadIdRef.current !== myLoadId) return;

      const msg = e.data;

      switch (msg.type) {
        case "HEADER": {
          if (msg.vertexCount > 0) setDetectedPointCount(msg.vertexCount);
          onAvailableAttributesRef.current?.(msg.attributeKeys);
          onTelemetryRef.current?.({
            phase: "header",
            sourceKind: currentSourceKindRef.current,
            progress: 0,
          });
          break;
        }

        case "CHUNK": {
          const { xyz, attributes, count, progress: p } = msg;
          const scene = sceneRef.current;
          if (scene) {
            // Flush any chunks that arrived before the scene was ready.
            if (pendingRef.current.length > 0) {
              for (const c of pendingRef.current) {
                scene.pushBinary(c.xyz, c.attributes, c.count);
              }
              pendingRef.current = [];
            }
            scene.pushBinary(xyz, attributes as DenseAttributeChannel[], count);
          } else {
            // Buffer until the scene mounts.
            pendingRef.current.push({ xyz, attributes: attributes as DenseAttributeChannel[], count });
          }

          setProgress(p);
          onProgressRef.current?.(p);
          onTelemetryRef.current?.({
            phase: "chunk",
            sourceKind: currentSourceKindRef.current,
            progress: p,
            chunkCount: count,
          });
          break;
        }

        case "DONE": {
          setStatus("ready");
          setProgress(1);
          onProgressRef.current?.(1);
          onTelemetryRef.current?.({
            phase: "done",
            sourceKind: currentSourceKindRef.current,
            progress: 1,
          });
          break;
        }

        case "ERROR": {
          const err = toPointFlowError("PF_PARSE_FAILED", msg.message);
          setStatus("error");
          setError(err);
          onErrorRef.current?.(err);
          onTelemetryRef.current?.({
            phase: "error",
            sourceKind: currentSourceKindRef.current,
            message: msg.message,
          });
          break;
        }
      }
    };

    worker.onerror = (ev: ErrorEvent) => {
      if (loadIdRef.current !== myLoadId) return;
      const err = toPointFlowError("PF_WORKER_INIT_FAILED", ev.message ?? "Loader worker error");
      setStatus("error");
      setError(err);
      onErrorRef.current?.(err);
      onTelemetryRef.current?.({
        phase: "error",
        sourceKind: currentSourceKindRef.current,
        message: err.message,
      });
    };

    worker.postMessage({ type: "PARSE", url: resolvedSource.url, chunkSize, pointBudget: options.pointBudget });

    return () => {
      // Invalidate this load so any in-flight messages are silently dropped.
      loadIdRef.current++;
      worker.terminate();
      workerRef.current = null;
      const revoke = currentRevokeRef.current;
      currentRevokeRef.current = null;
      if (revoke) revoke();
      pendingRef.current = [];
    };
    // chunkSize and loaderFactory intentionally excluded — both are mount-time
    // options; a change does not affect the in-flight worker.
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSceneReady = useCallback((api: StreamedPointCloudRef) => {
    sceneRef.current = api;
  }, []);

  const abort = useCallback(() => {
    // Invalidate current load ID so any late-arriving messages are dropped.
    loadIdRef.current++;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    const revoke = currentRevokeRef.current;
    currentRevokeRef.current = null;
    if (revoke) revoke();
    pendingRef.current = [];
    setStatus("idle");
    setProgress(0);
    setDetectedPointCount(null);
    setError(null);
    onTelemetryRef.current?.({
      phase: "abort",
      sourceKind: currentSourceKindRef.current,
      message: "Load aborted by caller.",
    });
  }, []);

  return { status, progress, detectedPointCount, error, onSceneReady, abort };
}
