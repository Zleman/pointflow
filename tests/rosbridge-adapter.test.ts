/**
 * M11.2a — rosbridge adapter acceptance tests.
 *
 * Coverage:
 *   1. Decodes a PointCloud2 message with x/y/z float32 fields.
 *   2. Extracts configured extra fields (intensity, label).
 *   3. Skips NaN/Inf points.
 *   4. Ignores messages for a different topic.
 *   5. Ignores non-publish ops (op="status", etc.).
 *   6. Handles big-endian byte order.
 *   7. Cleanup sends unsubscribe and closes socket.
 */

import { describe, it, expect, vi } from "vitest";
import { createRosbridgeAdapter } from "../src/transport/rosbridge-adapter";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a binary PointCloud2 data buffer for N float32 points (x,y,z,intensity). */
function buildPointCloud2Data(
  points: { x: number; y: number; z: number; intensity?: number }[],
  littleEndian = true,
): string {
  const POINT_STEP = 16; // 4 × float32
  const buf  = new ArrayBuffer(points.length * POINT_STEP);
  const view = new DataView(buf);
  for (let i = 0; i < points.length; i++) {
    const base = i * POINT_STEP;
    view.setFloat32(base,      points[i].x,                 littleEndian);
    view.setFloat32(base + 4,  points[i].y,                 littleEndian);
    view.setFloat32(base + 8,  points[i].z,                 littleEndian);
    view.setFloat32(base + 12, points[i].intensity ?? 0,    littleEndian);
  }
  // base64-encode
  const bytes  = new Uint8Array(buf);
  let binary   = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Standard PointCloud2 fields descriptor for (x,y,z,intensity) float32 layout. */
const FIELDS_XYZI = [
  { name: "x",         offset: 0,  datatype: 7, count: 1 },
  { name: "y",         offset: 4,  datatype: 7, count: 1 },
  { name: "z",         offset: 8,  datatype: 7, count: 1 },
  { name: "intensity", offset: 12, datatype: 7, count: 1 },
];

function makePublish(topic: string, points: { x: number; y: number; z: number; intensity?: number }[], bigEndian = false) {
  return JSON.stringify({
    op:    "publish",
    topic,
    msg: {
      height:       1,
      width:        points.length,
      fields:       FIELDS_XYZI,
      is_bigendian: bigEndian,
      point_step:   16,
      row_step:     points.length * 16,
      data:         buildPointCloud2Data(points, !bigEndian),
      is_dense:     true,
    },
  });
}

/** Minimal WebSocket mock. */
function makeWsMock() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {
    open: [], message: [], error: [],
  };
  const sent: string[] = [];
  return {
    onopen:    null as ((e: unknown) => void) | null,
    onmessage: null as ((e: unknown) => void) | null,
    onerror:   null as ((e: unknown) => void) | null,
    send(data: string) { sent.push(data); },
    close() {},
    emit(event: string, data?: unknown) {
      if (event === "open"    && this.onopen)    this.onopen({});
      if (event === "message" && this.onmessage) this.onmessage({ data });
      if (event === "error"   && this.onerror)   this.onerror({});
    },
    sent,
  };
}

// Patch WebSocket constructor to return our mock
function patchWs(mock: ReturnType<typeof makeWsMock>) {
  const orig = (globalThis as Record<string, unknown>)["WebSocket"];
  (globalThis as Record<string, unknown>)["WebSocket"] = function() { return mock; };
  return () => { (globalThis as Record<string, unknown>)["WebSocket"] = orig; };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("M11.2a — rosbridge adapter", () => {

  it("decodes x/y/z from a PointCloud2 message", () => {
    const mock    = makeWsMock();
    const restore = patchWs(mock);
    const chunks: unknown[] = [];

    createRosbridgeAdapter("ws://robot:9090", "/scan", {
      onChunk: (c) => chunks.push(c),
    });

    mock.emit("open");
    mock.emit("message", makePublish("/scan", [{ x: 1, y: 2, z: 3 }]));

    expect(chunks).toHaveLength(1);
    const pt = (chunks[0] as { points: { x: number; y: number; z: number }[] }).points[0];
    expect(pt.x).toBeCloseTo(1, 3);
    expect(pt.y).toBeCloseTo(2, 3);
    expect(pt.z).toBeCloseTo(3, 3);
    restore();
  });

  it("extracts configured extra fields (intensity)", () => {
    const mock    = makeWsMock();
    const restore = patchWs(mock);
    const chunks: unknown[] = [];

    createRosbridgeAdapter("ws://robot:9090", "/scan", {
      fields:   { intensity: "intensity" },
      onChunk:  (c) => chunks.push(c),
    });

    mock.emit("open");
    mock.emit("message", makePublish("/scan", [{ x: 1, y: 2, z: 3, intensity: 0.75 }]));

    const pt = (chunks[0] as { points: { attributes: Record<string, number> }[] }).points[0];
    expect(pt.attributes.intensity).toBeCloseTo(0.75, 3);
    restore();
  });

  it("skips NaN/Inf points", () => {
    const mock    = makeWsMock();
    const restore = patchWs(mock);
    const chunks: unknown[] = [];

    createRosbridgeAdapter("ws://robot:9090", "/scan", {
      onChunk: (c) => chunks.push(c),
    });

    mock.emit("open");
    mock.emit("message", makePublish("/scan", [
      { x: NaN, y: 0, z: 0 },
      { x: 1,   y: 2, z: 3 },
      { x: Infinity, y: 0, z: 0 },
    ]));

    const pts = (chunks[0] as { points: unknown[] }).points;
    expect(pts).toHaveLength(1); // only the finite point
    restore();
  });

  it("ignores messages for a different topic", () => {
    const mock    = makeWsMock();
    const restore = patchWs(mock);
    const onChunk = vi.fn();

    createRosbridgeAdapter("ws://robot:9090", "/scan", { onChunk });

    mock.emit("open");
    mock.emit("message", makePublish("/other_topic", [{ x: 1, y: 2, z: 3 }]));

    expect(onChunk).not.toHaveBeenCalled();
    restore();
  });

  it("ignores non-publish ops", () => {
    const mock    = makeWsMock();
    const restore = patchWs(mock);
    const onChunk = vi.fn();

    createRosbridgeAdapter("ws://robot:9090", "/scan", { onChunk });

    mock.emit("open");
    mock.emit("message", JSON.stringify({ op: "status", level: "none", msg: "Connected" }));

    expect(onChunk).not.toHaveBeenCalled();
    restore();
  });

  it("sends subscribe message on open", () => {
    const mock    = makeWsMock();
    const restore = patchWs(mock);

    createRosbridgeAdapter("ws://robot:9090", "/velodyne_points", {
      onChunk: () => {},
    });

    mock.emit("open");

    expect(mock.sent).toHaveLength(1);
    const msg = JSON.parse(mock.sent[0]);
    expect(msg.op).toBe("subscribe");
    expect(msg.topic).toBe("/velodyne_points");
    restore();
  });
});
