/**
 * Render worker: owns a SoA ring buffer and performs frustum-cull + LOD + color
 * mapping off the main thread, returning Transferable typed arrays to the main thread.
 *
 * Message protocol:
 *   INIT         { type, capacity }                          → allocate rings
 *   INGEST_SoA   { type, xyz, attr, count }                  → write into ring (Transferable)
 *   SCAN         { type, requestId, frustumPlanes, lodStride, colorMode }
 *                                                            → run scan, post SCAN_RESULT
 *   RESET        { type }                                    → clear ring pointers
 *
 * Response:
 *   SCAN_RESULT  { type, requestId, positions, colors, count } (Transferable)
 */
const RENDER_WORKER_SCRIPT = `
var xyzRing = null;
var attrRing = null;
var rgbRing  = null;  // 3 floats/point, pre-normalised to 0-1; only populated in RGB mode
var capacity = 0;
var writePtr = 0;
var totalCount = 0;
var globalAttrMin = Infinity;
var globalAttrMax = -Infinity;
// Set when the ring wraps and old extreme-value points may have been evicted.
// Triggers a full range recompute at the start of the next scan.
var globalAttrRangeDirty = false;
// True once at least one RGB chunk has been ingested. Guards the colorMode=2 path
// so that scans issued before any RGB data arrives produce white points, not black.
var hasRgbData = false;

// Ping-pong pool: pre-allocated scan output pairs, reused across scans.
// Each entry: { pos: Float32Array(cap*3), col: Float32Array(cap*3) }.
// Starts with 2 entries; entries leave when transferred to main thread and
// return via RETURN_BUFFERS messages. No per-scan allocation.
var freePairs = [];

function initRing(cap) {
  capacity = cap;
  xyzRing  = new Float32Array(cap * 3);
  attrRing = new Float32Array(cap);
  rgbRing  = new Float32Array(cap * 3);
  writePtr = 0;
  totalCount = 0;
  globalAttrMin = Infinity;
  globalAttrMax = -Infinity;
  globalAttrRangeDirty = false;
  hasRgbData = false;
  freePairs = [
    { pos: new Float32Array(cap * 3), col: new Float32Array(cap * 3) },
    { pos: new Float32Array(cap * 3), col: new Float32Array(cap * 3) },
  ];
}

// isRgb=true: attr is interleaved [r0,g0,b0, r1,g1,b1, ...] already normalised 0-1.
// isRgb=false: attr is a scalar Float32Array (one value per point).
function ingestSoA(xyz, attr, count, isRgb) {
  if (!xyzRing || count === 0) return;
  var capped = Math.min(count, capacity);
  var ptr = writePtr;
  var firstPart = Math.min(capped, capacity - ptr);
  var secondPart = capped - firstPart;

  xyzRing.set(xyz.subarray(0, firstPart * 3), ptr * 3);
  if (secondPart > 0) xyzRing.set(xyz.subarray(firstPart * 3, capped * 3), 0);

  if (attr) {
    if (isRgb) {
      // attr is interleaved RGB (3 floats/point)
      rgbRing.set(attr.subarray(0, firstPart * 3), ptr * 3);
      if (secondPart > 0) rgbRing.set(attr.subarray(firstPart * 3, capped * 3), 0);
      hasRgbData = true;
    } else {
      attrRing.set(attr.subarray(0, firstPart), ptr);
      if (secondPart > 0) attrRing.set(attr.subarray(firstPart, capped), 0);
      // track range for color mapping (optimistic: ignores evicted extrema)
      for (var i = 0; i < capped; i++) {
        var v = attr[i];
        if (v < globalAttrMin) globalAttrMin = v;
        if (v > globalAttrMax) globalAttrMax = v;
      }
    }
  }

  writePtr = (ptr + capped) % capacity;
  totalCount = Math.min(totalCount + capped, capacity);
  // If the ring wrapped, old extreme-value points may now be evicted.
  // Mark range dirty so the next scan recomputes attrMin/Max from the live ring.
  if (!isRgb && attr && secondPart > 0) globalAttrRangeDirty = true;
}

function pointInFrustum(x, y, z, planes) {
  // Fail open (include point) if the plane buffer is missing or undersized.
  if (!planes || planes.length < 24) return true;
  for (var i = 0; i < 6; i++) {
    var i4 = i * 4;
    if (planes[i4]*x + planes[i4+1]*y + planes[i4+2]*z + planes[i4+3] < 0) return false;
  }
  return true;
}

function scan(requestId, frustumPlanes, lodStride, colorMode) {
  if (!xyzRing || totalCount === 0 || freePairs.length === 0) {
    // No points or no free pair (shouldn't happen with bridge guard).
    self.postMessage({ type: "SCAN_RESULT", requestId: requestId,
      positions: new Float32Array(0), colors: new Float32Array(0), count: 0 });
    return;
  }
  var n = totalCount;
  // Pop a pre-allocated pair — zero GC.
  var pair = freePairs.pop();
  var outPos = pair.pos;
  var outCol = pair.col;
  var written = 0;

  // Recompute range from live ring when it may have been evicted by a wrap.
  if (globalAttrRangeDirty && colorMode !== 2) {
    globalAttrMin = Infinity;
    globalAttrMax = -Infinity;
    for (var ri = 0; ri < n; ri++) {
      var rv = attrRing[ri];
      if (rv < globalAttrMin) globalAttrMin = rv;
      if (rv > globalAttrMax) globalAttrMax = rv;
    }
    globalAttrRangeDirty = false;
  }

  var attrMin = globalAttrMin;
  var attrMax = globalAttrMax;
  var hasAttr = attrMax > attrMin;
  // Hoist division: replace per-point (attrMax - attrMin) division with a multiply.
  var attrInvRange = hasAttr ? 1 / (attrMax - attrMin) : 1;

  for (var i = 0; i < n; i += lodStride) {
    var i3 = i * 3;
    var x = xyzRing[i3], y = xyzRing[i3 + 1], z = xyzRing[i3 + 2];
    if (frustumPlanes && !pointInFrustum(x, y, z, frustumPlanes)) continue;
    var w3 = written * 3;
    outPos[w3] = x; outPos[w3 + 1] = y; outPos[w3 + 2] = z;
    if (colorMode === 2 && hasRgbData) {
      // RGB mode: read pre-normalised values stored in rgbRing.
      // hasRgbData guard: if no RGB chunk has been ingested yet, fall through to white.
      outCol[w3]     = rgbRing[i3];
      outCol[w3 + 1] = rgbRing[i3 + 1];
      outCol[w3 + 2] = rgbRing[i3 + 2];
    } else if (colorMode === 0 && hasAttr) {
      var t = Math.min(1, Math.max(0, (attrRing[i] - attrMin) * attrInvRange));
      var r, g2, b;
      if (t < 0.5) {
        var s = t * 2;
        r  = 0.05 + 0.89 * s;
        g2 = 0.03 + 0.20 * s;
        b  = 0.53 - 0.03 * s;
      } else {
        var s = (t - 0.5) * 2;
        r  = 0.94 + 0.05 * s;
        g2 = 0.23 + 0.68 * s;
        b  = 0.50 - 0.35 * s;
      }
      outCol[w3]     = r;
      outCol[w3 + 1] = g2;
      outCol[w3 + 2] = b;
    } else {
      outCol[w3] = 1; outCol[w3 + 1] = 1; outCol[w3 + 2] = 1;
    }
    written++;
  }

  self.postMessage({
    type: "SCAN_RESULT",
    requestId: requestId,
    positions: outPos,
    colors: outCol,
    count: written
  }, [outPos.buffer, outCol.buffer]);
}

self.onmessage = function(e) {
  var d = e.data;
  if (d.type === "INIT") {
    initRing(d.capacity);
  } else if (d.type === "INGEST_SoA") {
    ingestSoA(d.xyz, d.attr, d.count, d.isRgb || false);
  } else if (d.type === "SCAN") {
    scan(d.requestId, d.frustumPlanes, d.lodStride || 1, d.colorMode || 0);
  } else if (d.type === "RETURN_BUFFERS") {
    // Main thread returns a previously transferred scan pair — put it back in the pool.
    freePairs.push({ pos: d.positions, col: d.colors });
  } else if (d.type === "RESET") {
    writePtr = 0;
    totalCount = 0;
    globalAttrMin = Infinity;
    globalAttrMax = -Infinity;
    globalAttrRangeDirty = false;
    hasRgbData = false;
  }
};
`;

export function createRenderWorker(): Worker {
  const blob = new Blob([RENDER_WORKER_SCRIPT], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}
