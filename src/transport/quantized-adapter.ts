/**
 * 16-bit quantized binary transport adapter.
 *
 * Wire format (little-endian):
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  HEADER (20 bytes)                                              │
 *   │  [0–1]   uint16  N       — point count                         │
 *   │  [2]     uint8   M       — attribute count                      │
 *   │  [3]     uint8   flags   — reserved, must be 0                  │
 *   │  [4–7]   float32 xMin   — world-space X origin                  │
 *   │  [8–11]  float32 yMin   — world-space Y origin                  │
 *   │  [12–15] float32 zMin   — world-space Z origin                  │
 *   │  [16–19] float32 scale  — quantisation range for XYZ            │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │  XYZ BLOCK  (N × 6 bytes)                                       │
 *   │  For each point: uint16 qx, uint16 qy, uint16 qz               │
 *   │  world = min + (q / 65535) * scale                              │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │  ATTR BLOCK  (N × M × 2 bytes)                                  │
 *   │  For each point: M × uint16 values, row-major                   │
 *   │  value = attrMin + (q / 65535) * (attrMax − attrMin)           │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Non-binary WebSocket messages are silently ignored (allows multiplexing
 * JSON control messages on the same socket).
 */

import type { PointChunk } from "../core/types";


/** De-quantisation range for a single named attribute. */
export interface QuantizedAttrSchema {
  /** Attribute key — must match the order of attributes in the wire format. */
  key: string;
  /** Minimum real-world value (maps from quantised 0). */
  min: number;
  /** Maximum real-world value (maps from quantised 65535). */
  max: number;
}

/**
 * Schema passed to `createQuantizedAdapter`.
 * `attributes` must be ordered identically to the per-point attribute columns
 * in the wire format. The server and client must agree on this schema.
 */
export interface QuantizedSchema {
  attributes: QuantizedAttrSchema[];
}


const HEADER_BYTES = 20;
const MAX_Q        = 65535;


function decodePacket(data: ArrayBuffer, schema: QuantizedSchema): PointChunk | null {
  if (data.byteLength < HEADER_BYTES) return null;

  const view   = new DataView(data);
  const N      = view.getUint16(0, true);
  const M      = view.getUint8(2);
  const xMin   = view.getFloat32(4, true);
  const yMin   = view.getFloat32(8, true);
  const zMin   = view.getFloat32(12, true);
  const scale  = view.getFloat32(16, true);

  if (M !== schema.attributes.length) {
    console.warn(
      `[quantized-adapter] wire M=${M} != schema attributes=${schema.attributes.length}; dropping packet`
    );
    return null;
  }

  const xyzBytes  = N * 6;
  const attrBytes = N * M * 2;
  const expected  = HEADER_BYTES + xyzBytes + attrBytes;
  if (data.byteLength < expected) return null;

  const attrs  = schema.attributes;
  const points = [];

  const xyzBase  = HEADER_BYTES;
  const attrBase = HEADER_BYTES + xyzBytes;

  for (let i = 0; i < N; i++) {
    const xyzOff = xyzBase + i * 6;
    const qx = view.getUint16(xyzOff,     true);
    const qy = view.getUint16(xyzOff + 2, true);
    const qz = view.getUint16(xyzOff + 4, true);

    const x = xMin + (qx / MAX_Q) * scale;
    const y = yMin + (qy / MAX_Q) * scale;
    const z = zMin + (qz / MAX_Q) * scale;

    const attributes: Record<string, number> = {};
    for (let j = 0; j < attrs.length; j++) {
      const attrOff = attrBase + (i * M + j) * 2;
      const q       = view.getUint16(attrOff, true);
      const { key, min, max } = attrs[j];
      attributes[key] = min + (q / MAX_Q) * (max - min);
    }

    points.push({ x, y, z, attributes });
  }

  return { points };
}


/**
 * Attach a quantized-binary message handler to an existing WebSocket.
 *
 * @param ws      An open (or connecting) WebSocket instance.
 * @param schema  Attribute de-quantisation schema — must match the server.
 * @param onChunk Called for each successfully decoded point batch.
 * @returns       A cleanup function that removes the listener (does NOT close the socket).
 *
 * @example
 * ```ts
 * const ws = new WebSocket("wss://lidar.example.com/stream");
 * const stop = createQuantizedAdapter(ws, {
 *   attributes: [
 *     { key: "intensity", min: 0, max: 1 },
 *     { key: "classification", min: 0, max: 31 },
 *   ],
 * }, (chunk) => scene.ingest(chunk));
 *
 * // later…
 * stop(); // detach listener
 * ```
 */
export function createQuantizedAdapter(
  ws: WebSocket,
  schema: QuantizedSchema,
  onChunk: (chunk: PointChunk) => void,
): () => void {
  function onMessage(event: MessageEvent) {
    // Ignore non-binary frames (JSON control messages, pings, etc.)
    if (!(event.data instanceof ArrayBuffer)) return;

    const chunk = decodePacket(event.data, schema);
    if (chunk) onChunk(chunk);
  }

  ws.addEventListener("message", onMessage);
  return () => ws.removeEventListener("message", onMessage);
}
