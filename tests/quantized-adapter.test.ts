/**
 * M9.2 — Quantized binary transport acceptance tests.
 *
 * Tests the `createQuantizedAdapter` function which decodes 16-bit quantized
 * binary WebSocket messages into PointChunk objects.
 *
 * Coverage:
 *   1. Decodes a single-point packet — correct XYZ reconstruction.
 *   2. Decodes a multi-point packet — all points decoded correctly.
 *   3. Attribute de-quantisation — correct min/max mapping.
 *   4. Non-binary messages are silently ignored.
 *   5. Undersized packets (truncated header / truncated body) are ignored.
 *   6. Cleanup function removes the listener (no further callbacks).
 *   7. Zero-point packet produces an empty chunk (not null).
 */

import { describe, it, expect, vi } from "vitest";
import { createQuantizedAdapter, type QuantizedSchema } from "../src/transport/quantized-adapter";

// ─── Wire-format builder ──────────────────────────────────────────────────────

/**
 * Encode an array of {x,y,z,attrs} objects into the M9.2 binary wire format.
 *
 * @param points  Array of world-space points with optional attribute values.
 * @param xMin    X quantisation origin.
 * @param yMin    Y quantisation origin.
 * @param zMin    Z quantisation origin.
 * @param scale   Quantisation range (same for X, Y, Z).
 * @param schema  Attribute schema — attrs array defines key order and ranges.
 */
function buildPacket(
  points:  { x: number; y: number; z: number; attrs?: number[] }[],
  xMin:    number,
  yMin:    number,
  zMin:    number,
  scale:   number,
  schema:  QuantizedSchema,
): ArrayBuffer {
  const N   = points.length;
  const M   = schema.attributes.length;
  const buf = new ArrayBuffer(20 + N * 6 + N * M * 2);
  const view = new DataView(buf);

  // Header
  view.setUint16(0, N, true);
  view.setUint8(2, M);
  view.setUint8(3, 0); // flags
  view.setFloat32(4,  xMin,  true);
  view.setFloat32(8,  yMin,  true);
  view.setFloat32(12, zMin,  true);
  view.setFloat32(16, scale, true);

  const xyzBase  = 20;
  const attrBase = 20 + N * 6;

  for (let i = 0; i < N; i++) {
    const p   = points[i];
    const qx  = Math.round(((p.x - xMin) / scale) * 65535);
    const qy  = Math.round(((p.y - yMin) / scale) * 65535);
    const qz  = Math.round(((p.z - zMin) / scale) * 65535);
    view.setUint16(xyzBase + i * 6,     qx, true);
    view.setUint16(xyzBase + i * 6 + 2, qy, true);
    view.setUint16(xyzBase + i * 6 + 4, qz, true);

    const attrVals = p.attrs ?? [];
    for (let j = 0; j < M; j++) {
      const { min, max } = schema.attributes[j];
      const v  = attrVals[j] ?? 0;
      const q  = Math.round(((v - min) / (max - min)) * 65535);
      view.setUint16(attrBase + (i * M + j) * 2, Math.max(0, Math.min(65535, q)), true);
    }
  }

  return buf;
}

// ─── Minimal WebSocket mock ───────────────────────────────────────────────────

function makeWsMock() {
  const listeners: ((e: MessageEvent) => void)[] = [];
  return {
    addEventListener(_: string, fn: (e: MessageEvent) => void) {
      listeners.push(fn);
    },
    removeEventListener(_: string, fn: (e: MessageEvent) => void) {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    emit(data: ArrayBuffer | string) {
      const event = { data } as MessageEvent;
      // snapshot copy so removal during emit is safe
      [...listeners].forEach((fn) => fn(event));
    },
    listenerCount() { return listeners.length; },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("M9.2 — quantized binary transport", () => {

  // ── Test 1: single-point decode ───────────────────────────────────────────
  it("decodes a single-point packet with correct XYZ reconstruction", () => {
    const schema: QuantizedSchema = { attributes: [] };
    const ws     = makeWsMock();
    const chunks: unknown[] = [];

    createQuantizedAdapter(ws as unknown as WebSocket, schema, (c) => chunks.push(c));

    const buf = buildPacket(
      [{ x: 10, y: 20, z: 30 }],
      0, 0, 0, 100,
      schema,
    );
    ws.emit(buf);

    expect(chunks).toHaveLength(1);
    const pt = (chunks[0] as ReturnType<typeof Object>).points[0];
    expect(pt.x).toBeCloseTo(10, 1);
    expect(pt.y).toBeCloseTo(20, 1);
    expect(pt.z).toBeCloseTo(30, 1);
  });

  // ── Test 2: multi-point decode ────────────────────────────────────────────
  it("decodes a multi-point packet and reconstructs all points", () => {
    const schema: QuantizedSchema = { attributes: [] };
    const ws     = makeWsMock();
    const chunks: unknown[] = [];

    createQuantizedAdapter(ws as unknown as WebSocket, schema, (c) => chunks.push(c));

    const pts = [
      { x:  0,   y:   0, z:   0 },
      { x: 50,   y:  25, z:  75 },
      { x: 100,  y: 100, z: 100 },
    ];
    ws.emit(buildPacket(pts, 0, 0, 0, 100, schema));

    expect(chunks).toHaveLength(1);
    const decoded = (chunks[0] as { points: { x: number; y: number; z: number }[] }).points;
    expect(decoded).toHaveLength(3);
    expect(decoded[0].x).toBeCloseTo(0,   1);
    expect(decoded[1].x).toBeCloseTo(50,  1);
    expect(decoded[1].y).toBeCloseTo(25,  1);
    expect(decoded[2].z).toBeCloseTo(100, 1);
  });

  // ── Test 3: attribute de-quantisation ─────────────────────────────────────
  it("reconstructs attribute values with correct min/max mapping", () => {
    const schema: QuantizedSchema = {
      attributes: [
        { key: "intensity",      min: 0,  max: 1   },
        { key: "classification", min: 0,  max: 31  },
      ],
    };
    const ws     = makeWsMock();
    const chunks: unknown[] = [];

    createQuantizedAdapter(ws as unknown as WebSocket, schema, (c) => chunks.push(c));

    ws.emit(buildPacket(
      [{ x: 0, y: 0, z: 0, attrs: [0.75, 5] }],
      0, 0, 0, 100,
      schema,
    ));

    expect(chunks).toHaveLength(1);
    const pt = (chunks[0] as { points: { attributes: Record<string, number> }[] }).points[0];
    // Quantised to uint16 and back — precision within 1/65535 of full range
    expect(pt.attributes.intensity).toBeCloseTo(0.75, 2);
    expect(pt.attributes.classification).toBeCloseTo(5, 1);
  });

  // ── Test 4: non-binary messages are ignored ───────────────────────────────
  it("ignores non-binary (string) WebSocket messages", () => {
    const schema: QuantizedSchema = { attributes: [] };
    const ws     = makeWsMock();
    const onChunk = vi.fn();

    createQuantizedAdapter(ws as unknown as WebSocket, schema, onChunk);

    ws.emit('{"type":"control","action":"start"}');
    ws.emit("hello");

    expect(onChunk).not.toHaveBeenCalled();
  });

  // ── Test 5: truncated packets are ignored ─────────────────────────────────
  it("ignores packets shorter than the 20-byte header", () => {
    const schema: QuantizedSchema = { attributes: [] };
    const ws     = makeWsMock();
    const onChunk = vi.fn();

    createQuantizedAdapter(ws as unknown as WebSocket, schema, onChunk);

    // 10-byte truncated header
    ws.emit(new ArrayBuffer(10));
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("ignores packets with a valid header but truncated body", () => {
    const schema: QuantizedSchema = {
      attributes: [{ key: "intensity", min: 0, max: 1 }],
    };
    const ws     = makeWsMock();
    const onChunk = vi.fn();

    createQuantizedAdapter(ws as unknown as WebSocket, schema, onChunk);

    // Build a valid 2-point packet, then chop off the last byte
    const full = buildPacket(
      [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }],
      0, 0, 0, 100,
      schema,
    );
    ws.emit(full.slice(0, full.byteLength - 1));
    expect(onChunk).not.toHaveBeenCalled();
  });

  // ── Test 6: cleanup removes the listener ─────────────────────────────────
  it("stops receiving callbacks after the cleanup function is called", () => {
    const schema: QuantizedSchema = { attributes: [] };
    const ws     = makeWsMock();
    const onChunk = vi.fn();

    const stop = createQuantizedAdapter(ws as unknown as WebSocket, schema, onChunk);

    // Confirm it works before cleanup
    ws.emit(buildPacket([{ x: 1, y: 2, z: 3 }], 0, 0, 0, 10, schema));
    expect(onChunk).toHaveBeenCalledTimes(1);

    stop();

    // Should NOT fire after cleanup
    ws.emit(buildPacket([{ x: 4, y: 5, z: 6 }], 0, 0, 0, 10, schema));
    expect(onChunk).toHaveBeenCalledTimes(1); // still 1
    expect(ws.listenerCount()).toBe(0);
  });

  // ── Test 7: zero-point packet ─────────────────────────────────────────────
  it("produces an empty chunk (not null) for a zero-point packet", () => {
    const schema: QuantizedSchema = { attributes: [] };
    const ws     = makeWsMock();
    const chunks: unknown[] = [];

    createQuantizedAdapter(ws as unknown as WebSocket, schema, (c) => chunks.push(c));

    ws.emit(buildPacket([], 0, 0, 0, 100, schema));

    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { points: unknown[] }).points).toHaveLength(0);
  });
});
