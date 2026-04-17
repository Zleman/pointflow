/**
 * Tests for COPC header/VLR parsing from synthetic buffers.
 */
import { describe, it, expect } from "vitest";
import {
  parseCopcLasHeader,
  findCopcInfoVlr,
  parseCopcHierarchy,
} from "../src/copc/copc-reader";
import { voxelKeyString } from "../src/copc/copc-types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write a null-terminated string into a Uint8Array. */
function writeStr(arr: Uint8Array, offset: number, s: string, maxLen: number): void {
  for (let i = 0; i < Math.min(s.length, maxLen - 1); i++) {
    arr[offset + i] = s.charCodeAt(i);
  }
}

/**
 * Build a minimal LAS 1.4 public header (375 bytes) + one copc VLR.
 * Returns an ArrayBuffer large enough to contain the header and VLRs.
 */
function buildMinimalCopcBuffer(): ArrayBuffer {
  // LAS 1.4 header is 375 bytes.
  const headerSize = 375;
  // VLR record header: 54 bytes + copc-info data: 160 bytes.
  const vlrDataSize = 160;
  const vlrHeaderSize = 54;
  const totalSize = headerSize + vlrHeaderSize + vlrDataSize;

  const buf  = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const u8   = new Uint8Array(buf);

  // LAS signature "LASF"
  u8[0] = 76; u8[1] = 65; u8[2] = 83; u8[3] = 70;

  // Version 1.4
  view.setUint8(24, 1);
  view.setUint8(25, 4);

  // Header size
  view.setUint16(94, headerSize, true);

  // Offset to point data (past header + 1 VLR)
  view.setUint32(96, headerSize + vlrHeaderSize + vlrDataSize, true);

  // Number of VLRs = 1
  view.setUint32(100, 1, true);

  // Point data format 0, record length 20
  view.setUint8(104, 0);
  view.setUint16(105, 20, true);

  // Point count (LAS 1.4 at offset 247)
  view.setUint32(247, 1000, true);

  // Scale X/Y/Z
  view.setFloat64(131, 0.001, true);
  view.setFloat64(139, 0.001, true);
  view.setFloat64(147, 0.001, true);

  // Offset X/Y/Z
  view.setFloat64(155, 500.0, true);
  view.setFloat64(163, 500.0, true);
  view.setFloat64(171, 100.0, true);

  // Bounding box: maxX, minX, maxY, minY, maxZ, minZ
  view.setFloat64(179, 510.0, true); // maxX
  view.setFloat64(187, 490.0, true); // minX
  view.setFloat64(195, 510.0, true); // maxY
  view.setFloat64(203, 490.0, true); // minY
  view.setFloat64(211, 110.0, true); // maxZ
  view.setFloat64(219,  90.0, true); // minZ

  // ── VLR header (at offset headerSize) ─────────────────────────────────
  const vlrOff = headerSize;

  // reserved: 2 bytes at vlrOff + 0 (leave as 0)
  // userId: 16 bytes at vlrOff + 2
  writeStr(u8, vlrOff + 2, "copc", 16);
  // record ID = 1 at vlrOff + 18
  view.setUint16(vlrOff + 18, 1, true);
  // record length = 160 at vlrOff + 20
  view.setUint16(vlrOff + 20, vlrDataSize, true);
  // description: 32 bytes at vlrOff + 22 (leave blank)

  // ── copc-info data (at offset headerSize + 54) ──────────────────────
  const infoOff = headerSize + vlrHeaderSize;
  view.setFloat64(infoOff + 0,  500.0, true);  // center_x
  view.setFloat64(infoOff + 8,  500.0, true);  // center_y
  view.setFloat64(infoOff + 16, 100.0, true);  // center_z
  view.setFloat64(infoOff + 24, 100.0, true);  // halfsize
  view.setFloat64(infoOff + 32,   1.0, true);  // spacing
  view.setBigUint64(infoOff + 40, BigInt(headerSize + vlrHeaderSize + vlrDataSize), true); // rootHierOffset
  view.setBigUint64(infoOff + 48, BigInt(32), true);  // rootHierSize = 1 entry
  view.setFloat64(infoOff + 56, 0.0,  true);   // gpsMin
  view.setFloat64(infoOff + 64, 1.0,  true);   // gpsMax

  return buf;
}

/** Build a synthetic copc-hierarchy page with a given number of entries. */
function buildHierarchyPage(entries: Array<{
  depth: number; x: number; y: number; z: number;
  offset: bigint; byteSize: bigint; pointCount: bigint;
}>): ArrayBuffer {
  const ENTRY = 32;
  const buf  = new ArrayBuffer(entries.length * ENTRY);
  const view = new DataView(buf);

  for (let i = 0; i < entries.length; i++) {
    const o = i * ENTRY;
    const e = entries[i];
    view.setInt32(o + 0,  e.depth, true);
    view.setInt32(o + 4,  e.x,     true);
    view.setInt32(o + 8,  e.y,     true);
    view.setInt32(o + 12, e.z,     true);
    view.setBigUint64(o + 16, e.offset, true);
    view.setInt32(o + 24, Number(e.byteSize), true);
    view.setInt32(o + 28, Number(e.pointCount), true);
  }

  return buf;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("parseCopcLasHeader", () => {
  it("parses LAS version, format, and record length", () => {
    const buf = buildMinimalCopcBuffer();
    const hdr = parseCopcLasHeader(buf);
    expect(hdr.pointFormat).toBe(0);
    expect(hdr.pointRecLen).toBe(20);
  });

  it("computes centroid from bounding box", () => {
    const buf = buildMinimalCopcBuffer();
    const hdr = parseCopcLasHeader(buf);
    expect(hdr.centroidX).toBeCloseTo(500.0);
    expect(hdr.centroidY).toBeCloseTo(500.0);
    expect(hdr.centroidZ).toBeCloseTo(100.0);
  });

  it("reads scale and offset values", () => {
    const buf = buildMinimalCopcBuffer();
    const hdr = parseCopcLasHeader(buf);
    expect(hdr.scaleX).toBeCloseTo(0.001);
    expect(hdr.offsetX).toBeCloseTo(500.0);
  });

  it("throws on non-LAS buffer", () => {
    const bad = new ArrayBuffer(400);
    expect(() => parseCopcLasHeader(bad)).toThrow("Not a LAS file");
  });

  it("includes standard attribute keys for format 0", () => {
    const buf = buildMinimalCopcBuffer();
    const hdr = parseCopcLasHeader(buf);
    expect(hdr.attributeKeys).toContain("intensity");
    expect(hdr.attributeKeys).toContain("classification");
    expect(hdr.attributeKeys).not.toContain("gps_time"); // format 0 has no GPS
  });
});

describe("findCopcInfoVlr", () => {
  it("returns null for a buffer with no copc VLR", () => {
    const buf = buildMinimalCopcBuffer();
    const view = new DataView(buf);
    // Corrupt the userId to something other than "copc".
    const u8 = new Uint8Array(buf);
    u8[375 + 2] = 0x58; // overwrite first byte of userId
    const hdr = parseCopcLasHeader(buf);
    const info = findCopcInfoVlr(buf, hdr);
    expect(info).toBeNull();
  });

  it("parses center, halfsize, spacing", () => {
    const buf  = buildMinimalCopcBuffer();
    const hdr  = parseCopcLasHeader(buf);
    const info = findCopcInfoVlr(buf, hdr);
    expect(info).not.toBeNull();
    expect(info!.center[0]).toBeCloseTo(500.0);
    expect(info!.center[1]).toBeCloseTo(500.0);
    expect(info!.center[2]).toBeCloseTo(100.0);
    expect(info!.halfsize).toBeCloseTo(100.0);
    expect(info!.spacing).toBeCloseTo(1.0);
  });

  it("parses rootHierOffset and rootHierSize as BigInt", () => {
    const buf  = buildMinimalCopcBuffer();
    const hdr  = parseCopcLasHeader(buf);
    const info = findCopcInfoVlr(buf, hdr);
    expect(typeof info!.rootHierOffset).toBe("bigint");
    expect(typeof info!.rootHierSize).toBe("bigint");
    expect(info!.rootHierSize).toBe(32n);
  });

  it("parses gpsMin and gpsMax", () => {
    const buf  = buildMinimalCopcBuffer();
    const hdr  = parseCopcLasHeader(buf);
    const info = findCopcInfoVlr(buf, hdr);
    expect(info!.gpsMin).toBeCloseTo(0.0);
    expect(info!.gpsMax).toBeCloseTo(1.0);
  });
});

describe("parseCopcHierarchy", () => {
  it("parses a single root entry", () => {
    const page = buildHierarchyPage([
      { depth: 0, x: 0, y: 0, z: 0, offset: 1000n, byteSize: 512n, pointCount: 100n },
    ]);
    const nodes = parseCopcHierarchy(page, 0, page.byteLength);
    expect(nodes.size).toBe(1);
    const root = nodes.get("0-0-0-0");
    expect(root).toBeDefined();
    expect(root!.offset).toBe(1000n);
    expect(root!.byteSize).toBe(512n);
    expect(root!.pointCount).toBe(100n);
  });

  it("parses multiple entries and keys them correctly", () => {
    const page = buildHierarchyPage([
      { depth: 0, x: 0, y: 0, z: 0, offset: 1000n, byteSize: 512n, pointCount: 100n },
      { depth: 1, x: 0, y: 0, z: 0, offset: 2000n, byteSize: 256n, pointCount: 50n },
      { depth: 1, x: 1, y: 0, z: 0, offset: 3000n, byteSize: 256n, pointCount: 45n },
    ]);
    const nodes = parseCopcHierarchy(page, 0, page.byteLength);
    expect(nodes.size).toBe(3);
    expect(nodes.has("0-0-0-0")).toBe(true);
    expect(nodes.has("1-0-0-0")).toBe(true);
    expect(nodes.has("1-1-0-0")).toBe(true);
  });

  it("returns empty map for zero-length data", () => {
    const page  = new ArrayBuffer(0);
    const nodes = parseCopcHierarchy(page, 0, 0);
    expect(nodes.size).toBe(0);
  });

  it("voxelKeyString matches Map keys", () => {
    const page = buildHierarchyPage([
      { depth: 2, x: 3, y: 1, z: 0, offset: 9000n, byteSize: 128n, pointCount: 20n },
    ]);
    const nodes = parseCopcHierarchy(page, 0, page.byteLength);
    const node = nodes.get("2-3-1-0");
    expect(node).toBeDefined();
    expect(voxelKeyString(node!.key)).toBe("2-3-1-0");
  });
});
