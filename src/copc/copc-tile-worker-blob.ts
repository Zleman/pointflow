/**
 * COPC tile decoder worker blob.
 *
 * Creates a blob Worker that uses laz-perf ChunkDecoder to decompress a single
 * COPC tile (raw LAZ chunk bytes, no LAS header/VLRs).
 *
 * Message protocol:
 *   IN:  { type: "DECODE_TILE", tileBytes: ArrayBuffer, header: CopcLasHeader,
 *           nodeKey: string, pointCount: number }
 *   OUT: { type: "TILE_READY", nodeKey: string, xyz: Float32Array,
 *           attributes: DenseAttr[], count: number }
 *       | { type: "ERROR", nodeKey: string, message: string }
 */

import { LAZ_PERF_JS, LAZ_PERF_WASM_B64 } from "../parsers/_laz-inlined";


const WORKER_SCRIPT_HEAD = /* javascript */ `
'use strict';

var _lazWasmB64 = "` + LAZ_PERF_WASM_B64 + `";

(function() {
  var b = atob(_lazWasmB64);
  var n = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) n[i] = b.charCodeAt(i);
  _lazWasmB64 = n.buffer;
})();

`;

const WORKER_SCRIPT_BODY = /* javascript */ `

var _lazMod = createLazPerf({ wasmBinary: _lazWasmB64 });
var _lazReady = _lazMod["ready"];


async function decodeTile(tileBytes, header, nodeKey, pointCount) {
  var module = await Promise.resolve(_lazMod);

  var pf        = header.pointFormat;
  var recLen    = header.pointRecLen;
  var scaleX    = header.scaleX,    scaleY = header.scaleY,    scaleZ = header.scaleZ;
  var offsetX   = header.offsetX,   offsetY = header.offsetY,  offsetZ = header.offsetZ;

  // Copy tile bytes into WASM linear memory.
  var tileU8   = new Uint8Array(tileBytes);
  var inputPtr = module._malloc(tileU8.length);
  module.HEAPU8.set(tileU8, inputPtr);

  // Allocate destination buffer for one decoded point record.
  var destPtr = module._malloc(recLen);

  var decoder = new module.ChunkDecoder();
  decoder.open(pf, recLen, inputPtr);

  var hasGps = pf === 1 || pf === 3 || pf >= 6;
  var hasRgb = pf === 2 || pf === 3 || pf === 7 || pf === 8;

  var xyz            = new Float32Array(pointCount * 3);
  var intensity      = new Float32Array(pointCount);
  var classification = new Float32Array(pointCount);
  var returnNum      = new Float32Array(pointCount);
  var gpsTime = hasGps ? new Float32Array(pointCount) : null;
  var red     = hasRgb ? new Float32Array(pointCount) : null;
  var green   = hasRgb ? new Float32Array(pointCount) : null;
  var blue    = hasRgb ? new Float32Array(pointCount) : null;

  for (var i = 0; i < pointCount; i++) {
    decoder.getPoint(destPtr);

    // Re-read HEAPU8.buffer reference each iteration: WASM memory may grow.
    var view = new DataView(module.HEAPU8.buffer, destPtr, recLen);

    var xi = view.getInt32(0, true);
    var yi = view.getInt32(4, true);
    var zi = view.getInt32(8, true);

    // Absolute LAS coordinates (LAS 1.4: X = X_scale * X + X_offset).  Do not subtract
    // header centroid here — CopcGpuPipeline.uploadTilePoints subtracts index.info.center
    // once to get origin-relative positions for rendering; subtracting both would place
    // points at ~−center in the atlas.
    xyz[i * 3]     = xi * scaleX + offsetX;
    xyz[i * 3 + 1] = yi * scaleY + offsetY;
    xyz[i * 3 + 2] = zi * scaleZ + offsetZ;

    intensity[i]      = view.getUint16(12, true) / 65535.0;
    var retByte       = view.getUint8(14);
    returnNum[i]      = pf < 6 ? (retByte & 0x07) : (retByte & 0x0F);
    classification[i] = view.getUint8(pf < 6 ? 15 : 16);

    if (hasGps) gpsTime[i] = view.getFloat64(pf < 6 ? 20 : 22, true);
    if (hasRgb) {
      var rgbOff = pf === 2 ? 20 : pf === 3 ? 28 : 30;
      red[i]   = view.getUint16(rgbOff,     true) / 65535.0;
      green[i] = view.getUint16(rgbOff + 2, true) / 65535.0;
      blue[i]  = view.getUint16(rgbOff + 4, true) / 65535.0;
    }
  }

  decoder.delete();
  module._free(inputPtr);
  module._free(destPtr);

  var attributes = [
    { key: 'intensity',      values: intensity },
    { key: 'classification', values: classification },
    { key: 'return_num',     values: returnNum }
  ];
  var transfers = [xyz.buffer, intensity.buffer, classification.buffer, returnNum.buffer];
  if (hasGps) { attributes.push({ key: 'gps_time', values: gpsTime }); transfers.push(gpsTime.buffer); }
  if (hasRgb) {
    attributes.push({ key: 'red', values: red }, { key: 'green', values: green }, { key: 'blue', values: blue });
    transfers.push(red.buffer, green.buffer, blue.buffer);
  }

  self.postMessage(
    { type: 'TILE_READY', nodeKey: nodeKey, xyz: xyz, attributes: attributes, count: pointCount },
    transfers
  );
}


self.onmessage = async function(e) {
  var d = e.data;
  if (d.type !== 'DECODE_TILE') return;

  try {
    await decodeTile(d.tileBytes, d.header, d.nodeKey, d.pointCount);
  } catch (err) {
    self.postMessage({ type: 'ERROR', nodeKey: d.nodeKey, message: String(err) });
  }
};
`;

const FULL_WORKER_SCRIPT = WORKER_SCRIPT_HEAD + LAZ_PERF_JS + WORKER_SCRIPT_BODY;

/** Create a new blob Worker that can decode COPC tiles. */
export function createCopcTileWorker(): Worker {
  const blob = new Blob([FULL_WORKER_SCRIPT], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  // Revoke immediately — the browser retains the underlying script for the
  // worker's lifetime, so the URL mapping is no longer needed after launch.
  URL.revokeObjectURL(url);
  return worker;
}
