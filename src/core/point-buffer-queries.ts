import type { PointRecord } from "./types";
import type { PickStrategy } from "./types";

/**
 * Read-only view of PointBuffer internals required for point picking.
 * Passed from PointBuffer.pickNearest() into the free function below so the
 * algorithm can be tested independently of the ring-buffer class.
 */
export interface PickBuffer {
  readonly size: number;
  readonly capacity: number;
  readonly head: number;
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;
  readonly importanceBuffer: Float32Array;
  readonly items: ReadonlyArray<PointRecord | undefined>;
  readonly packedAttrValuesByKey: ReadonlyMap<string, Float32Array>;
  readonly packedAttrPresenceByKey: ReadonlyMap<string, Uint8Array>;
  readonly slotTimestampMs: Float32Array;
}

/**
 * Find the nearest visible point to a screen-space click.
 *
 * Projects every active point through the supplied VP matrix, tests against
 * a screen-space pick radius, and returns the best candidate.
 *
 * Primary sort key: importance (higher wins — best for stacked points).
 * Secondary sort key: screen distance (closer wins when importance is equal).
 *
 * @param buf         Read-only view of the ring buffer state.
 * @param vpElements  Column-major 4×4 view-projection matrix (Three.js Matrix4.elements).
 * @param clickX      Click X in CSS pixels from the canvas left edge.
 * @param clickY      Click Y in CSS pixels from the canvas top edge.
 * @param canvasW     Canvas width in CSS pixels.
 * @param canvasH     Canvas height in CSS pixels.
 * @param pickRadius  Pick radius in CSS pixels.
 * @returns Pick result, or null when no point falls within the radius.
 */
export function pickNearestPoint(
  buf: PickBuffer,
  vpElements: ArrayLike<number>,
  clickX: number,
  clickY: number,
  canvasW: number,
  canvasH: number,
  pickRadius: number,
  pickStrategy: PickStrategy = "highestImportance",
): { slotIndex: number; x: number; y: number; z: number; screenDist: number; importance: number; attributes: Record<string, number> } | null {
  if (buf.size === 0) return null;

  const vp = vpElements;
  const radiusSq = pickRadius * pickRadius;
  let bestSlot       = -1;
  let bestDistSq     = Infinity;
  let bestImportance = -Infinity;
  let bestTimestamp  = -Infinity;

  for (let k = 0; k < buf.size; k++) {
    const slot = (buf.head + k) % buf.capacity;
    const wx = buf.xs[slot], wy = buf.ys[slot], wz = buf.zs[slot];

    // Column-major VP: vp[col*4 + row]. clip = VP × [wx, wy, wz, 1]ᵀ
    const clipX = vp[0]*wx + vp[4]*wy + vp[8]*wz  + vp[12];
    const clipY = vp[1]*wx + vp[5]*wy + vp[9]*wz  + vp[13];
    const clipW = vp[3]*wx + vp[7]*wy + vp[11]*wz + vp[15];

    if (clipW <= 0) continue;

    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;

    // NDC → CSS pixels. NDC Y is +up; CSS Y is +down.
    const screenX = (ndcX + 1) * 0.5 * canvasW;
    const screenY = (1 - ndcY) * 0.5 * canvasH;

    const dx = screenX - clickX, dy = screenY - clickY;
    const distSq = dx * dx + dy * dy;
    if (distSq > radiusSq) continue;

    const imp = buf.importanceBuffer[slot];
    const ts = buf.slotTimestampMs[slot];
    let shouldReplace = false;
    if (bestSlot === -1) {
      shouldReplace = true;
    } else if (pickStrategy === "nearest") {
      shouldReplace = distSq < bestDistSq || (distSq === bestDistSq && imp > bestImportance);
    } else if (pickStrategy === "recentFirst") {
      shouldReplace = ts > bestTimestamp || (ts === bestTimestamp && imp > bestImportance) || (ts === bestTimestamp && imp === bestImportance && distSq < bestDistSq);
    } else {
      shouldReplace = imp > bestImportance || (imp === bestImportance && distSq < bestDistSq);
    }
    if (shouldReplace) {
      bestSlot = slot;
      bestDistSq = distSq;
      bestImportance = imp;
      bestTimestamp = ts;
    }
  }

  if (bestSlot === -1) return null;

  // Merge attributes from both storage paths (AoS PointRecord + SoA packed arrays).
  const attributes: Record<string, number> = {};
  const item = buf.items[bestSlot];
  if (item?.attributes) Object.assign(attributes, item.attributes);
  for (const [key, values] of buf.packedAttrValuesByKey) {
    const presence = buf.packedAttrPresenceByKey.get(key);
    if (presence && presence[bestSlot] === 1) attributes[key] = values[bestSlot];
  }

  return {
    slotIndex:  bestSlot,
    x:          buf.xs[bestSlot],
    y:          buf.ys[bestSlot],
    z:          buf.zs[bestSlot],
    screenDist: Math.sqrt(bestDistSq),
    importance: buf.importanceBuffer[bestSlot],
    attributes,
  };
}
