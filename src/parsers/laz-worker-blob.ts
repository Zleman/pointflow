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

  return { xyz: xyz, attributes: attributes, transfers: transfers };
}

// Awaits _lazReady, then decodes all LAZ points, emitting CHUNK messages.

async function decodeLaz(lazBuffer, header, chunkSize) {
  var module = await _lazReady;

  var pf        = header.pointFormat;
  var scaleX    = header.scaleX, scaleY = header.scaleY, scaleZ = header.scaleZ;
  var offsetX   = header.offsetX, offsetY = header.offsetY, offsetZ = header.offsetZ;
  var centroidX = header.centroidX, centroidY = header.centroidY, centroidZ = header.centroidZ;
  var hasGps    = pf === 1 || pf === 3 || pf >= 6;
  var hasRgb    = pf === 2 || pf === 3 || pf === 7 || pf === 8;

  // Copy full LAZ buffer into WASM linear memory.
  var lazBytes = new Uint8Array(lazBuffer);
  var inputPtr = module._malloc(lazBytes.length);
  module.HEAPU8.set(lazBytes, inputPtr);

  var lz = new module.LASZip();
  lz.open(inputPtr, lazBytes.length);

  var total    = lz.getCount();
  var pointLen = lz.getPointLength();
  var destPtr  = module._malloc(pointLen);

  var parsed = 0;
  while (parsed < total) {
    var batchSize = Math.min(chunkSize, total - parsed);

    var xyz            = new Float32Array(batchSize * 3);
    var intensity      = new Float32Array(batchSize);
    var classification = new Float32Array(batchSize);
    var returnNum      = new Float32Array(batchSize);
    var gpsTime = hasGps ? new Float32Array(batchSize) : null;
    var red     = hasRgb ? new Float32Array(batchSize) : null;
    var green   = hasRgb ? new Float32Array(batchSize) : null;
    var blue    = hasRgb ? new Float32Array(batchSize) : null;

    for (var i = 0; i < batchSize; i++) {
      lz.getPoint(destPtr);

      // Re-read HEAPU8.buffer reference each iteration: WASM memory may
      // grow when laz-perf allocates internally, which invalidates old views.
      var view = new DataView(module.HEAPU8.buffer, destPtr, pointLen);

      var xi = view.getInt32(0, true);
      var yi = view.getInt32(4, true);
      var zi = view.getInt32(8, true);

      xyz[i * 3]     = (xi * scaleX + offsetX) - centroidX;
      xyz[i * 3 + 1] = (yi * scaleY + offsetY) - centroidY;
      xyz[i * 3 + 2] = (zi * scaleZ + offsetZ) - centroidZ;

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

    parsed += batchSize;
    var progress = total > 0 ? parsed / total : 1;

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
      { type: 'CHUNK', xyz: xyz, attributes: attributes, count: batchSize, progress: progress },
      transfers
    );
    await new Promise(function(r) { setTimeout(r, 0); });
  }

  lz.delete();
  module._free(inputPtr);
  module._free(destPtr);

  return parsed;
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
      var lasBuffer = await response.arrayBuffer();
      var lasBytes  = new Uint8Array(lasBuffer);
      var lasHeader = parseLasHeader(lasBytes);

      if (!lasHeader) {
        throw new Error('Not a valid LAS file — LASF signature not found in first 4 bytes.');
      }

      self.postMessage({
        type: 'HEADER',
        vertexCount: lasHeader.pointCount,
        attributeKeys: lasHeader.attributeKeys,
        format: lasHeader.isLaz ? 'laz/' + lasHeader.pointFormat : 'las/' + lasHeader.pointFormat,
        coordinateOffset: [lasHeader.centroidX, lasHeader.centroidY, lasHeader.centroidZ]
      });

      var totalParsed;
      if (lasHeader.isLaz) {
        // LAZ: decode via laz-perf (WASM already initialising in background).
        totalParsed = await decodeLaz(lasBuffer, lasHeader, chunkSize);
      } else {
        // Uncompressed LAS: direct read, no WASM needed.
        var lasTotal  = lasHeader.pointCount;
        var lasParsed = 0;
        while (lasParsed < lasTotal) {
          var lasCount    = Math.min(chunkSize, lasTotal - lasParsed);
          var lasChunk    = emitLasChunk(lasBuffer, lasHeader, lasParsed, lasCount);
          lasParsed      += lasCount;
          var lasProgress = lasTotal > 0 ? lasParsed / lasTotal : 1;
          self.postMessage(
            { type: 'CHUNK', xyz: lasChunk.xyz, attributes: lasChunk.attributes, count: lasCount, progress: lasProgress },
            lasChunk.transfers
          );
          await new Promise(function(r) { setTimeout(r, 0); });
        }
        totalParsed = lasParsed;
      }

      self.postMessage({ type: 'DONE', totalParsed: totalParsed });
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
