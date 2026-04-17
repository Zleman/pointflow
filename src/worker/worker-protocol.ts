import type { PackedAttributeChannel } from "../core/types";

/**
 * Worker protocol.
 *
 * IngestRequest sends the raw point array (structured clone) to the worker.
 * The worker performs the AoS-to-SoA packing off the main thread and returns
 * pre-packed transferable typed arrays plus per-attribute range hints.
 *
 * Previous design sent pre-packed typed arrays to the worker and received an
 * identical echo. The packing (packChunk) ran on the main thread, blocking the
 * render loop. Now packing is genuinely off-main-thread.
 */

/** Minimal point shape sent to the worker (structured clone, not transferable). */
export interface RawPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly attributes?: Record<string, number>;
}

/**
 * Camera frustum planes packed as a flat Float32Array of length 24.
 * Layout: 6 planes × 4 floats each — [nx, ny, nz, d] where the plane equation is
 * nx*x + ny*y + nz*z + d >= 0 for a point inside the frustum.
 */
export interface FrustumPlaneData {
  /** 24 floats: 6 planes × [normalX, normalY, normalZ, constant]. */
  readonly planes: Float32Array;
}

/** Message from main thread to ingest worker. */
export interface IngestRequest {
  readonly type: "INGEST";
  readonly requestId: number;
  /** Raw point objects — structured-cloned to worker so packing happens off-thread. */
  readonly points: RawPoint[];
  /**
   * When present, the worker performs a frustum visibility pass and returns
   * only the points that pass all 6 frustum plane tests. Points outside the
   * frustum are discarded before packing — they are never ingested into the
   * ring buffer. The response sets preCulled: true to signal this to the
   * main thread.
   */
  readonly frustum?: FrustumPlaneData;
}

/** Per-attribute min/max computed by the worker over the ingested chunk. */
export interface RangeHint {
  readonly min: number;
  readonly max: number;
}

/** Message from ingest worker to main thread. */
export interface IngestResponse {
  readonly type: "PREPROCESSED";
  readonly requestId: number;
  readonly xyz: Float32Array;
  readonly attributes: PackedAttributeChannel[] | undefined;
  readonly count: number;
  /** Worker-computed per-attribute min/max for the chunk. Keyed by attribute name. */
  readonly rangeHints: Record<string, RangeHint>;
  /**
   * True when the worker performed frustum culling and returned only visible
   * points. The main thread can skip its own isVisible pass in this case.
   */
  readonly preCulled?: boolean;
}

function isValidPackedAttributeChannel(data: unknown, count: number): data is PackedAttributeChannel {
  if (data === null || typeof data !== "object") return false;
  const o = data as Record<string, unknown>;
  if (typeof o.key !== "string") return false;
  if (!(o.values instanceof Float32Array) || o.values.length < count) return false;
  if (!(o.present instanceof Uint8Array) || o.present.length < count) return false;
  return true;
}

export function isValidIngestResponse(data: unknown): data is IngestResponse {
  if (data === null || typeof data !== "object") return false;
  const o = data as Record<string, unknown>;
  if (o.type !== "PREPROCESSED") return false;
  if (typeof o.requestId !== "number" || !Number.isInteger(o.requestId) || o.requestId < 0) return false;
  if (!(o.xyz instanceof Float32Array)) return false;
  if (typeof o.count !== "number" || !Number.isInteger(o.count) || o.count < 0) return false;
  if (o.count * 3 > o.xyz.length) return false;
  if (o.attributes !== undefined) {
    if (!Array.isArray(o.attributes)) return false;
    const seenKeys = new Set<string>();
    for (const channel of o.attributes) {
      if (!isValidPackedAttributeChannel(channel, o.count)) return false;
      if (seenKeys.has(channel.key)) return false;
      seenKeys.add(channel.key);
    }
  }
  if (o.rangeHints === null || typeof o.rangeHints !== "object" || Array.isArray(o.rangeHints)) return false;
  return true;
}
