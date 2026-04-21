/**
 * LAZ-capable loader worker.
 *
 * File size exception (~649 lines): serialised as a Blob URL string at runtime; see
 * loader-worker-blob.ts for the architectural explanation of why parsers must be inlined.
 *
 * Identical to the standard loader worker (PLY / XYZ / LAS) but also decodes
 * LAZ (compressed LAS) files using laz-perf, whose WASM binary is base64-
 * inlined at build time — no separate fetch required.
 *
 * Import from "pointflow/laz" rather than this file directly:
 *   import { createLazLoader } from "pointflow/laz";
 *
 * Usage with <PointCloud>:
 *   import { createLazLoader } from "pointflow/laz";
 *   <PointCloud src="/scan.laz" loaderFactory={createLazLoader} />
 *
 * Message protocol: identical to loader-worker-blob.ts (PARSE → HEADER / CHUNK / DONE / ERROR).
 *
 * Architecture note: format-parser utilities are duplicated from loader-worker-blob.ts.
 * Both workers are serialised as Blob URL strings and cannot share ES module imports.
 * Keep the two implementations in sync manually.
 */

import { LAZ_PERF_JS, LAZ_PERF_WASM_B64 } from "./_laz-inlined";

// Built as a JS string: the laz-perf Emscripten module and its WASM binary are
// injected at runtime via template-literal interpolation.  The base64 WASM
// string contains only [A-Za-z0-9+/=] so it is safe inside a JS string literal.

const LAZ_WORKER_SCRIPT_HEAD = /* javascript */ `
'use strict';


var _lazWasmB64 = "` + LAZ_PERF_WASM_B64 + `";

(function() {
  var b = atob(_lazWasmB64);
  var n = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) n[i] = b.charCodeAt(i);
  _lazWasmB64 = n.buffer; // replace the string with an ArrayBuffer
})();


`;

const LAZ_WORKER_SCRIPT_BODY = /* javascript */ `

// Initialise laz-perf immediately so WASM is ready before any LAZ file arrives.
// createLazPerf({ wasmBinary: buf }) skips the fetch and uses the ArrayBuffer.
var _lazMod = createLazPerf({ wasmBinary: _lazWasmB64 });
var _lazReady = _lazMod["ready"];

async function _resolveLazModule() {
  var m = await Promise.resolve(_lazMod);
  if (m && typeof m.ChunkDecoder === 'function') return m;
  if (m && m.ready) {
    var mr = await m.ready;
    if (mr && typeof mr.ChunkDecoder === 'function') return mr;
  }
  if (_lazReady) {
    var r = await _lazReady;
    if (r && typeof r.ChunkDecoder === 'function') return r;
  }
  throw new Error('laz-perf initialised but ChunkDecoder is unavailable');
}


var PROP_SIZE = {
  float:4, float32:4,
  double:8, float64:8,
  int:4, int32:4, uint:4, uint32:4,
  short:2, int16:2, ushort:2, uint16:2,
  char:1, int8:1, uchar:1, uint8:1
};


function concatBytes(a, b) {
  var c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

function readProp(view, offset, type, le) {
  switch (type) {
    case 'float': case 'float32': return view.getFloat32(offset, le);
    case 'double': case 'float64': return view.getFloat64(offset, le);
    case 'int': case 'int32': return view.getInt32(offset, le);
    case 'uint': case 'uint32': return view.getUint32(offset, le);
    case 'short': case 'int16': return view.getInt16(offset, le);
    case 'ushort': case 'uint16': return view.getUint16(offset, le);
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    default: return view.getFloat32(offset, le);
  }
}


function parsePlyHeader(bytes) {
  var maxScan = Math.min(bytes.length, 32768);
  var text = new TextDecoder().decode(bytes.subarray(0, maxScan));
  var END_TAG = 'end_header\\n';
  var endIdx = text.indexOf(END_TAG);
  if (endIdx === -1) {
    END_TAG = 'end_header\\r\\n';
    endIdx = text.indexOf(END_TAG);
    if (endIdx === -1) return null;
  }
  var headerText = text.slice(0, endIdx);
  var headerByteLen = new TextEncoder().encode(headerText + END_TAG).length;

  var lines = headerText.split(/\\r?\\n/);
  var format = 'binary_little_endian';
  var vertexCount = 0;
  var faceCount = 0;
  var props = [];
  var inVertex = false;
  var stride = 0;

  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\\s+/);
    if (!parts[0]) continue;
    if (parts[0] === 'format') {
      format = parts[1];
    } else if (parts[0] === 'element') {
      inVertex = parts[1] === 'vertex';
      if (inVertex) vertexCount = parseInt(parts[2], 10);
      if (parts[1] === 'face') faceCount = parseInt(parts[2], 10);
    } else if (parts[0] === 'property' && inVertex) {
      if (parts[1] === 'list') continue;
      var ptype = parts[1], pname = parts[2];
      var psize = PROP_SIZE[ptype] || 4;
      props.push({ name: pname, type: ptype, size: psize, offset: stride });
      stride += psize;
    }
  }

  return { format: format, vertexCount: vertexCount, faceCount: faceCount, props: props, stride: stride, headerByteLen: headerByteLen };
}


function emitBinaryChunk(buffer, byteOffset, count, props, stride, le, xIdx, yIdx, zIdx, attrIdxs, attrKeys) {
  var xyz = new Float32Array(count * 3);
  var attrArrays = [];
  for (var j = 0; j < attrIdxs.length; j++) attrArrays.push(new Float32Array(count));

  var view = new DataView(buffer, byteOffset, count * stride);

  for (var i = 0; i < count; i++) {
    var base = i * stride;
    xyz[i * 3]     = readProp(view, base + props[xIdx].offset, props[xIdx].type, le);
    xyz[i * 3 + 1] = readProp(view, base + props[yIdx].offset, props[yIdx].type, le);
    xyz[i * 3 + 2] = readProp(view, base + props[zIdx].offset, props[zIdx].type, le);
    for (var j = 0; j < attrIdxs.length; j++) {
      var ap = props[attrIdxs[j]];
      attrArrays[j][i] = readProp(view, base + ap.offset, ap.type, le);
    }
  }

  var attributes = [];
  var transfers = [xyz.buffer];
  for (var j = 0; j < attrIdxs.length; j++) {
    attributes.push({ key: attrKeys[j], values: attrArrays[j] });
    transfers.push(attrArrays[j].buffer);
  }

  return { xyz: xyz, attributes: attributes, transfers: transfers };
}


function emitAsciiChunk(lines, startLine, count, xIdx, yIdx, zIdx, attrIdxs, attrKeys) {
  var xyz = new Float32Array(count * 3);
  var attrArrays = [];
  for (var j = 0; j < attrIdxs.length; j++) attrArrays.push(new Float32Array(count));

  for (var i = 0; i < count; i++) {
    var parts = lines[startLine + i].trim().split(/\\s+/);
    xyz[i * 3]     = parseFloat(parts[xIdx]) || 0;
    xyz[i * 3 + 1] = parseFloat(parts[yIdx]) || 0;
    xyz[i * 3 + 2] = parseFloat(parts[zIdx]) || 0;
    for (var j = 0; j < attrIdxs.length; j++) {
      attrArrays[j][i] = parseFloat(parts[attrIdxs[j]]) || 0;
    }
  }

  var attributes = [];
  var transfers = [xyz.buffer];
  for (var j = 0; j < attrIdxs.length; j++) {
    attributes.push({ key: attrKeys[j], values: attrArrays[j] });
    transfers.push(attrArrays[j].buffer);
  }

  return { xyz: xyz, attributes: attributes, transfers: transfers };
}


function parseXyz(text, chunkSize) {
  var rawLines = text.split(/\\r?\\n/);
  var dataLines = [];
  var headerKeys = null;

  var firstLine = '';
  for (var i = 0; i < rawLines.length; i++) {
    firstLine = rawLines[i].trim();
    if (firstLine.length > 0) { break; }
  }
  var firstParts = firstLine.split(/[\\s,\\t]+/);
  if (firstParts.length >= 3 && isNaN(parseFloat(firstParts[0]))) {
    headerKeys = firstParts;
    rawLines = rawLines.slice(1);
  }

  for (var i = 0; i < rawLines.length; i++) {
    var l = rawLines[i].trim();
    if (l.length > 0 && l[0] !== '#') dataLines.push(l);
  }

  var total = dataLines.length;
  if (total === 0) return { totalPoints: 0, attrKeys: [], chunks: [] };

  var numCols = dataLines[0].split(/[\\s,\\t]+/).length;
  var attrCount = Math.max(0, numCols - 3);
  var attrKeys = headerKeys ? headerKeys.slice(3) : [];
  for (var j = attrKeys.length; j < attrCount; j++) attrKeys.push('attr' + j);

  var chunks = [];
  for (var start = 0; start < total; start += chunkSize) {
    var end = Math.min(start + chunkSize, total);
    var count = end - start;
    var xyz = new Float32Array(count * 3);
    var attrArrays = [];
    for (var j = 0; j < attrCount; j++) attrArrays.push(new Float32Array(count));

    for (var i = 0; i < count; i++) {
      var parts = dataLines[start + i].split(/[\\s,\\t]+/);
      xyz[i * 3]     = parseFloat(parts[0]) || 0;
      xyz[i * 3 + 1] = parseFloat(parts[1]) || 0;
      xyz[i * 3 + 2] = parseFloat(parts[2]) || 0;
      for (var j = 0; j < attrCount; j++) {
        attrArrays[j][i] = parseFloat(parts[3 + j]) || 0;
      }
    }

    var attributes = [];
    var transfers = [xyz.buffer];
    for (var j = 0; j < attrCount; j++) {
      attributes.push({ key: attrKeys[j], values: attrArrays[j] });
      transfers.push(attrArrays[j].buffer);
    }
    chunks.push({ xyz: xyz, attributes: attributes, count: count, transfers: transfers, progress: end / total });
  }

  return { totalPoints: total, attrKeys: attrKeys, chunks: chunks };
}


function parseLasHeader(bytes) {
  if (bytes.length < 227) return null;
  if (bytes[0] !== 76 || bytes[1] !== 65 || bytes[2] !== 83 || bytes[3] !== 70) return null;

  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  var versionMajor = view.getUint8(24);
  var versionMinor = view.getUint8(25);
  var headerSize   = view.getUint16(94, true);
  var offsetToData = view.getUint32(96, true);
  var numVLRs      = view.getUint32(100, true);
  var pointFormat  = view.getUint8(104) & 0x3f;
  var pointRecLen  = view.getUint16(105, true);

  var pointCount = (versionMajor === 1 && versionMinor >= 4 && bytes.length >= 375)
    ? view.getUint32(247, true)
    : view.getUint32(107, true);

  var scaleX  = view.getFloat64(131, true);
  var scaleY  = view.getFloat64(139, true);
  var scaleZ  = view.getFloat64(147, true);
  var offsetX = view.getFloat64(155, true);
  var offsetY = view.getFloat64(163, true);
  var offsetZ = view.getFloat64(171, true);
  var maxX    = view.getFloat64(179, true);
  var minX    = view.getFloat64(187, true);
  var maxY    = view.getFloat64(195, true);
  var minY    = view.getFloat64(203, true);
  var maxZ    = view.getFloat64(211, true);
  var minZ    = view.getFloat64(219, true);

  var centroidX = (minX + maxX) / 2;
  var centroidY = (minY + maxY) / 2;
  var centroidZ = (minZ + maxZ) / 2;

  // Scan VLRs for laszip record ID 22204 → LAZ-compressed.
  var isLaz = false;
  var vlrOff = headerSize;
  for (var vi = 0; vi < numVLRs && vlrOff + 54 <= bytes.length; vi++) {
    var recordId = view.getUint16(vlrOff + 18, true);
    var recLen   = view.getUint16(vlrOff + 20, true);
    if (recordId === 22204) { isLaz = true; break; }
    vlrOff += 54 + recLen;
  }

  var attributeKeys = ['intensity', 'classification', 'return_num'];
  var hasGps = pointFormat === 1 || pointFormat === 3 || pointFormat >= 6;
  var hasRgb = pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8;
  if (hasGps) attributeKeys.push('gps_time');
  if (hasRgb) attributeKeys.push('red', 'green', 'blue');

  return {
    headerSize: headerSize, offsetToData: offsetToData,
    pointFormat: pointFormat, pointRecLen: pointRecLen, pointCount: pointCount,
    scaleX: scaleX, scaleY: scaleY, scaleZ: scaleZ,
    offsetX: offsetX, offsetY: offsetY, offsetZ: offsetZ,
    centroidX: centroidX, centroidY: centroidY, centroidZ: centroidZ,
    isLaz: isLaz, attributeKeys: attributeKeys
  };
}


function emitLasChunk(buffer, header, startIdx, count) {
  var pf        = header.pointFormat;
  var recLen    = header.pointRecLen;
  var scaleX    = header.scaleX,    scaleY = header.scaleY,    scaleZ = header.scaleZ;
  var offsetX   = header.offsetX,   offsetY = header.offsetY,  offsetZ = header.offsetZ;
  var centroidX = header.centroidX, centroidY = header.centroidY, centroidZ = header.centroidZ;
  var byteBase  = header.offsetToData + startIdx * recLen;

  var view           = new DataView(buffer);
  var xyz            = new Float32Array(count * 3);
  var intensity      = new Float32Array(count);
  var classification = new Float32Array(count);
  var returnNum      = new Float32Array(count);

  var hasGps = pf === 1 || pf === 3 || pf >= 6;
  var hasRgb = pf === 2 || pf === 3 || pf === 7 || pf === 8;
  var gpsTime = hasGps ? new Float32Array(count) : null;
  var red     = hasRgb ? new Float32Array(count) : null;
  var green   = hasRgb ? new Float32Array(count) : null;
  var blue    = hasRgb ? new Float32Array(count) : null;

  for (var i = 0; i < count; i++) {
    var base = byteBase + i * recLen;
    var xi = view.getInt32(base + 0, true);
    var yi = view.getInt32(base + 4, true);
    var zi = view.getInt32(base + 8, true);

    xyz[i * 3]     = (xi * scaleX + offsetX) - centroidX;
    xyz[i * 3 + 1] = (yi * scaleY + offsetY) - centroidY;
    xyz[i * 3 + 2] = (zi * scaleZ + offsetZ) - centroidZ;

    intensity[i]      = view.getUint16(base + 12, true) / 65535.0;
    var retByte       = view.getUint8(base + 14);
    returnNum[i]      = pf < 6 ? (retByte & 0x07) : (retByte & 0x0F);
    classification[i] = view.getUint8(base + (pf < 6 ? 15 : 16));

    if (hasGps) {
      gpsTime[i] = view.getFloat64(base + (pf < 6 ? 20 : 22), true);
    }
    if (hasRgb) {
      var rgbOff = pf === 2 ? 20 : pf === 3 ? 28 : 30;
      red[i]   = view.getUint16(base + rgbOff,     true) / 65535.0;
      green[i] = view.getUint16(base + rgbOff + 2, true) / 65535.0;
      blue[i]  = view.getUint16(base + rgbOff + 4, true) / 65535.0;
    }
  }

  var allPresent = new Uint8Array(count).fill(1);
  var attributes = [
    { key: 'intensity',      values: intensity,      present: allPresent },
    { key: 'classification', values: classification, present: allPresent },
    { key: 'return_num',     values: returnNum,      present: allPresent }
  ];
  var transfers = [xyz.buffer, intensity.buffer, classification.buffer, returnNum.buffer];
  if (hasGps) { attributes.push({ key: 'gps_time', values: gpsTime, present: allPresent }); transfers.push(gpsTime.buffer); }
  if (hasRgb) {
    attributes.push(
      { key: 'red',   values: red,   present: allPresent },
      { key: 'green', values: green, present: allPresent },
      { key: 'blue',  values: blue,  present: allPresent }
    );
    transfers.push(red.buffer, green.buffer, blue.buffer);
  }

  return { xyz: xyz, attributes: attributes, transfers: transfers };
}


function parseLazChunkSize(carry, lazHdr) {
  var view    = new DataView(carry.buffer, carry.byteOffset, carry.byteLength);
  var numVLRs = view.getUint32(100, true);
  var vlrOff  = lazHdr.headerSize;
  for (var i = 0; i < numVLRs; i++) {
    if (vlrOff + 54 > carry.length) break;
    var recordId = view.getUint16(vlrOff + 18, true);
    var recLen   = view.getUint16(vlrOff + 20, true);
    if (recordId === 22204 && recLen >= 16) {
      return view.getUint32(vlrOff + 54 + 12, true);
    }
    vlrOff += 54 + recLen;
  }
  return 50000;
}

function parseLazChunkOffsets(carry, offsetToData, chunkCount) {
  var view    = new DataView(carry.buffer, carry.byteOffset, carry.byteLength);
  var offsets = [];
  for (var i = 0; i < chunkCount; i++) {
    var base = offsetToData + 8 + i * 8;
    var lo   = view.getUint32(base,     true);
    var hi   = view.getUint32(base + 4, true);
    offsets.push(hi * 0x100000000 + lo);
  }
  return offsets;
}

self.onmessage = async function(e) {
  var d = e.data;
  if (d.type !== 'PARSE') return;

  var url = d.url;
  var chunkSize = d.chunkSize || 10000;

  try {
    var urlHash  = url.split('#')[1] || '';
    var fetchUrl = url.split('#')[0];

    var response = await fetch(fetchUrl);
    if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching ' + fetchUrl);

    var forcedFormat = d.format || null;
    var path = fetchUrl.split('?')[0].toLowerCase();

    var isLas = forcedFormat === 'las' || forcedFormat === 'laz' ||
                (!forcedFormat && (path.endsWith('.las') || path.endsWith('.laz') ||
                  urlHash === '.las' || urlHash === '.laz'));

    var isXyz = forcedFormat === 'xyz' ||
                (!forcedFormat && !isLas && (path.endsWith('.xyz') || path.endsWith('.csv') || path.endsWith('.txt')));
    if (!isXyz && !path.endsWith('.ply') && forcedFormat !== 'ply' && !isLas) isXyz = true;

    if (isXyz) {
      var text = await response.text();
      var result = parseXyz(text, chunkSize);
      self.postMessage({ type: 'HEADER', vertexCount: result.totalPoints, attributeKeys: result.attrKeys, format: 'xyz' });
      for (var i = 0; i < result.chunks.length; i++) {
        var c = result.chunks[i];
        self.postMessage({ type: 'CHUNK', xyz: c.xyz, attributes: c.attributes, count: c.count, progress: c.progress }, c.transfers);
        await new Promise(function(r) { setTimeout(r, 0); });
      }
      self.postMessage({ type: 'DONE', totalParsed: result.totalPoints });
      return;
    }

    if (isLas) {
      var lazReader    = response.body.getReader();
      var carry        = new Uint8Array(0);
      var lazHdr       = null;
      var lazChunkSz   = 0;
      var chunkCount   = 0;
      var chunkOffsets = null;

      while (true) {
        var lazRead = await lazReader.read();
        if (lazRead.value) carry = concatBytes(carry, lazRead.value);

        if (!lazHdr) {
          if (carry.length < 100 && !lazRead.done) continue;
          if (carry.length >= 100) {
            var peekView = new DataView(carry.buffer, carry.byteOffset, carry.byteLength);
            var needLen  = Math.max(375, peekView.getUint32(96, true));
            if (carry.length < needLen && !lazRead.done) continue;
          }
          lazHdr = parseLasHeader(carry);
          if (!lazHdr) throw new Error('Not a valid LAS file — LASF signature not found in first 4 bytes.');
          lazChunkSz = parseLazChunkSize(carry, lazHdr);
          chunkCount  = Math.ceil(lazHdr.pointCount / lazChunkSz);
          self.postMessage({
            type: 'HEADER',
            vertexCount: lazHdr.pointCount,
            attributeKeys: lazHdr.attributeKeys,
            format: lazHdr.isLaz ? 'laz/' + lazHdr.pointFormat : 'las/' + lazHdr.pointFormat,
            coordinateOffset: [lazHdr.centroidX, lazHdr.centroidY, lazHdr.centroidZ]
          });

          if (!lazHdr.isLaz) {
            var lasTotal  = lazHdr.pointCount;
            var lasBuffer = carry.buffer;
            var lasParsedU = 0;
            while (lasParsedU < lasTotal) {
              var lasCount    = Math.min(chunkSize, lasTotal - lasParsedU);
              var lasChunk    = emitLasChunk(lasBuffer, lazHdr, lasParsedU, lasCount);
              lasParsedU     += lasCount;
              var lasProgress = lasTotal > 0 ? lasParsedU / lasTotal : 1;
              self.postMessage(
                { type: 'CHUNK', xyz: lasChunk.xyz, attributes: lasChunk.attributes, count: lasCount, progress: lasProgress },
                lasChunk.transfers
              );
              await new Promise(function(r) { setTimeout(r, 0); });
            }
            self.postMessage({ type: 'DONE', totalParsed: lasParsedU });
            return;
          }
        }

        if (!chunkOffsets) {
          var needForCTCount = lazHdr.offsetToData + 8;
          if (carry.length < needForCTCount && !lazRead.done) continue;
          var ctView   = new DataView(carry.buffer, carry.byteOffset + lazHdr.offsetToData, 8);
          var chunkCountFromTable = ctView.getUint32(4, true);
          if (chunkCountFromTable > 0) {
            chunkCount = chunkCountFromTable;
            var needForCT = lazHdr.offsetToData + 8 + chunkCount * 8;
            if (carry.length < needForCT && !lazRead.done) continue;
            chunkOffsets = parseLazChunkOffsets(carry, lazHdr.offsetToData, chunkCount);
            carry        = carry.slice(needForCT);
          } else {
            // chunkCount=0 means a single continuous compressed stream — not independently-seekable chunks.
            // ChunkDecoder requires independently-seekable chunks; use LASZip for this path.
            while (true) {
              var lzStreamRead = await lazReader.read();
              if (lzStreamRead.value) carry = concatBytes(carry, lzStreamRead.value);
              if (lzStreamRead.done) break;
            }
            var lazModule = await _resolveLazModule();
            var filePtr   = lazModule._malloc(carry.length);
            lazModule.HEAPU8.set(carry, filePtr);
            var laszip    = new lazModule.LASZip();
            laszip.open(filePtr, carry.length);
            var lzRecLen  = laszip.getPointLength();
            var lzPf      = laszip.getPointFormat();
            var lzCount   = laszip.getCount();
            var lzTotal   = lzCount > 0 ? lzCount : lazHdr.pointCount;
            var lzHasGps  = lzPf === 1 || lzPf === 3 || lzPf >= 6;
            var lzHasRgb  = lzPf === 2 || lzPf === 3 || lzPf === 7 || lzPf === 8;
            var lzDest    = lazModule._malloc(lzRecLen);
            var lzSX = lazHdr.scaleX, lzSY = lazHdr.scaleY, lzSZ = lazHdr.scaleZ;
            var lzOX = lazHdr.offsetX, lzOY = lazHdr.offsetY, lzOZ = lazHdr.offsetZ;
            var lzCX = lazHdr.centroidX, lzCY = lazHdr.centroidY, lzCZ = lazHdr.centroidZ;

            // Stride sampling: when the file has more points than the ring buffer
            // can hold, decode every N-th point for spatially representative coverage.
            // LASZip is a state machine — getPoint() must be called for every point,
            // but we only collect the data for emitted ones.
            var lzBudget  = d.pointBudget || 0;
            var lzStride  = (lzBudget > 0 && lzTotal > lzBudget)
              ? Math.ceil(lzTotal / lzBudget)
              : 1;
            var lzScanBatchSize = chunkSize * lzStride;  // scan this many, emit chunkSize

            var lzDecoded = 0;  // total points advanced through LASZip
            var lzParsed  = 0;  // total points emitted

            while (lzDecoded < lzTotal) {
              var lzScan    = Math.min(lzScanBatchSize, lzTotal - lzDecoded);
              var lzEmit    = Math.ceil(lzScan / lzStride);
              var lzXyz     = new Float32Array(lzEmit * 3);
              var lzInt     = new Float32Array(lzEmit);
              var lzCls     = new Float32Array(lzEmit);
              var lzRet     = new Float32Array(lzEmit);
              var lzGps     = lzHasGps ? new Float32Array(lzEmit) : null;
              var lzRed     = lzHasRgb ? new Float32Array(lzEmit) : null;
              var lzGrn     = lzHasRgb ? new Float32Array(lzEmit) : null;
              var lzBlu     = lzHasRgb ? new Float32Array(lzEmit) : null;

              var lzOut = 0;
              for (var li = 0; li < lzScan; li++) {
                laszip.getPoint(lzDest);
                if (li % lzStride !== 0) continue;
                var lv  = new DataView(lazModule.HEAPU8.buffer, lzDest, lzRecLen);
                var lxi = lv.getInt32(0, true);
                var lyi = lv.getInt32(4, true);
                var lzi = lv.getInt32(8, true);
                lzXyz[lzOut * 3]     = (lxi * lzSX + lzOX) - lzCX;
                lzXyz[lzOut * 3 + 1] = (lyi * lzSY + lzOY) - lzCY;
                lzXyz[lzOut * 3 + 2] = (lzi * lzSZ + lzOZ) - lzCZ;
                lzInt[lzOut] = lv.getUint16(12, true) / 65535.0;
                var lrb      = lv.getUint8(14);
                lzRet[lzOut] = lzPf < 6 ? (lrb & 0x07) : (lrb & 0x0F);
                lzCls[lzOut] = lzPf < 6 ? (lv.getUint8(15) & 0x1F) : lv.getUint8(16);
                if (lzHasGps) lzGps[lzOut] = lv.getFloat64(lzPf < 6 ? 20 : 22, true);
                if (lzHasRgb) {
                  var lro      = lzPf === 2 ? 20 : lzPf === 3 ? 28 : 30;
                  lzRed[lzOut] = lv.getUint16(lro,     true) / 65535.0;
                  lzGrn[lzOut] = lv.getUint16(lro + 2, true) / 65535.0;
                  lzBlu[lzOut] = lv.getUint16(lro + 4, true) / 65535.0;
                }
                lzOut++;
              }

              lzDecoded += lzScan;
              lzParsed  += lzOut;

              // Trim typed arrays to actual emitted count if last batch is short.
              if (lzOut < lzEmit) {
                lzXyz = lzXyz.subarray(0, lzOut * 3);
                lzInt = lzInt.subarray(0, lzOut);
                lzCls = lzCls.subarray(0, lzOut);
                lzRet = lzRet.subarray(0, lzOut);
                if (lzHasGps) lzGps = lzGps.subarray(0, lzOut);
                if (lzHasRgb) { lzRed = lzRed.subarray(0, lzOut); lzGrn = lzGrn.subarray(0, lzOut); lzBlu = lzBlu.subarray(0, lzOut); }
              }

              var lzPresent = new Uint8Array(lzOut).fill(1);
              var lzAttrs   = [
                { key: 'intensity',      values: lzInt, present: lzPresent },
                { key: 'classification', values: lzCls, present: lzPresent },
                { key: 'return_num',     values: lzRet, present: lzPresent }
              ];
              var lzXfers = [lzXyz.buffer, lzInt.buffer, lzCls.buffer, lzRet.buffer];
              if (lzHasGps) { lzAttrs.push({ key: 'gps_time', values: lzGps, present: lzPresent }); lzXfers.push(lzGps.buffer); }
              if (lzHasRgb) {
                lzAttrs.push(
                  { key: 'red',   values: lzRed, present: lzPresent },
                  { key: 'green', values: lzGrn, present: lzPresent },
                  { key: 'blue',  values: lzBlu, present: lzPresent }
                );
                lzXfers.push(lzRed.buffer, lzGrn.buffer, lzBlu.buffer);
              }
              var lzProgress = lzTotal > 0 ? lzDecoded / lzTotal : 1;
              self.postMessage(
                { type: 'CHUNK', xyz: lzXyz, attributes: lzAttrs, count: lzOut, progress: lzProgress },
                lzXfers
              );
              await new Promise(function(r) { setTimeout(r, 0); });
            }

            laszip.delete();
            lazModule._free(filePtr);
            lazModule._free(lzDest);
            self.postMessage({ type: 'DONE', totalParsed: lzParsed });
            return;
          }
          break;
        }

        if (lazRead.done) break;
      }

      var module    = await _resolveLazModule();
      var lasParsed = 0;
      var pf        = lazHdr.pointFormat;
      var recLen    = lazHdr.pointRecLen;
      var hasGps    = pf === 1 || pf === 3 || pf >= 6;
      var hasRgb    = pf === 2 || pf === 3 || pf === 7 || pf === 8;
      var scaleX = lazHdr.scaleX, scaleY = lazHdr.scaleY, scaleZ = lazHdr.scaleZ;
      var offsetX = lazHdr.offsetX, offsetY = lazHdr.offsetY, offsetZ = lazHdr.offsetZ;
      var centroidX = lazHdr.centroidX, centroidY = lazHdr.centroidY, centroidZ = lazHdr.centroidZ;

      for (var chunkIdx = 0; chunkIdx < chunkCount; chunkIdx++) {
        var isLastChunk   = chunkIdx === chunkCount - 1;
        var pointsInChunk = isLastChunk ? (lazHdr.pointCount - lasParsed) : lazChunkSz;

        var chunkByteLen;
        if (!isLastChunk) {
          chunkByteLen = chunkOffsets[chunkIdx + 1] - chunkOffsets[chunkIdx];
          while (carry.length < chunkByteLen) {
            var r = await lazReader.read();
            if (r.value) carry = concatBytes(carry, r.value);
            if (r.done) break;
          }
        } else {
          while (true) {
            var r = await lazReader.read();
            if (r.value) carry = concatBytes(carry, r.value);
            if (r.done) break;
          }
          chunkByteLen = carry.length;
        }

        var chunkData = carry.slice(0, chunkByteLen);
        carry = carry.slice(chunkByteLen);

        var inputPtr = module._malloc(chunkData.length);
        module.HEAPU8.set(chunkData, inputPtr);
        var decoder  = new module.ChunkDecoder();
        decoder.open(pf, recLen, inputPtr);
        var destPtr  = module._malloc(recLen);

        var decoded    = 0;
        var allPresent = new Uint8Array(Math.min(chunkSize, pointsInChunk)).fill(1);

        while (decoded < pointsInChunk) {
          var batchSize      = Math.min(chunkSize, pointsInChunk - decoded);
          var xyz            = new Float32Array(batchSize * 3);
          var intensity      = new Float32Array(batchSize);
          var classification = new Float32Array(batchSize);
          var returnNum      = new Float32Array(batchSize);
          var gpsTime = hasGps ? new Float32Array(batchSize) : null;
          var red     = hasRgb ? new Float32Array(batchSize) : null;
          var green   = hasRgb ? new Float32Array(batchSize) : null;
          var blue    = hasRgb ? new Float32Array(batchSize) : null;

          for (var i = 0; i < batchSize; i++) {
            decoder.getPoint(destPtr);
            var view = new DataView(module.HEAPU8.buffer, destPtr, recLen);
            var xi = view.getInt32(0, true);
            var yi = view.getInt32(4, true);
            var zi = view.getInt32(8, true);
            xyz[i * 3]     = (xi * scaleX + offsetX) - centroidX;
            xyz[i * 3 + 1] = (yi * scaleY + offsetY) - centroidY;
            xyz[i * 3 + 2] = (zi * scaleZ + offsetZ) - centroidZ;
            intensity[i]      = view.getUint16(12, true) / 65535.0;
            var retByte       = view.getUint8(14);
            returnNum[i]      = pf < 6 ? (retByte & 0x07) : (retByte & 0x0F);
            classification[i] = pf < 6 ? (view.getUint8(15) & 0x1F) : view.getUint8(16);
            if (hasGps) gpsTime[i] = view.getFloat64(pf < 6 ? 20 : 22, true);
            if (hasRgb) {
              var rgbOff = pf === 2 ? 20 : pf === 3 ? 28 : 30;
              red[i]   = view.getUint16(rgbOff,     true) / 65535.0;
              green[i] = view.getUint16(rgbOff + 2, true) / 65535.0;
              blue[i]  = view.getUint16(rgbOff + 4, true) / 65535.0;
            }
          }

          if (batchSize !== allPresent.length) allPresent = new Uint8Array(batchSize).fill(1);
          var attributes = [
            { key: 'intensity',      values: intensity,      present: allPresent },
            { key: 'classification', values: classification, present: allPresent },
            { key: 'return_num',     values: returnNum,      present: allPresent }
          ];
          var transfers = [xyz.buffer, intensity.buffer, classification.buffer, returnNum.buffer];
          if (hasGps) { attributes.push({ key: 'gps_time', values: gpsTime, present: allPresent }); transfers.push(gpsTime.buffer); }
          if (hasRgb) {
            attributes.push(
              { key: 'red',   values: red,   present: allPresent },
              { key: 'green', values: green, present: allPresent },
              { key: 'blue',  values: blue,  present: allPresent }
            );
            transfers.push(red.buffer, green.buffer, blue.buffer);
          }

          decoded   += batchSize;
          lasParsed += batchSize;
          var progress = lazHdr.pointCount > 0 ? lasParsed / lazHdr.pointCount : 1;
          self.postMessage(
            { type: 'CHUNK', xyz, attributes, count: batchSize, progress },
            transfers
          );
          await new Promise(function(r) { setTimeout(r, 0); });
        }

        decoder.delete();
        module._free(inputPtr);
        module._free(destPtr);
      }

      self.postMessage({ type: 'DONE', totalParsed: lasParsed });
      return;
    }

    // PLY: stream body
    var reader = response.body.getReader();
    var carry = new Uint8Array(0);
    var header = null;
    var parsedTotal = 0;

    while (true) {
      var read = await reader.read();
      var done = read.done, value = read.value;

      if (header === null) {
        carry = value ? concatBytes(carry, value) : carry;
        header = parsePlyHeader(carry);
        if (header === null) {
          if (done) throw new Error('Could not parse PLY header (file too short or malformed)');
          continue;
        }

        var xIdx = -1, yIdx = -1, zIdx = -1;
        for (var i = 0; i < header.props.length; i++) {
          if (header.props[i].name === 'x') xIdx = i;
          else if (header.props[i].name === 'y') yIdx = i;
          else if (header.props[i].name === 'z') zIdx = i;
        }
        if (xIdx < 0 || yIdx < 0 || zIdx < 0) throw new Error('PLY file missing x, y, or z property');

        var attrIdxs = [], attrKeys = [];
        for (var i = 0; i < header.props.length; i++) {
          if (i !== xIdx && i !== yIdx && i !== zIdx) {
            attrIdxs.push(i);
            attrKeys.push(header.props[i].name);
          }
        }

        var propStr = header.props.map(function(p) { return p.name + '(' + p.type + ')'; }).join(', ');
        console.log('[PLY] === HEADER PARSED ===\\n[PLY] Format: ' + header.format +
          '\\n[PLY] Vertex count: ' + header.vertexCount +
          '\\n[PLY] Face count (skipped): ' + header.faceCount +
          '\\n[PLY] Vertex stride: ' + header.stride + ' bytes' +
          '\\n[PLY] Properties: ' + propStr);
        console.log('[PLY] X index: ' + xIdx + ', Y index: ' + yIdx + ', Z index: ' + zIdx);
        console.log('[PLY] Will read exactly ' + header.vertexCount + ' vertices');

        self.postMessage({ type: 'HEADER', vertexCount: header.vertexCount, attributeKeys: attrKeys, format: header.format });

        var isAscii = header.format === 'ascii';
        var le = header.format !== 'binary_big_endian';

        if (isAscii) {
          var remaining = carry.slice(header.headerByteLen);
          if (!done) {
            while (true) {
              var next = await reader.read();
              if (next.value) remaining = concatBytes(remaining, next.value);
              if (next.done) break;
            }
          }
          var dataText = new TextDecoder().decode(remaining);
          var dataLines = dataText.split(/\\r?\\n/).filter(function(l) { return l.trim().length > 0; });
          var totalLines = dataLines.length;
          var vertexLines = Math.min(totalLines, header.vertexCount);
          for (var start = 0; start < vertexLines; start += chunkSize) {
            var count = Math.min(chunkSize, vertexLines - start);
            var chunk = emitAsciiChunk(dataLines, start, count, xIdx, yIdx, zIdx, attrIdxs, attrKeys);
            parsedTotal += count;
            var progress = header.vertexCount > 0 ? parsedTotal / header.vertexCount : 1;
            self.postMessage({ type: 'CHUNK', xyz: chunk.xyz, attributes: chunk.attributes, count: count, progress: progress }, chunk.transfers);
            await new Promise(function(r) { setTimeout(r, 0); });
          }
          console.log('[PLY] === PARSING COMPLETE ===\\n[PLY] Expected vertices: ' + header.vertexCount +
            '\\n[PLY] Actual vertices parsed: ' + parsedTotal);
          if (parsedTotal !== header.vertexCount) {
            console.warn('[PLY] MISMATCH: parsed ' + parsedTotal + ' vs expected ' + header.vertexCount);
          }
          self.postMessage({ type: 'DONE', totalParsed: parsedTotal });
          return;
        }

        carry = carry.slice(header.headerByteLen);
      } else {
        if (value && parsedTotal < header.vertexCount) carry = concatBytes(carry, value);
      }

      if (parsedTotal >= header.vertexCount) {
        if (done) break;
        continue;
      }

      var stride = header.stride;
      var completeVertices = Math.floor(carry.length / stride);
      var vertsRemaining = header.vertexCount - parsedTotal;
      if (vertsRemaining < 0) vertsRemaining = 0;
      completeVertices = Math.min(completeVertices, vertsRemaining);
      if (completeVertices > 0) {
        var usedBytes = completeVertices * stride;
        var slice = carry.buffer.slice(carry.byteOffset, carry.byteOffset + usedBytes);
        carry = carry.slice(usedBytes);

        var offset = 0;
        var remaining = completeVertices;
        while (remaining > 0) {
          var count = Math.min(chunkSize, remaining);
          var chunk = emitBinaryChunk(slice, offset, count, header.props, stride, le, xIdx, yIdx, zIdx, attrIdxs, attrKeys);
          parsedTotal += count;
          offset += count * stride;
          remaining -= count;
          var progress = header.vertexCount > 0 ? parsedTotal / header.vertexCount : 0;
          self.postMessage({ type: 'CHUNK', xyz: chunk.xyz, attributes: chunk.attributes, count: count, progress: Math.min(progress, 1) }, chunk.transfers);
          await new Promise(function(r) { setTimeout(r, 0); });
        }
        if (parsedTotal >= header.vertexCount) {
          carry = new Uint8Array(0);
        }
      }

      if (done) break;
    }

    console.log('[PLY] === PARSING COMPLETE ===\\n[PLY] Expected vertices: ' + header.vertexCount +
      '\\n[PLY] Actual vertices parsed: ' + parsedTotal);
    if (parsedTotal !== header.vertexCount) {
      console.warn('[PLY] MISMATCH: parsed ' + parsedTotal + ' vs expected ' + header.vertexCount);
    }
    self.postMessage({ type: 'DONE', totalParsed: parsedTotal });
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: (err && err.message) ? err.message : String(err) });
  }
};
`;

// Assemble the full worker script: WASM preamble + laz-perf.js + handler body
const LAZ_WORKER_SCRIPT = LAZ_WORKER_SCRIPT_HEAD + LAZ_PERF_JS + LAZ_WORKER_SCRIPT_BODY;

/** Creates the LAZ-capable loader worker from an inline Blob (no separate worker file needed). */
export function createLazWorker(): Worker {
  const blob = new Blob([LAZ_WORKER_SCRIPT], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}
