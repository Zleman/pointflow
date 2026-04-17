/**
 * COPC file reader.
 *
 * Parses LAS header, locates the COPC VLRs, reads the copc-info struct and
 * the copc-hierarchy pages from a fetched ArrayBuffer (or via HTTP range
 * requests for large files).
 */

import type {
  CopcLasHeader,
  CopcInfo,
  CopcNode,
  CopcIndex,
} from "./copc-types";
import { voxelKeyString } from "./copc-types";
import { lasPointDataFormatId } from "../parsers/las-point-format";


/**
 * Parse the LAS 1.2-1.4 public header from the start of the file buffer.
 * The buffer must contain at least the first ~375 bytes (LAS 1.4 header end).
 */
export function parseCopcLasHeader(buf: ArrayBuffer): CopcLasHeader {
  const bytes = new Uint8Array(buf);
  const view  = new DataView(buf);

  // LAS magic: "LASF"
  if (
    bytes[0] !== 0x4c || bytes[1] !== 0x41 ||
    bytes[2] !== 0x53 || bytes[3] !== 0x46
  ) {
    throw new Error("Not a LAS file (missing LASF signature)");
  }

  const versionMinor  = view.getUint8(25);
  const headerSize    = view.getUint16(94, true);
  const pointFormat   = lasPointDataFormatId(view.getUint8(104));
  const pointRecLen   = view.getUint16(105, true);

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

  const centroidX = (minX + maxX) / 2;
  const centroidY = (minY + maxY) / 2;
  const centroidZ = (minZ + maxZ) / 2;

  const hasGps = pointFormat === 1 || pointFormat === 3 || pointFormat >= 6;
  const hasRgb = pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8;

  const attributeKeys = ["intensity", "classification", "return_num"];
  if (hasGps) attributeKeys.push("gps_time");
  if (hasRgb) attributeKeys.push("red", "green", "blue");

  return {
    pointFormat, pointRecLen,
    scaleX, scaleY, scaleZ,
    offsetX, offsetY, offsetZ,
    centroidX, centroidY, centroidZ,
    attributeKeys,
  };
}


interface VlrDescriptor {
  userId: string;
  recordId: number;
  /** Byte offset in the file where VLR *data* begins (after the 54-byte header). */
  dataOffset: number;
  dataLength: number;
}

/** Walk the VLR list (after the LAS public header) and return descriptors. */
function scanVlrs(buf: ArrayBuffer): VlrDescriptor[] {
  const view  = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const headerSize = view.getUint16(94, true);
  const numVlrs    = view.getUint32(100, true);

  const vlrs: VlrDescriptor[] = [];
  let off = headerSize;

  for (let i = 0; i < numVlrs; i++) {
    if (off + 54 > buf.byteLength) break;

    // userId: 16 bytes at offset+2
    let userId = "";
    for (let b = 0; b < 16; b++) {
      const c = bytes[off + 2 + b];
      if (c === 0) break;
      userId += String.fromCharCode(c);
    }

    const recordId   = view.getUint16(off + 18, true);
    const dataLength = view.getUint16(off + 20, true);
    const dataOffset = off + 54;

    vlrs.push({ userId, recordId, dataOffset, dataLength });
    off += 54 + dataLength;
  }

  return vlrs;
}


/**
 * Locate the copc-info VLR (userId="copc", recordId=1) in the buffer and parse
 * the 160-byte struct.
 */
export function findCopcInfoVlr(buf: ArrayBuffer, _lasHeader: CopcLasHeader): CopcInfo | null {
  const vlrs = scanVlrs(buf);
  const view = new DataView(buf);

  for (const vlr of vlrs) {
    if (vlr.userId !== "copc" || vlr.recordId !== 1) continue;
    if (vlr.dataLength < 160 || vlr.dataOffset + 160 > buf.byteLength) return null;

    const o = vlr.dataOffset;
    const centerX        = view.getFloat64(o + 0,  true);
    const centerY        = view.getFloat64(o + 8,  true);
    const centerZ        = view.getFloat64(o + 16, true);
    const halfsize       = view.getFloat64(o + 24, true);
    const spacing        = view.getFloat64(o + 32, true);
    const rootHierOffset = view.getBigUint64(o + 40, true);
    const rootHierSize   = view.getBigUint64(o + 48, true);
    const gpsMin         = view.getFloat64(o + 56, true);
    const gpsMax         = view.getFloat64(o + 64, true);

    return {
      center: [centerX, centerY, centerZ],
      halfsize,
      spacing,
      rootHierOffset,
      rootHierSize,
      gpsMin,
      gpsMax,
    };
  }

  return null;
}


/**
 * Parse a copc-hierarchy page from a slice of the file buffer.
 *
 * @param buf        Full or partial file ArrayBuffer that contains the page.
 * @param offset     Byte offset in `buf` where the page starts.
 * @param byteSize   Number of bytes in the page.
 */
export function parseCopcHierarchy(
  buf: ArrayBuffer,
  offset: number,
  byteSize: number,
): Map<string, CopcNode> {
  const view  = new DataView(buf, offset, byteSize);
  const nodes = new Map<string, CopcNode>();
  const ENTRY = 32;
  const count = Math.floor(byteSize / ENTRY);

  for (let i = 0; i < count; i++) {
    const o = i * ENTRY;
    const depth      = view.getInt32(o + 0,  true);
    const x          = view.getInt32(o + 4,  true);
    const y          = view.getInt32(o + 8,  true);
    const z          = view.getInt32(o + 12, true);
    const fileOffset = view.getBigUint64(o + 16, true);
    const bs         = view.getInt32(o + 24, true);
    const pc         = view.getInt32(o + 28, true);

    const key  = { depth, x, y, z };
    const node: CopcNode = {
      key,
      offset: fileOffset,
      byteSize: BigInt(bs),
      pointCount: BigInt(pc),
    };
    nodes.set(voxelKeyString(key), node);
  }

  return nodes;
}


async function readCopcBytes(
  url: string,
  fileOffset: number,
  length: number,
  fullFileBuffer: ArrayBuffer | null,
): Promise<ArrayBuffer> {
  const end = fileOffset + length;
  if (fullFileBuffer && end <= fullFileBuffer.byteLength) {
    return fullFileBuffer.slice(fileOffset, end);
  }
  const res = await fetch(url, {
    headers: { Range: `bytes=${fileOffset}-${end - 1}` },
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`COPC hierarchy page fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.arrayBuffer();
}


/**
 * Follow hierarchy entries with pointCount === -1 (nested page) and merge into `nodes`.
 */
async function expandCopcHierarchyPages(
  url: string,
  nodes: Map<string, CopcNode>,
  fullFileBuffer: ArrayBuffer | null,
): Promise<void> {
  const SUBTREE = -1n;
  const seen = new Set<string>();

  const queue: CopcNode[] = [];
  for (const n of nodes.values()) {
    if (n.pointCount === SUBTREE) queue.push(n);
  }

  const MAX_HIERARCHY_PAGES = 10_000;
  let iterations = 0;

  while (queue.length > 0) {
    if (++iterations > MAX_HIERARCHY_PAGES) {
      console.error(
        `[copc-reader] HIERARCHY TRUNCATION: ${iterations}/${MAX_HIERARCHY_PAGES} pages, ` +
        `queue remaining=${queue.length}, nodes loaded=${nodes.size}`,
      );
      break;
    }

    const stub = queue.shift()!;
    const len = Number(stub.byteSize);
    const off = Number(stub.offset);
    if (len <= 0 || off < 0) continue;

    const dedupe = `${off}:${len}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    try {
      const pageBuf = await readCopcBytes(url, off, len, fullFileBuffer);
      const sub = parseCopcHierarchy(pageBuf, 0, pageBuf.byteLength);
      for (const [k, v] of sub) {
        nodes.set(k, v);
        if (v.pointCount === SUBTREE) queue.push(v);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[copc-reader] FAILED to load hierarchy page: offset=${off}, size=${len}, error=${msg}`,
      );
      throw err;
    }
  }
}


const INITIAL_FETCH_BYTES = 1_048_576; // 1 MB

export interface FetchCopcIndexResult {
  index: CopcIndex;
  /**
   * Entire file in memory (blob: opens, or HTTP fallback when Range is unsupported).
   * When set, tile reads slice this buffer instead of issuing Range requests
   * (blob URLs do not reliably support Range).
   */
  fullFileBuffer?: ArrayBuffer;
}

/**
 * Fetch a COPC file's index (header + VLRs + hierarchy).
 *
 * Remote HTTP(S): at most two range requests (first 1 MB, then hierarchy if needed).
 * blob: URLs: one full read; returns `fullFileBuffer` for tile slicing.
 */
export async function fetchCopcIndex(url: string): Promise<FetchCopcIndexResult> {
  const u = url.trim();

  if (/^blob:/i.test(u)) {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`COPC fetch failed: ${res.status} ${res.statusText}`);
    const fullBuf = await res.arrayBuffer();
    const index = await parseCopcIndexFromBuffer(fullBuf, u, fullBuf);
    return { index, fullFileBuffer: fullBuf };
  }

  const res1 = await fetch(u, {
    headers: { Range: `bytes=0-${INITIAL_FETCH_BYTES - 1}` },
  });

  if (!res1.ok && res1.status !== 206) {
    const resFull = await fetch(u);
    if (!resFull.ok) throw new Error(`COPC fetch failed: ${resFull.status} ${resFull.statusText}`);
    const fullBuf = await resFull.arrayBuffer();
    const index = await parseCopcIndexFromBuffer(fullBuf, u, fullBuf);
    return { index, fullFileBuffer: fullBuf };
  }

  const buf1 = await res1.arrayBuffer();
  const index = await parseCopcIndexFromBuffer(buf1, u, null);
  return { index };
}

async function parseCopcIndexFromBuffer(
  buf: ArrayBuffer,
  url: string,
  fullFileBuffer: ArrayBuffer | null,
): Promise<CopcIndex> {
  const lasHeader = parseCopcLasHeader(buf);
  const info = findCopcInfoVlr(buf, lasHeader);

  if (!info) {
    throw new Error("COPC VLR (copc-info) not found in file header — is this a COPC file?");
  }

  const hierOffset = Number(info.rootHierOffset);
  const hierSize   = Number(info.rootHierSize);

  // Check if the hierarchy page is within the already-fetched buffer.
  let nodes: Map<string, CopcNode>;

  if (hierOffset + hierSize <= buf.byteLength) {
    nodes = parseCopcHierarchy(buf, hierOffset, hierSize);
  } else {
    // Need a second range request for the hierarchy.
    const res2 = await fetch(url, {
      headers: { Range: `bytes=${hierOffset}-${hierOffset + hierSize - 1}` },
    });
    if (!res2.ok && res2.status !== 206) {
      throw new Error(`COPC hierarchy fetch failed: ${res2.status} ${res2.statusText}`);
    }
    const buf2 = await res2.arrayBuffer();
    nodes = parseCopcHierarchy(buf2, 0, hierSize);
  }

  await expandCopcHierarchyPages(url, nodes, fullFileBuffer);

  return { info, lasHeader, nodes };
}
