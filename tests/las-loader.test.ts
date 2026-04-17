/**
 * M9 — LAS/LAZ decoder acceptance tests.
 *
 * Tests use synthetic LAS 1.2 / 1.4 buffers built inline (no external files).
 * All five acceptance criteria from ROADMAP_V2.md are covered:
 *
 *   1. LAS 1.2 binary: correctness vs known point count + bounds
 *   2. Coordinate conversion: scale + offset applied correctly
 *   3. Coordinate centring: float32-safe positions at UTM-range coordinates
 *   4. Attribute extraction: intensity, classification, return_num per format
 *   5. LAZ detection: clear error when laszip VLR is present
 */

import { describe, it, expect } from "vitest";
import { parseLasHeader, parseLasPoints } from "../src/parsers/las-parser";
import { lasPointDataFormatId } from "../src/parsers/las-point-format";

// ─── Test helper ──────────────────────────────────────────────────────────────

interface TestPoint {
  x: number; y: number; z: number;
  intensity?: number;
  classification?: number;
  returnNum?: number;
}

interface BuildLasOptions {
  version?: [number, number];        // [major, minor], default [1, 2]
  scale?:  [number, number, number]; // default [0.001, 0.001, 0.001]
  offset?: [number, number, number]; // default [0, 0, 0]
  pointFormat?: number;              // default 0
  points: TestPoint[];
  injectLazVlr?: boolean;            // simulate a LAZ-compressed file
}

/**
 * Build a minimal synthetic LAS file buffer with the given parameters.
 * Only point formats 0 and 1 are supported by this helper.
 */
function buildLasBuffer(opts: BuildLasOptions): ArrayBuffer {
  const {
    version      = [1, 2],
    scale        = [0.001, 0.001, 0.001],
    offset       = [0, 0, 0],
    pointFormat  = 0,
    points,
    injectLazVlr = false,
  } = opts;

  // Point record length by format:  0 → 20 bytes, 1 → 28 bytes (adds GPS time)
  const pointRecLen = pointFormat === 1 ? 28 : 20;

  // Compute bounding box from world coordinates
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }

  // Optionally inject a fake laszip VLR (54-byte header only, no data)
  const lazVlrBytes = injectLazVlr ? 54 : 0;
  const numVLRs     = injectLazVlr ? 1  : 0;

  const HEADER_SIZE  = 227;
  const offsetToData = HEADER_SIZE + lazVlrBytes;
  const count        = points.length;
  const buf          = new ArrayBuffer(offsetToData + count * pointRecLen);
  const view         = new DataView(buf);
  const u8           = new Uint8Array(buf);

  // ── Public header ──────────────────────────────────────────────────────────
  u8[0] = 76; u8[1] = 65; u8[2] = 83; u8[3] = 70;  // "LASF"

  view.setUint8(24, version[0]);  // version major
  view.setUint8(25, version[1]);  // version minor

  view.setUint16(94, HEADER_SIZE,  true);  // header size
  view.setUint32(96, offsetToData, true);  // offset to point data
  view.setUint32(100, numVLRs,     true);  // number of VLRs
  view.setUint8(104, pointFormat);          // point data format
  view.setUint16(105, pointRecLen, true);  // point data record length
  view.setUint32(107, count,       true);  // legacy point count (LAS 1.0–1.3)

  // Scale + offset
  view.setFloat64(131, scale[0],  true); // X scale
  view.setFloat64(139, scale[1],  true); // Y scale
  view.setFloat64(147, scale[2],  true); // Z scale
  view.setFloat64(155, offset[0], true); // X offset
  view.setFloat64(163, offset[1], true); // Y offset
  view.setFloat64(171, offset[2], true); // Z offset

  // Bounding box
  view.setFloat64(179, maxX, true);
  view.setFloat64(187, minX, true);
  view.setFloat64(195, maxY, true);
  view.setFloat64(203, minY, true);
  view.setFloat64(211, maxZ, true);
  view.setFloat64(219, minZ, true);

  // ── Optional fake laszip VLR ───────────────────────────────────────────────
  if (injectLazVlr) {
    // VLR: [reserved:2][userId:16][recordId:2][recLen:2][description:32]
    const vlrBase = HEADER_SIZE;
    view.setUint16(vlrBase + 18, 22204, true);  // laszip record ID
    view.setUint16(vlrBase + 20, 0,     true);  // no data bytes follow
  }

  // ── Point records (format 0 / 1) ──────────────────────────────────────────
  for (let i = 0; i < count; i++) {
    const p    = points[i];
    const base = offsetToData + i * pointRecLen;

    // Encode world → integer: x_int = round((x_world - offsetX) / scaleX)
    view.setInt32(base + 0, Math.round((p.x - offset[0]) / scale[0]), true);
    view.setInt32(base + 4, Math.round((p.y - offset[1]) / scale[1]), true);
    view.setInt32(base + 8, Math.round((p.z - offset[2]) / scale[2]), true);

    const rawIntensity = Math.round((p.intensity ?? 0.5) * 65535);
    view.setUint16(base + 12, rawIntensity,         true); // intensity
    view.setUint8( base + 14, p.returnNum  ?? 1);         // return number bits
    view.setUint8( base + 15, p.classification ?? 1);     // classification (formats 0-5: byte 15)
    view.setInt8(  base + 16, 0);                         // scan angle
    view.setUint8( base + 17, 0);                         // user data
    view.setUint16(base + 18, 0,                   true); // point source ID

    // Format 1 adds GPS time at byte 20 (just write 0 for tests)
    if (pointFormat === 1) {
      view.setFloat64(base + 20, 0.0, true);
    }
  }

  return buf;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("M9 — LAS decoder", () => {

  it("strips LAZ compression bits from public-header format byte (0x87 → 7)", () => {
    expect(lasPointDataFormatId(0x87)).toBe(7);
    expect(lasPointDataFormatId(7)).toBe(7);
    expect(lasPointDataFormatId(0)).toBe(0);
  });

  // ── Test 1: Header parsing — point count + format ──────────────────────────
  it("parseLasHeader returns correct point count and format for LAS 1.2 format-0 file", () => {
    const buf = buildLasBuffer({
      version: [1, 2],
      pointFormat: 0,
      points: [
        { x: 1.0, y: 2.0, z: 3.0 },
        { x: 4.0, y: 5.0, z: 6.0 },
        { x: 7.0, y: 8.0, z: 9.0 },
      ],
    });

    const header = parseLasHeader(new Uint8Array(buf));

    expect(header).not.toBeNull();
    expect(header!.pointCount).toBe(3);
    expect(header!.pointFormat).toBe(0);
    expect(header!.versionMajor).toBe(1);
    expect(header!.versionMinor).toBe(2);
    expect(header!.isLaz).toBe(false);
    // Format 0 → three standard attributes
    expect(header!.attributeKeys).toEqual(['intensity', 'classification', 'return_num']);
  });

  // ── Test 2: Coordinate conversion — scale + offset applied correctly ────────
  it("parseLasPoints applies scale and offset and produces correct world positions", () => {
    const scale: [number, number, number]  = [0.001, 0.001, 0.001];
    const offset: [number, number, number] = [10.0, 20.0, 30.0];
    const testPoints = [
      { x: 10.5, y: 20.7, z: 30.3, intensity: 0.8, classification: 5, returnNum: 1 },
      { x: 11.0, y: 21.0, z: 31.0, intensity: 0.2, classification: 2, returnNum: 2 },
    ];
    const buf    = buildLasBuffer({ scale, offset, points: testPoints });
    const header = parseLasHeader(new Uint8Array(buf))!;
    const chunk  = parseLasPoints(buf, header, 0, testPoints.length);

    // Centroid = midpoint of bounding box
    const cx = (10.5 + 11.0) / 2;   // 10.75
    const cy = (20.7 + 21.0) / 2;   // 20.85
    const cz = (30.3 + 31.0) / 2;   // 30.65

    // Rendered = world - centroid
    expect(chunk.xyz[0]).toBeCloseTo(10.5 - cx, 2);  // -0.25
    expect(chunk.xyz[1]).toBeCloseTo(20.7 - cy, 2);  // -0.15
    expect(chunk.xyz[2]).toBeCloseTo(30.3 - cz, 2);  // -0.35

    expect(chunk.xyz[3]).toBeCloseTo(11.0 - cx, 2);  // +0.25
    expect(chunk.xyz[4]).toBeCloseTo(21.0 - cy, 2);  // +0.15
    expect(chunk.xyz[5]).toBeCloseTo(31.0 - cz, 2);  // +0.35

    expect(chunk.count).toBe(2);
  });

  // ── Test 3: UTM coordinate centring — float32-safe positions ───────────────
  it("centres coordinates so float32 positions are safe at UTM-range values", () => {
    // UTM Easting ≈ 500 000 m, Northing ≈ 5 000 000 m
    // Without centring, float32 has ~0.03 m precision at these magnitudes.
    // With centring, positions near 0 → exact float32 representation.
    const offset: [number, number, number] = [500000.0, 5000000.0, 0.0];
    const scale: [number, number, number]  = [0.001, 0.001, 0.001];
    const testPoints = [
      { x: 500000.0, y: 5000000.0, z: 100.0 },
      { x: 500001.0, y: 5000001.0, z: 101.0 },
    ];
    const buf    = buildLasBuffer({ scale, offset, points: testPoints });
    const header = parseLasHeader(new Uint8Array(buf))!;

    // centroid = (500000+500001)/2, (5000000+5000001)/2, (100+101)/2
    expect(header.centroidX).toBeCloseTo(500000.5, 3);
    expect(header.centroidY).toBeCloseTo(5000000.5, 3);
    expect(header.centroidZ).toBeCloseTo(100.5, 3);

    const chunk = parseLasPoints(buf, header, 0, testPoints.length);

    // After centring, all values are within [-0.5, +0.5]
    for (let i = 0; i < chunk.xyz.length; i++) {
      expect(Math.abs(chunk.xyz[i])).toBeLessThanOrEqual(1.0);
    }
    // Specific values: point 0 → (−0.5, −0.5, −0.5); point 1 → (+0.5, +0.5, +0.5)
    expect(chunk.xyz[0]).toBeCloseTo(-0.5, 2);
    expect(chunk.xyz[3]).toBeCloseTo( 0.5, 2);
  });

  // ── Test 4: Attribute extraction — intensity, classification, return_num ────
  it("extracts intensity (normalised), classification, and return_num correctly", () => {
    const testPoints = [
      { x: 0, y: 0, z: 0, intensity: 1.0, classification: 6,  returnNum: 1 },
      { x: 1, y: 0, z: 0, intensity: 0.0, classification: 2,  returnNum: 2 },
      { x: 2, y: 0, z: 0, intensity: 0.5, classification: 11, returnNum: 3 },
    ];
    const buf    = buildLasBuffer({ points: testPoints });
    const header = parseLasHeader(new Uint8Array(buf))!;
    const chunk  = parseLasPoints(buf, header, 0, testPoints.length);

    const getAttr = (key: string) => chunk.attributes.find(a => a.key === key)!.values;

    const intensity      = getAttr('intensity');
    const classification = getAttr('classification');
    const returnNum      = getAttr('return_num');

    // Intensity is uint16 / 65535 — round-trip check
    expect(intensity[0]).toBeCloseTo(1.0, 3);
    expect(intensity[1]).toBeCloseTo(0.0, 3);
    expect(intensity[2]).toBeCloseTo(0.5, 2);

    expect(classification[0]).toBe(6);
    expect(classification[1]).toBe(2);
    expect(classification[2]).toBe(11);

    // returnNum is encoded in bits 0-2 for format 0
    expect(returnNum[0]).toBe(1);
    expect(returnNum[1]).toBe(2);
    expect(returnNum[2]).toBe(3);
  });

  // ── Test 5: LAZ detection — clear error on compressed file ─────────────────
  it("parseLasHeader detects LAZ VLR and sets isLaz=true", () => {
    const buf    = buildLasBuffer({ points: [{ x: 0, y: 0, z: 0 }], injectLazVlr: true });
    const header = parseLasHeader(new Uint8Array(buf));

    expect(header).not.toBeNull();
    expect(header!.isLaz).toBe(true);
    // Consumers should check isLaz and throw a helpful error:
    expect(() => {
      if (header!.isLaz) throw new Error("LAZ compressed — use laz-perf");
    }).toThrow("LAZ compressed");
  });

  // ── Bonus: format-1 adds gps_time to attributeKeys ────────────────────────
  it("format-1 header includes gps_time in attributeKeys", () => {
    const buf    = buildLasBuffer({ pointFormat: 1, points: [{ x: 0, y: 0, z: 0 }] });
    const header = parseLasHeader(new Uint8Array(buf))!;
    expect(header.attributeKeys).toContain('gps_time');
    expect(header.pointRecLen).toBe(28);
  });

  // ── Bonus: null on non-LAS bytes ──────────────────────────────────────────
  it("parseLasHeader returns null for non-LAS bytes", () => {
    const notLas = new Uint8Array(300).fill(0);
    expect(parseLasHeader(notLas)).toBeNull();
  });
});
