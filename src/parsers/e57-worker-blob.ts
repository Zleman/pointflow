/**
 * E57 loader worker (ASTM E2807).
 * Handles E57 files from professional scanners (Leica, FARO, Trimble, Matterport).
 *
 * Import from "pointflow/e57" rather than this file directly:
 *   import { createE57Loader } from "pointflow/e57";
 *
 * E57 requires full-file random access — the binary data sections are referenced
 * by physical byte offsets in the XML header, so streaming is not possible.
 * Response is buffered with response.arrayBuffer() before any parsing begins.
 *
 * Message protocol: identical to loader-worker-blob.ts (PARSE → HEADER / CHUNK / DONE / ERROR).
 */

const E57_WORKER_SCRIPT = /* javascript */ `
'use strict';


function readBitPackField(stream, bitOffset, bitWidth) {
  var value = 0;
  for (var i = 0; i < bitWidth; i++) {
    var bp = bitOffset + i;
    value |= ((stream[bp >>> 3] >>> (bp & 7)) & 1) << i;
  }
  return value >>> 0;
}

function parseE57FileHeader(bytes) {
  if (bytes.length < 48) throw new Error('E57: file too short');
  var sig = '';
  for (var i = 0; i < 8; i++) sig += String.fromCharCode(bytes[i]);
  if (sig !== 'ASTM-E57') throw new Error('E57: invalid signature');
  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function readHeaderAt(fileLenOff, xmlOffOff, xmlLenOff, pageSizeOff) {
    return {
      filePhysicalLength: Number(view.getBigUint64(fileLenOff, true)),
      xmlPhysicalOffset:  Number(view.getBigUint64(xmlOffOff, true)),
      xmlLogicalLength:   Number(view.getBigUint64(xmlLenOff, true)),
      pageSize:           Number(view.getBigUint64(pageSizeOff, true))
    };
  }

  function isPlausible(h) {
    if (!isFinite(h.pageSize) || h.pageSize <= 8 || h.pageSize > (1 << 20)) return false;
    if ((h.pageSize & (h.pageSize - 1)) !== 0) return false;
    if (!isFinite(h.xmlPhysicalOffset) || h.xmlPhysicalOffset < 48) return false;
    if (!isFinite(h.xmlLogicalLength) || h.xmlLogicalLength <= 0 || h.xmlLogicalLength > bytes.length) return false;
    if (h.xmlPhysicalOffset >= bytes.length) return false;
    if (!isFinite(h.filePhysicalLength) || h.filePhysicalLength < 48) return false;
    return true;
  }

  // ASTM E57 header uses uint32 major/minor at bytes 8 and 12, so these
  // offsets are correct for current files.
  var primary = readHeaderAt(16, 24, 32, 40);
  if (isPlausible(primary)) {
    return {
      xmlPhysicalOffset: primary.xmlPhysicalOffset,
      xmlLogicalLength:  primary.xmlLogicalLength,
      pageSize:          primary.pageSize
    };
  }

  // Compatibility fallback for malformed/legacy producer variants.
  var fallback = readHeaderAt(12, 20, 28, 36);
  if (isPlausible(fallback)) {
    return {
      xmlPhysicalOffset: fallback.xmlPhysicalOffset,
      xmlLogicalLength:  fallback.xmlLogicalLength,
      pageSize:          fallback.pageSize
    };
  }

  throw new Error('E57: invalid header fields (page size / XML offsets out of range)');
}

function stripE57Crc(bytes, pageSize) {
  // Each page's last 4 bytes are CRC32 — strip them to get logical data
  var payload = pageSize - 4;
  var numPages = Math.ceil(bytes.length / pageSize);
  var logical = new Uint8Array(numPages * payload);
  for (var p = 0; p < numPages; p++) {
    var src = p * pageSize;
    var len = Math.min(payload, bytes.length - src);
    if (len > 0) logical.set(bytes.subarray(src, src + len), p * payload);
  }
  return logical;
}

function physToLogical(physPos, pageSize) {
  var payload = pageSize - 4;
  var page = Math.floor(physPos / pageSize);
  var intra = physPos - page * pageSize;
  return page * payload + Math.min(intra, payload - 1);
}

function e57Attr(text, name) {
  var marker = name + '="';
  var idx = text.indexOf(marker);
  if (idx === -1) return null;
  var start = idx + marker.length;
  var end = text.indexOf('"', start);
  return end === -1 ? null : text.slice(start, end);
}

function parseE57Scans(xmlStr, pageSize) {
  var scans = [];
  var pos = 0;
  while (true) {
    var vcStart = xmlStr.indexOf('<vectorChild', pos);
    if (vcStart === -1) break;
    var vcClose = xmlStr.indexOf('</vectorChild>', vcStart);
    if (vcClose === -1) break;
    var vcBlock = xmlStr.slice(vcStart, vcClose + 14);
    pos = vcClose + 14;

    var pStart = vcBlock.indexOf('<points');
    if (pStart === -1) continue;
    var pEnd = vcBlock.indexOf('>', pStart);
    if (pEnd === -1) continue;
    var pAttrs = vcBlock.slice(pStart + 7, pEnd);
    var recordCount = parseInt(e57Attr(pAttrs, 'recordCount') || '0', 10);
    if (recordCount <= 0) continue;
    var logicalOffset = physToLogical(parseFloat(e57Attr(pAttrs, 'fileOffset') || '0') + 32, pageSize);

    var prStart = vcBlock.indexOf('<prototype');
    if (prStart === -1) continue;
    var prTagEnd = vcBlock.indexOf('>', prStart);
    if (prTagEnd === -1) continue;
    var prClose = vcBlock.indexOf('</prototype>', prTagEnd);
    if (prClose === -1) continue;
    var protoStr = vcBlock.slice(prTagEnd + 1, prClose);

    var fields = [], xIdx = -1, yIdx = -1, zIdx = -1, attrFieldIdxs = [];
    var fpos = 0;
    while (true) {
      var fStart = protoStr.indexOf('<', fpos);
      if (fStart === -1) break;
      var fEnd = protoStr.indexOf('>', fStart);
      if (fEnd === -1) break;
      var fTag = protoStr.slice(fStart + 1, fEnd);
      fpos = fEnd + 1;
      if (fTag[0] === '/' || fTag[0] === '?') continue;
      var sp = fTag.indexOf(' '), sl = fTag.indexOf('/');
      var sep = sp === -1 ? sl : sl === -1 ? sp : Math.min(sp, sl);
      var fname = sep === -1 ? fTag : fTag.slice(0, sep);
      var colon = fname.indexOf(':');
      if (colon !== -1) fname = fname.slice(colon + 1);
      var fAttrs = sep === -1 ? '' : fTag.slice(sep);
      var ftype = e57Attr(fAttrs, 'type') || 'Float';
      var bitWidth, minimum = 0, fscale = 1, foff = 0, divisor = 1;
      if (ftype === 'Float') {
        bitWidth = (e57Attr(fAttrs, 'precision') || 'double') === 'double' ? 64 : 32;
      } else {
        minimum = parseFloat(e57Attr(fAttrs, 'minimum') || '0');
        var maximum = parseFloat(e57Attr(fAttrs, 'maximum') || '0');
        var range = maximum - minimum;
        bitWidth = range <= 0 ? 0 : Math.max(1, Math.ceil(Math.log2(range + 1)));
        fscale = parseFloat(e57Attr(fAttrs, 'scale') || '1');
        foff   = parseFloat(e57Attr(fAttrs, 'offset') || '0');
      }
      var emitKey = null, isX = false, isY = false, isZ = false;
      if      (fname === 'cartesianX')  { isX = true; }
      else if (fname === 'cartesianY')  { isY = true; }
      else if (fname === 'cartesianZ')  { isZ = true; }
      else if (fname === 'intensity')   { emitKey = 'intensity'; }
      else if (fname === 'colorRed')    { emitKey = 'red';        divisor = 255; }
      else if (fname === 'colorGreen')  { emitKey = 'green';      divisor = 255; }
      else if (fname === 'colorBlue')   { emitKey = 'blue';       divisor = 255; }
      else if (fname === 'rowIndex')    { emitKey = 'return_num'; }
      var fidx = fields.length;
      fields.push({ type: ftype, bitWidth: bitWidth, minimum: minimum, scale: fscale, offset: foff, divisor: divisor, emitKey: emitKey, isX: isX, isY: isY, isZ: isZ });
      if      (isX)              xIdx = fidx;
      else if (isY)              yIdx = fidx;
      else if (isZ)              zIdx = fidx;
      else if (emitKey !== null) attrFieldIdxs.push(fidx);
    }
    scans.push({ pointCount: recordCount, logicalOffset: logicalOffset, fields: fields, xIdx: xIdx, yIdx: yIdx, zIdx: zIdx, attrFieldIdxs: attrFieldIdxs });
  }
  return scans;
}

function decodeE57Packets(logicalBytes, scan, xArr, yArr, zArr, attrArrs, attrMap) {
  var lView = new DataView(logicalBytes.buffer, logicalBytes.byteOffset, logicalBytes.byteLength);
  var logOff = scan.logicalOffset;
  var pc = scan.pointCount;
  var recIdx = 0;
  while (recIdx < pc) {
    if (logOff + 6 > logicalBytes.length) break;
    var pktType = logicalBytes[logOff];
    var byteCount = lView.getUint16(logOff + 2, true);
    if (byteCount === 0) break;
    if (pktType !== 1) { logOff += (byteCount + 3) & ~3; continue; }
    var bsCount = lView.getUint16(logOff + 4, true);
    if (!bsCount || !scan.fields.length) { logOff += (byteCount + 3) & ~3; continue; }
    if (logOff + 6 + bsCount * 2 > logicalBytes.length) break;
    var bsLengths = [];
    for (var bli = 0; bli < bsCount; bli++) bsLengths.push(lView.getUint16(logOff + 6 + bli * 2, true));
    var bsStarts = [logOff + 6 + bsCount * 2];
    for (var bsi = 0; bsi < bsCount - 1; bsi++) bsStarts.push(bsStarts[bsi] + bsLengths[bsi]);
    var f0 = scan.fields[0];
    var rCount = f0.bitWidth > 0 ? Math.min(Math.floor(bsLengths[0] * 8 / f0.bitWidth), pc - recIdx) : pc - recIdx;
    if (rCount <= 0) { logOff += (byteCount + 3) & ~3; continue; }
    for (var ri = 0; ri < rCount; ri++) {
      for (var fi = 0; fi < scan.fields.length && fi < bsCount; fi++) {
        var f = scan.fields[fi];
        var val;
        if (f.type === 'Float') {
          var bOff = bsStarts[fi] + ri * (f.bitWidth >>> 3);
          val = f.bitWidth === 64 ? lView.getFloat64(bOff, true) : lView.getFloat32(bOff, true);
        } else if (f.bitWidth === 0) {
          val = f.minimum;
        } else {
          val = readBitPackField(logicalBytes, bsStarts[fi] * 8 + ri * f.bitWidth, f.bitWidth);
          val = (val + f.minimum) * f.scale + f.offset;
        }
        val = val / f.divisor;
        if      (f.isX) xArr[recIdx + ri] = val;
        else if (f.isY) yArr[recIdx + ri] = val;
        else if (f.isZ) zArr[recIdx + ri] = val;
        else { var ai = attrMap[fi]; if (ai !== undefined) attrArrs[ai][recIdx + ri] = val; }
      }
    }
    logOff += (byteCount + 3) & ~3;
    recIdx += rCount;
  }
}

async function decodeE57Scan(logicalBytes, scan, chunkSize, emittedSoFar, totalPoints) {
  var pc = scan.pointCount;
  if (pc === 0) return emittedSoFar;
  var xArr = new Float32Array(pc), yArr = new Float32Array(pc), zArr = new Float32Array(pc);
  var attrArrs = [], attrMap = {};
  for (var ai = 0; ai < scan.attrFieldIdxs.length; ai++) {
    attrArrs.push(new Float32Array(pc));
    attrMap[scan.attrFieldIdxs[ai]] = ai;
  }
  decodeE57Packets(logicalBytes, scan, xArr, yArr, zArr, attrArrs, attrMap);
  for (var start = 0; start < pc; start += chunkSize) {
    var count = Math.min(chunkSize, pc - start);
    var xyz = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      xyz[i * 3] = xArr[start + i]; xyz[i * 3 + 1] = yArr[start + i]; xyz[i * 3 + 2] = zArr[start + i];
    }
    var attributes = [], transfers = [xyz.buffer];
    for (var ai2 = 0; ai2 < scan.attrFieldIdxs.length; ai2++) {
      var copy = new Float32Array(count);
      copy.set(new Float32Array(attrArrs[ai2].buffer, start * 4, count));
      attributes.push({ key: scan.fields[scan.attrFieldIdxs[ai2]].emitKey, values: copy });
      transfers.push(copy.buffer);
    }
    emittedSoFar += count;
    var prog = totalPoints > 0 ? Math.min(emittedSoFar / totalPoints, 1) : 1;
    self.postMessage({ type: 'CHUNK', xyz: xyz, attributes: attributes, count: count, progress: prog }, transfers);
    await new Promise(function(r) { setTimeout(r, 0); });
  }
  return emittedSoFar;
}


self.onmessage = async function(e) {
  var d = e.data;
  if (d.type !== 'PARSE') return;
  try {
    // E57 requires full-file buffering — binary data sections are referenced by physical offset in the XML
    var buf = await fetch(d.url).then(function(r) { return r.arrayBuffer(); });
    var bytes = new Uint8Array(buf);
    var chunkSize = d.chunkSize || 10000;

    var fileHdr = parseE57FileHeader(bytes);
    var logicalBytes = stripE57Crc(bytes, fileHdr.pageSize);
    var xmlStart = physToLogical(fileHdr.xmlPhysicalOffset, fileHdr.pageSize);
    var xmlStr = new TextDecoder().decode(logicalBytes.subarray(xmlStart, xmlStart + fileHdr.xmlLogicalLength));

    var scans = parseE57Scans(xmlStr, fileHdr.pageSize);
    if (!scans.length) throw new Error('E57: no point cloud scans found');

    var totalPoints = 0;
    for (var si = 0; si < scans.length; si++) totalPoints += scans[si].pointCount;

    var attrKeys = [], seen = {};
    for (var fi = 0; fi < scans[0].fields.length; fi++) {
      var ek = scans[0].fields[fi].emitKey;
      if (ek && !seen[ek]) { seen[ek] = true; attrKeys.push(ek); }
    }

    var hdrMsg = { type: 'HEADER', vertexCount: totalPoints, attributeKeys: attrKeys, format: 'e57' };
    if (scans.length > 1) hdrMsg.scanCount = scans.length;
    self.postMessage(hdrMsg);

    var emitted = 0;
    for (var si = 0; si < scans.length; si++) {
      emitted = await decodeE57Scan(logicalBytes, scans[si], chunkSize, emitted, totalPoints);
    }

    self.postMessage({ type: 'DONE', totalParsed: emitted });
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: (err && err.message) ? err.message : String(err) });
  }
};
`;

/** Creates the E57 loader worker from an inline Blob (no separate worker file needed). */
export function createE57Worker(): Worker {
  const blob = new Blob([E57_WORKER_SCRIPT], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}
