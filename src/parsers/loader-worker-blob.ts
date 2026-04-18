/**
 * Self-contained loader worker for static point cloud files.
 * Supports PLY (binary LE/BE, ASCII), XYZ/CSV, and LAS 1.0–1.4 (uncompressed).
 *
 * File size exception (~595 lines): this file is serialised as a Blob URL string at runtime.
 * Worker code cannot import ES modules, so all format parsers (PLY, XYZ, LAS) must be inlined
 * here rather than imported from separate files. See architecture note below for details.
 *
 * Message protocol:
 *   IN:  { type: "PARSE", url: string, chunkSize?: number, format?: 'ply'|'xyz'|'las'|'laz' }
 *   OUT: { type: "HEADER", vertexCount: number, attributeKeys: string[], format: string,
 *                          coordinateOffset?: [number, number, number] }
 *        { type: "CHUNK",  xyz: Float32Array, attributes: DenseAttr[], count: number, progress: number }
 *        { type: "DONE",   totalParsed: number }
 *        { type: "ERROR",  message: string }
 *
 * CHUNK transfers xyz.buffer and each attribute values.buffer (zero-copy).
 *
 * Architecture note: format-parser utilities (readProp, parsePlyHeader, emitBinaryChunk,
 * etc.) are intentionally duplicated between this file and laz-worker-blob.ts. Both
 * workers are serialised as Blob URL strings at runtime and cannot share ES module
 * imports. Eliminating the duplication would require a bundler step (rollup/esbuild)
 * that is not part of the current build. Accept the duplication; keep the two
 * implementations in sync manually.
 *
 * LAS notes:
 *   - Uncompressed LAS 1.0–1.4, point formats 0–3 and 6–8.
 *   - LAZ (compressed) files are detected and rejected with a helpful error.
 *   - Coordinates are centred around the scene bounding-box centroid so all
 *     float32 positions are small numbers (eliminates UTM "camera shaking").
 *   - coordinateOffset in the HEADER message reports the subtracted centroid.
 *   - For file:// or blob: URLs without an extension, append #.las or #.laz
 *     to the URL as a format hint (e.g. URL.createObjectURL(file) + '#.las').
 */

const LOADER_WORKER_SCRIPT = /* javascript */ `
'use strict';


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
  // Scan for "end_header\\n" in the first 32 KB
  var maxScan = Math.min(bytes.length, 32768);
  var text = new TextDecoder().decode(bytes.subarray(0, maxScan));
  var END_TAG = 'end_header\\n';
  var endIdx = text.indexOf(END_TAG);
  if (endIdx === -1) {
    // Try without trailing newline (some writers omit it)
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
      if (parts[1] === 'list') continue; // skip list properties
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

  // Check if first non-empty line is a text header (all tokens non-numeric)
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

// Supports LAS 1.0–1.4. Returns null for non-LAS bytes or truncated buffers.

function parseLasHeader(bytes) {
  if (bytes.length < 227) return null;
  // "LASF" magic bytes: 0x4C 0x41 0x53 0x46
  if (bytes[0] !== 76 || bytes[1] !== 65 || bytes[2] !== 83 || bytes[3] !== 70) return null;

  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  var versionMajor = view.getUint8(24);
  var versionMinor = view.getUint8(25);
  var headerSize   = view.getUint16(94, true);
  var offsetToData = view.getUint32(96, true);
  var numVLRs      = view.getUint32(100, true);
  var pointFormat  = view.getUint8(104) & 0x3f;
  var pointRecLen  = view.getUint16(105, true);

  // LAS 1.4 uses a 64-bit point count at offset 247 (uint64, little-endian).
  // Earlier versions use a 32-bit count at offset 107.
  // Number() is safe here: JS floats represent integers exactly up to 2^53,
  // which is ~9 quadrillion points — far beyond any real-world dataset.
  var pointCount = (versionMajor === 1 && versionMinor >= 4 && bytes.length >= 375)
    ? Number(view.getBigUint64(247, true))
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

  // Centre the scene at origin so float32 positions are small (UTM-safe).
  var centroidX = (minX + maxX) / 2;
  var centroidY = (minY + maxY) / 2;
  var centroidZ = (minZ + maxZ) / 2;

  // Scan VLRs for laszip record ID 22204 → file is LAZ-compressed.
  // VLR: [reserved:2][userId:16][recordId:2][recLen:2][description:32][data:recLen]
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
    // Formats 0-5: classification at byte 15.  Formats 6+: byte 16 (byte 15 = flags).
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


self.onmessage = async function(e) {
  var d = e.data;
  if (d.type !== 'PARSE') return;

  var url = d.url;
  var chunkSize = d.chunkSize || 10000;

  try {
    // Strip a #.las / #.laz format hint that callers may append to blob: URLs
    // (which carry no file extension) when loading files via <input type="file">.
    var urlHash  = url.split('#')[1] || '';
    var fetchUrl = url.split('#')[0];

    var response = await fetch(fetchUrl);
    if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching ' + fetchUrl);

    // Detect format: explicit override > URL extension > hash hint > magic bytes > default (XYZ).
    // Blob URLs (blob:http://…) have no extension; magic byte sniffing bridges the gap.
    var forcedFormat = d.format || null; // 'ply' | 'xyz' | 'las' | 'laz' | null
    var path = fetchUrl.split('?')[0].toLowerCase();

    var isLas = forcedFormat === 'las' || forcedFormat === 'laz' ||
                (!forcedFormat && (path.endsWith('.las') || path.endsWith('.laz') ||
                  urlHash === '.las' || urlHash === '.laz'));

    var isXyz = forcedFormat === 'xyz' ||
                (!forcedFormat && !isLas && (path.endsWith('.xyz') || path.endsWith('.csv') || path.endsWith('.txt')));

    // If extension is unrecognised and no format override, sniff the first
    // bytes of the response body to distinguish LAS ('LASF'), PLY ('ply'), and XYZ.
    // response.clone() lets us peek without consuming the stream the parsers need.
    if (!isXyz && !path.endsWith('.ply') && forcedFormat !== 'ply' && !isLas) {
      var peekReader = response.clone().body.getReader();
      var peekChunk  = await peekReader.read();
      await peekReader.cancel();
      var magic = peekChunk.value ? peekChunk.value : new Uint8Array(0);
      // LAS/LAZ magic: 'LASF' = [76, 65, 83, 70]
      if (magic.length >= 4 && magic[0] === 76 && magic[1] === 65 && magic[2] === 83 && magic[3] === 70) {
        isLas = true;
      } else if (magic.length >= 3 && magic[0] === 112 && magic[1] === 108 && magic[2] === 121) {
        // PLY magic: 'ply' — isXyz stays false; PLY streaming path handles it below
      } else {
        // Unrecognised magic — treat as XYZ text
        isXyz = true;
      }
    }

    if (isXyz) {
      var text = await response.text();
      var result = parseXyz(text, chunkSize);
      self.postMessage({ type: 'HEADER', vertexCount: result.totalPoints, attributeKeys: result.attrKeys, format: 'xyz' });
      for (var i = 0; i < result.chunks.length; i++) {
        var c = result.chunks[i];
        self.postMessage({ type: 'CHUNK', xyz: c.xyz, attributes: c.attributes, count: c.count, progress: c.progress }, c.transfers);
        // Yield between chunks so main thread renders progressively
        await new Promise(function(r) { setTimeout(r, 0); });
      }
      self.postMessage({ type: 'DONE', totalParsed: result.totalPoints });
      return;
    }

    if (isLas) {
      var lasReader  = response.body.getReader();
      var lasCarry   = new Uint8Array(0);
      var lasHdr     = null;
      var lasTotal   = 0;
      var lasParsed  = 0;

      while (true) {
        var lasRead = await lasReader.read();
        if (lasRead.value) lasCarry = concatBytes(lasCarry, lasRead.value);

        if (!lasHdr) {
          if (lasCarry.length < 100 && !lasRead.done) continue;
          if (lasCarry.length >= 100) {
            var odView  = new DataView(lasCarry.buffer, lasCarry.byteOffset, lasCarry.byteLength);
            var needLen = Math.max(375, odView.getUint32(96, true));
            if (lasCarry.length < needLen && !lasRead.done) continue;
          }

          lasHdr = parseLasHeader(lasCarry);
          if (!lasHdr) throw new Error('Not a valid LAS file — LASF signature not found in first 4 bytes.');
          if (lasHdr.isLaz) throw new Error(
            'LAZ (compressed) files require laz-perf. ' +
            'Import from "pointflow/laz" and pass loaderFactory={createLazLoader} to your component.'
          );

          lasTotal = lasHdr.pointCount;
          self.postMessage({
            type: 'HEADER',
            vertexCount: lasTotal,
            attributeKeys: lasHdr.attributeKeys,
            format: 'las/' + lasHdr.pointFormat,
            coordinateOffset: [lasHdr.centroidX, lasHdr.centroidY, lasHdr.centroidZ]
          });

          lasCarry = lasCarry.length > lasHdr.offsetToData
            ? lasCarry.slice(lasHdr.offsetToData)
            : new Uint8Array(0);
        }

        var recLen       = lasHdr.pointRecLen;
        var completeRecs = Math.min(Math.floor(lasCarry.length / recLen), lasTotal - lasParsed);

        if (completeRecs > 0) {
          var usedBytes = completeRecs * recLen;
          var lasSlice  = lasCarry.buffer.slice(lasCarry.byteOffset, lasCarry.byteOffset + usedBytes);
          lasCarry      = lasCarry.slice(usedBytes);

          var sliceHdr = {
            offsetToData: 0, pointFormat: lasHdr.pointFormat, pointRecLen: recLen,
            scaleX: lasHdr.scaleX, scaleY: lasHdr.scaleY, scaleZ: lasHdr.scaleZ,
            offsetX: lasHdr.offsetX, offsetY: lasHdr.offsetY, offsetZ: lasHdr.offsetZ,
            centroidX: lasHdr.centroidX, centroidY: lasHdr.centroidY, centroidZ: lasHdr.centroidZ,
            attributeKeys: lasHdr.attributeKeys
          };

          var sliceIdx = 0, rem = completeRecs;
          while (rem > 0) {
            var lasCount = Math.min(chunkSize, rem);
            var lasChunk = emitLasChunk(lasSlice, sliceHdr, sliceIdx, lasCount);
            lasParsed += lasCount;
            sliceIdx  += lasCount;
            rem       -= lasCount;
            var lasProgress = lasTotal > 0 ? lasParsed / lasTotal : 1;
            self.postMessage(
              { type: 'CHUNK', xyz: lasChunk.xyz, attributes: lasChunk.attributes, count: lasCount, progress: lasProgress },
              lasChunk.transfers
            );
            await new Promise(function(r) { setTimeout(r, 0); });
          }
        }

        if (lasRead.done || lasParsed >= lasTotal) break;
      }

      self.postMessage({ type: 'DONE', totalParsed: lasParsed });
      return;
    }

    // PLY: stream body, parse header from first bytes, then stream vertex data
    var reader = response.body.getReader();
    var carry = new Uint8Array(0);
    var header = null;
    var parsedTotal = 0;

    while (true) {
      var read = await reader.read();
      var done = read.done, value = read.value;

      if (header === null) {
        // Accumulate until we can parse the header
        carry = value ? concatBytes(carry, value) : carry;
        header = parsePlyHeader(carry);
        if (header === null) {
          if (done) throw new Error('Could not parse PLY header (file too short or malformed)');
          continue; // need more data
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
          // For ASCII: buffer the full text after the header and parse line-by-line
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

        // Binary: remaining bytes after header go into vertexBuffer
        carry = carry.slice(header.headerByteLen);
      } else {
        if (value && parsedTotal < header.vertexCount) carry = concatBytes(carry, value);
      }

      if (parsedTotal >= header.vertexCount) {
        if (done) break;
        continue;
      }

      // Binary: parse as many complete vertices as we have buffered
      var stride = header.stride;
      var completeVertices = Math.floor(carry.length / stride);
      var vertsRemaining = header.vertexCount - parsedTotal;
      if (vertsRemaining < 0) vertsRemaining = 0;
      completeVertices = Math.min(completeVertices, vertsRemaining);
      if (completeVertices > 0) {
        var usedBytes = completeVertices * stride;
        // Grab a stable ArrayBuffer slice to read from (carry may be reallocated)
        var slice = carry.buffer.slice(carry.byteOffset, carry.byteOffset + usedBytes);
        carry = carry.slice(usedBytes); // keep remainder

        // Emit in chunkSize sub-batches
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

/** Creates the loader worker from an inline Blob (no separate worker file needed). */
export function createLoaderWorker(): Worker {
  const blob = new Blob([LOADER_WORKER_SCRIPT], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}

/** Shape emitted per attribute in each CHUNK message. */
export interface LoaderDenseAttr {
  key: string;
  values: Float32Array;
}

/** Messages emitted by the loader worker. */
export type LoaderWorkerMessage =
  | {
      type: "HEADER";
      vertexCount: number;
      attributeKeys: string[];
      format: string;
      /**
       * For LAS files: [cx, cy, cz] centroid subtracted from all coordinates.
       * Consumers can add this back to recover world (e.g. UTM) coordinates.
       */
      coordinateOffset?: [number, number, number];
    }
  | { type: "CHUNK"; xyz: Float32Array; attributes: LoaderDenseAttr[]; count: number; progress: number }
  | { type: "DONE"; totalParsed: number }
  | { type: "ERROR"; message: string };
