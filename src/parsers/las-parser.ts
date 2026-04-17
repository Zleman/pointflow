import { lasPointDataFormatId } from "./las-point-format";

/**
 * LAS/LAZ binary format parser.
 *
 * Supports LAS 1.0–1.4, point formats 0–3 and 6–8 (uncompressed only).
 * LAZ (compressed) files are detected and rejected with a helpful error message
 * directing the user to laz-perf or PDAL.
 *
 * Design notes:
 *   - parseLasHeader reads only the public header block (≤ 375 bytes). No I/O.
 *   - parseLasPoints extracts a slice of point records from a pre-fetched buffer.
 *   - Coordinates are centered around the scene bounding-box centroid so all
 *     rendered positions are small float32-safe numbers. This eliminates the
 *     "camera shaking" artifact at large UTM coordinates.
 *   - The raw LAS offset + centroid shift is reported in LasHeader so callers
 *     can reconstruct real-world coordinates when needed.
 */


export interface LasHeader {
  versionMajor: number;
  versionMinor: number;
  /** Byte length of the public header block (227 for LAS 1.0–1.3, 375 for 1.4). */
  headerSize: number;
  /** Byte offset from start of file to the first point record. */
  offsetToData: number;
  /** LAS point data format ID (0–10). */
  pointFormat: number;
  /** Actual bytes per point record (may exceed spec minimum due to extra bytes). */
  pointRecLen: number;
  /** Total point count. For LAS 1.4 reads only the low 32 bits of the uint64 field. */
  pointCount: number;
  scaleX: number; scaleY: number; scaleZ: number;
  /** LAS file offset — added to (int * scale) to get world coordinates. */
  offsetX: number; offsetY: number; offsetZ: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /**
   * Scene centroid computed from the bounding box in the public header.
   * parseLasPoints subtracts this from every coordinate so rendered positions
   * are centred around origin (float32-safe even at UTM-range values).
   */
  centroidX: number; centroidY: number; centroidZ: number;
  /** True when a laszip VLR is present — file is LAZ-compressed, needs laz-perf. */
  isLaz: boolean;
  /** Attribute keys that parseLasPoints will emit, in declaration order. */
  attributeKeys: readonly string[];
}

export interface LasPointChunk {
  xyz: Float32Array;
  attributes: Array<{ key: string; values: Float32Array }>;
  count: number;
}


/**
 * Parse the LAS public header block from a byte view of the file.
 * Returns null if the buffer is too short or the LASF signature is absent.
 *
 * No I/O is performed — the caller must have already loaded at least the first
 * 375 bytes (or 227 for LAS < 1.4).
 */
export function parseLasHeader(bytes: Uint8Array): LasHeader | null {
  if (bytes.length < 227) return null;

  // "LASF" magic — 0x4C 0x41 0x53 0x46
  if (bytes[0] !== 76 || bytes[1] !== 65 || bytes[2] !== 83 || bytes[3] !== 70) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const headerSize   = view.getUint16(94, true);
  const offsetToData = view.getUint32(96, true);
  const numVLRs      = view.getUint32(100, true);
  const pointFormat  = lasPointDataFormatId(view.getUint8(104));
  const pointRecLen  = view.getUint16(105, true);

  // LAS 1.4 stores the 64-bit point count at offset 247.
  // Earlier versions use a 32-bit count at offset 107.
  // We read only the low 32 bits of the 64-bit field (safe for < ~4 billion pts).
  const pointCount = (versionMajor === 1 && versionMinor >= 4 && bytes.length >= 375)
    ? view.getUint32(247, true)
    : view.getUint32(107, true);

  const scaleX  = view.getFloat64(131, true);
  const scaleY  = view.getFloat64(139, true);
  const scaleZ  = view.getFloat64(147, true);
  const offsetX = view.getFloat64(155, true);
  const offsetY = view.getFloat64(163, true);
  const offsetZ = view.getFloat64(171, true);
  const maxX    = view.getFloat64(179, true);
  const minX    = view.getFloat64(187, true);
  const maxY    = view.getFloat64(195, true);
  const minY    = view.getFloat64(203, true);
  const maxZ    = view.getFloat64(211, true);
  const minZ    = view.getFloat64(219, true);

  // Centre the scene at origin so float32 positions are small numbers.
  const centroidX = (minX + maxX) / 2;
  const centroidY = (minY + maxY) / 2;
  const centroidZ = (minZ + maxZ) / 2;

  // Detect LAZ by scanning VLRs for the laszip record ID (22204).
  // VLR layout: [reserved:2][userId:16][recordId:2][recLen:2][description:32][data:recLen]
  // Total header = 54 bytes before the variable-length data.
  let isLaz = false;
  let vlrOff = headerSize;
  for (let i = 0; i < numVLRs && vlrOff + 54 <= bytes.length; i++) {
    const recordId = view.getUint16(vlrOff + 18, true);
    const recLen   = view.getUint16(vlrOff + 20, true);
    if (recordId === 22204) { isLaz = true; break; }
    vlrOff += 54 + recLen;
  }

  // Build attribute key list from the point format.
  const attributeKeys: string[] = ['intensity', 'classification', 'return_num'];
  const hasGps = pointFormat === 1 || pointFormat === 3 || pointFormat >= 6;
  const hasRgb = pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8;
  if (hasGps) attributeKeys.push('gps_time');
  if (hasRgb) attributeKeys.push('red', 'green', 'blue');

  return {
    versionMajor, versionMinor, headerSize, offsetToData,
    pointFormat, pointRecLen, pointCount,
    scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ,
    minX, minY, minZ, maxX, maxY, maxZ,
    centroidX, centroidY, centroidZ,
    isLaz, attributeKeys,
  };
}


/**
 * Extract `count` point records from `buffer` starting at `startIdx`.
 *
 * - Coordinates are output centred around the scene centroid (float32-safe).
 * - Intensity, red, green, blue are normalised to [0, 1].
 * - returnNum is the raw return-number bit field (1-based, not normalised).
 */
export function parseLasPoints(
  buffer: ArrayBuffer,
  header: LasHeader,
  startIdx: number,
  count: number,
): LasPointChunk {
  const {
    offsetToData, pointRecLen, pointFormat,
    scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ,
    centroidX, centroidY, centroidZ,
  } = header;

  const view     = new DataView(buffer);
  const byteBase = offsetToData + startIdx * pointRecLen;

  const xyz            = new Float32Array(count * 3);
  const intensity      = new Float32Array(count);
  const classification = new Float32Array(count);
  const returnNum      = new Float32Array(count);

  const hasGps = pointFormat === 1 || pointFormat === 3 || pointFormat >= 6;
  const hasRgb = pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8;

  const gpsTime = hasGps ? new Float32Array(count) : null;
  const red     = hasRgb ? new Float32Array(count) : null;
  const green   = hasRgb ? new Float32Array(count) : null;
  const blue    = hasRgb ? new Float32Array(count) : null;

  for (let i = 0; i < count; i++) {
    const base = byteBase + i * pointRecLen;

    const xi = view.getInt32(base + 0, true);
    const yi = view.getInt32(base + 4, true);
    const zi = view.getInt32(base + 8, true);

    // Convert integer → world → centred float32
    xyz[i * 3]     = (xi * scaleX + offsetX) - centroidX;
    xyz[i * 3 + 1] = (yi * scaleY + offsetY) - centroidY;
    xyz[i * 3 + 2] = (zi * scaleZ + offsetZ) - centroidZ;

    intensity[i] = view.getUint16(base + 12, true) / 65535.0;

    const retByte = view.getUint8(base + 14);
    // Formats 0–5: bits 0–2 hold return number.  Formats 6+: bits 0–3.
    returnNum[i] = pointFormat < 6 ? (retByte & 0x07) : (retByte & 0x0F);

    // Classification byte offset:
    //   formats 0–5 → byte 15   (byte 15 = classification value, including flags)
    //   formats 6+  → byte 16   (byte 15 = flags only; byte 16 = classification)
    classification[i] = view.getUint8(base + (pointFormat < 6 ? 15 : 16));

    if (hasGps) {
      // GPS Time byte offset within the point record:
      //   formats 1, 3 → byte 20   |   formats 6+ → byte 22
      gpsTime![i] = view.getFloat64(base + (pointFormat < 6 ? 20 : 22), true);
    }

    if (hasRgb) {
      // RGB byte offset within the point record:
      //   format 2 → byte 20   |   format 3 → byte 28   |   formats 7, 8 → byte 30
      const rgbOff = pointFormat === 2 ? 20 : pointFormat === 3 ? 28 : 30;
      red![i]   = view.getUint16(base + rgbOff,     true) / 65535.0;
      green![i] = view.getUint16(base + rgbOff + 2, true) / 65535.0;
      blue![i]  = view.getUint16(base + rgbOff + 4, true) / 65535.0;
    }
  }

  const attributes: Array<{ key: string; values: Float32Array }> = [
    { key: 'intensity',      values: intensity },
    { key: 'classification', values: classification },
    { key: 'return_num',     values: returnNum },
  ];
  if (hasGps) attributes.push({ key: 'gps_time',   values: gpsTime! });
  if (hasRgb) {
    attributes.push(
      { key: 'red',   values: red! },
      { key: 'green', values: green! },
      { key: 'blue',  values: blue! },
    );
  }

  return { xyz, attributes, count };
}
