/**
 * CopcSource — high-level API for streaming a COPC point cloud.
 *
 * Manages:
 *   - Index fetching (header + hierarchy)
 *   - Memory tile cache (LRU)
 *   - Concurrent tile fetch + decode via COPC tile workers
 *   - Optional OPFS persistent cache
 *   - Tile visibility selection per frame
 */

import type { VoxelKey, CopcNode, CopcIndex } from "./copc-types";
import { voxelKeyString } from "./copc-types";
import { fetchCopcIndex } from "./copc-reader";
import { selectVisibleTiles } from "./copc-frustum";
import { LruCache } from "./lru-cache";
import { OpfsCache } from "./opfs-cache";
import {
  ensureDecodePool,
  pumpDecodeQueue,
  type DecodeJob,
  type DecodeWorkerSlot,
} from "./copc-decode-pool";
import { fetchTileBytes } from "./copc-tile-fetch";


export interface DenseAttr {
  key: string;
  values: Float32Array;
}

export interface TileData {
  /** Per-point LAS coordinates: absolute world (scale×integer + header offset). */
  xyz: Float32Array;
  attributes: DenseAttr[];
  count: number;
}

export interface CopcSourceOptions {
  /** Max decoded tile cache in MB. Default: 512. */
  maxCacheMb?: number;
  /** Max concurrent tile fetches. Default: 4. */
  maxConcurrent?: number;
  /** Enable OPFS persistent tile cache. Default: false. */
  persistCache?: boolean;
}

export class CopcSource {
  readonly index: CopcIndex;
  readonly url: string;

  private readonly _cache: LruCache<string, TileData>;
  private readonly _fetching = new Set<string>();
  private readonly _maxConcurrent: number;
  private readonly _fullFileBuffer: ArrayBuffer | null;
  private _opfs: OpfsCache | null = null;
  private _decodeWorkers: DecodeWorkerSlot<TileData>[] = [];
  private _decodeQueue: DecodeJob<TileData>[] = [];
  private _workerFactory: (() => Worker) | null = null;
  private _destroyed = false;
  /** AbortControllers for in-flight fetchTile calls — aborted on destroy(). */
  private readonly _activeControllers = new Map<string, AbortController>();

  private constructor(
    url: string,
    index: CopcIndex,
    opts: Required<CopcSourceOptions>,
    workerFactory: (() => Worker) | null,
    fullFileBuffer: ArrayBuffer | null,
  ) {
    this.url   = url;
    this.index = index;
    this._fullFileBuffer = fullFileBuffer;

    // Approximate LRU capacity: each tile ~1 MB average.
    const maxEntries = Math.max(1, Math.floor(opts.maxCacheMb));
    this._cache        = new LruCache<string, TileData>(maxEntries);
    this._maxConcurrent = opts.maxConcurrent;
    this._workerFactory = workerFactory;
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  static async create(url: string, opts?: CopcSourceOptions): Promise<CopcSource> {
    const resolved: Required<CopcSourceOptions> = {
      maxCacheMb:    opts?.maxCacheMb    ?? 512,
      maxConcurrent: opts?.maxConcurrent ?? 4,
      persistCache:  opts?.persistCache  ?? false,
    };

    const { index, fullFileBuffer } = await fetchCopcIndex(url);

    // Lazily import worker factory to avoid WASM blob in SSR.
    let workerFactory: (() => Worker) | null = null;
    if (typeof Worker !== "undefined") {
      try {
        const mod = await import("./copc-tile-worker-blob");
        workerFactory = mod.createCopcTileWorker;
      } catch {
        // Worker not available (e.g. jsdom without blob support).
      }
    }

    const source = new CopcSource(url, index, resolved, workerFactory, fullFileBuffer ?? null);

    // Open OPFS cache if requested.
    if (resolved.persistCache) {
      try {
        const ns = url.replace(/[^a-zA-Z0-9]/g, "_");
        source._opfs = await OpfsCache.open(`copc_${ns}`, { maxMb: resolved.maxCacheMb * 2 });
      } catch {
        // OPFS unavailable.
      }
    }

    return source;
  }

  // ── Tile visibility selection ────────────────────────────────────────────

  /**
   * Given the current camera VP matrix and position, return VoxelKeys that
   * are visible, exist in the index, and have not yet been cached or fetched.
   */
  selectTiles(
    vpMatrix: number[],
    cameraPos: [number, number, number],
    lodThreshold = 0.002,
  ): VoxelKey[] {
    const candidates = selectVisibleTiles(
      this.index.nodes,
      this.index.info,
      vpMatrix,
      cameraPos,
      lodThreshold,
    );

    return candidates.filter(k => {
      const ks = voxelKeyString(k);
      return !this._cache.has(ks) && !this._fetching.has(ks);
    });
  }

  // ── Tile fetching ─────────────────────────────────────────────────────────

  /**
   * Fetch and decode a tile. Returns null for empty tiles or on error.
   * Results are cached in the LRU.
   *
   * @param signal  Optional AbortSignal — when aborted, the in-flight HTTP
   *                range request is cancelled and the method resolves null.
   *                `destroy()` automatically aborts all active fetches.
   */
  async fetchTile(key: VoxelKey, signal?: AbortSignal): Promise<TileData | null> {
    if (this._destroyed) return null;

    const ks = voxelKeyString(key);

    // Return from memory cache if available.
    const cached = this._cache.get(ks);
    if (cached) return cached;

    const node = this.index.nodes.get(ks);
    if (!node) return null;
    if (node.byteSize === 0n) return null;
    if (node.pointCount === -1n) return null;

    // Create an internal controller so destroy() can abort this fetch.
    // If the caller also supplies a signal, forward its abort into ours.
    const controller = new AbortController();
    this._activeControllers.set(ks, controller);
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });

    this._fetching.add(ks);

    try {
      // Check OPFS cache first.
      let tileBytes: ArrayBuffer | null = null;
      if (this._opfs?.isAvailable) {
        tileBytes = await this._opfs.get(ks);
      }

      if (!tileBytes) {
        tileBytes = await fetchTileBytes({
          node,
          url: this.url,
          fullFileBuffer: this._fullFileBuffer,
          signal: controller.signal,
        });
        // Persist to OPFS asynchronously.
        if (this._opfs?.isAvailable && tileBytes) {
          this._opfs.set(ks, tileBytes).catch(() => {/* non-fatal */});
        }
      }

      // Guard against destroy() completing while the fetch was in flight.
      if (this._destroyed) return null;
      if (!tileBytes) return null;

      const data = await this._decodeTile(ks, tileBytes, Number(node.pointCount));
      if (data) this._cache.set(ks, data);
      return data;
    } finally {
      this._fetching.delete(ks);
      this._activeControllers.delete(ks);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy(): void {
    this._destroyed = true;
    // Cancel all in-flight HTTP range requests so they don't spawn decode
    // workers after the pool has already been cleared.
    for (const controller of this._activeControllers.values()) {
      controller.abort();
    }
    this._activeControllers.clear();
    for (const slot of this._decodeWorkers) {
      try { slot.worker.terminate(); } catch { /* ignore */ }
    }
    this._decodeWorkers = [];
    if (this._decodeQueue.length > 0) {
      const queued = this._decodeQueue.splice(0, this._decodeQueue.length);
      for (const job of queued) {
        job.resolve(null);
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _decodeTile(
    nodeKey: string,
    tileBytes: ArrayBuffer,
    pointCount: number,
  ): Promise<TileData | null> {
    if (this._destroyed || !this._workerFactory) return Promise.resolve(null);

    this._ensureDecodePool();
    return new Promise((resolve) => {
      this._decodeQueue.push({ nodeKey, tileBytes, pointCount, resolve });
      this._pumpDecodeQueue();
    });
  }

  private _ensureDecodePool(): void {
    ensureDecodePool({
      workerFactory: this._workerFactory,
      maxConcurrent: this._maxConcurrent,
      decodeWorkers: this._decodeWorkers,
      onTileReady: (data, currentJob) => {
        const d = data as { type?: string; xyz?: Float32Array; attributes?: DenseAttr[]; count?: number; message?: string };
        if (d?.type === "TILE_READY" && d.xyz && d.attributes && typeof d.count === "number") {
          return { xyz: d.xyz, attributes: d.attributes, count: d.count };
        }
        console.error("[CopcSource] tile decode ERROR:", currentJob.nodeKey, d?.message ?? d);
        return null;
      },
      onPump: () => this._pumpDecodeQueue(),
    });
  }

  private _pumpDecodeQueue(): void {
    pumpDecodeQueue({
      destroyed: this._destroyed,
      decodeWorkers: this._decodeWorkers,
      decodeQueue: this._decodeQueue,
      makeDecodeRequest: (job) => ({
        type: "DECODE_TILE",
        tileBytes: job.tileBytes,
        header: this.index.lasHeader,
        nodeKey: job.nodeKey,
        pointCount: job.pointCount,
      }),
    });
  }
}

