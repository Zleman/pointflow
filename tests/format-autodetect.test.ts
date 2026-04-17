/**
 * M12b.2 — Format auto-detect via magic bytes.
 *
 * Verifies the sniffing logic that runs when the URL has no recognised extension.
 * Tests the detection function in isolation (no fetch mocking needed).
 */

import { describe, expect, it } from "vitest";

// ── Pure detection helper (mirrors the logic inside loader-worker-blob.ts) ───

/** Returns 'las' | 'ply' | 'xyz' based on the first bytes of a file. */
function detectFormatFromBytes(magic: Uint8Array): "las" | "ply" | "xyz" {
  // LAS/LAZ: 'LASF' = [76, 65, 83, 70]
  if (
    magic.length >= 4 &&
    magic[0] === 76 && magic[1] === 65 && magic[2] === 83 && magic[3] === 70
  ) {
    return "las";
  }
  // PLY: 'ply' = [112, 108, 121]
  if (
    magic.length >= 3 &&
    magic[0] === 112 && magic[1] === 108 && magic[2] === 121
  ) {
    return "ply";
  }
  return "xyz";
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("M12b.2 — Format auto-detect via magic bytes", () => {
  it("detects LAS from 'LASF' header", () => {
    const magic = new Uint8Array([76, 65, 83, 70, 0, 0]); // 'LASF...'
    expect(detectFormatFromBytes(magic)).toBe("las");
  });

  it("detects PLY from 'ply' header", () => {
    // PLY ASCII header starts with "ply\n"
    const magic = new Uint8Array([112, 108, 121, 10, 102, 111]); // 'ply\nfo...'
    expect(detectFormatFromBytes(magic)).toBe("ply");
  });

  it("falls back to XYZ for unrecognised bytes", () => {
    const magic = new Uint8Array([49, 46, 50, 32, 51, 46, 52]); // '1.2 3.4' (XYZ text)
    expect(detectFormatFromBytes(magic)).toBe("xyz");
  });

  it("falls back to XYZ for empty byte array", () => {
    expect(detectFormatFromBytes(new Uint8Array(0))).toBe("xyz");
  });

  it("falls back to XYZ for partial magic (< 3 bytes)", () => {
    expect(detectFormatFromBytes(new Uint8Array([112, 108]))).toBe("xyz"); // 'pl' — not enough for PLY
  });

  it("does not confuse 3-byte 'pla' with PLY", () => {
    const magic = new Uint8Array([112, 108, 97]); // 'pla'
    expect(detectFormatFromBytes(magic)).toBe("xyz");
  });

  it("does not confuse 'LASX' with LAS (wrong 4th byte)", () => {
    const magic = new Uint8Array([76, 65, 83, 88]); // 'LASX'
    expect(detectFormatFromBytes(magic)).toBe("xyz");
  });

  it("detects LAS exactly on 4-byte boundary", () => {
    const magic = new Uint8Array([76, 65, 83, 70]); // exactly 'LASF'
    expect(detectFormatFromBytes(magic)).toBe("las");
  });
});
