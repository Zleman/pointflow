/**
 * Creates an ingest Worker from a self-contained Blob URL.
 *
 * Worker performs AoS-to-SoA packing off the main thread.
 * Previously the worker was an echo: main thread ran packChunk (expensive),
 * transferred typed arrays to worker, worker bounced them back unchanged.
 * Now main thread sends raw point objects (structured clone); worker packs them
 * and returns transferable typed arrays plus per-attribute range hints.
 *
 * Main-thread cost per chunk: structured-clone serialization (O(n) fast path
 * in V8, async, does not block the render loop).
 * Worker cost per chunk: AoS-to-SoA conversion + range computation (O(n × attrs)).
 *
 * Using a Blob avoids the need for a bundler-specific worker URL pattern
 * (e.g. Vite's `new Worker(new URL(..., import.meta.url))`), which is not
 * available in plain-tsc library builds. The worker code is inlined as a
 * string so there are no module-import dependencies inside the worker.
 */
const INGEST_WORKER_SCRIPT = `
// Frustum visibility test: returns true if (x,y,z) is inside all 6 frustum planes.
// planes is a Float32Array of length 24: [nx,ny,nz,d] per plane.
// Plane equation: nx*x + ny*y + nz*z + d >= 0 means inside.
function pointInFrustum(x, y, z, planes) {
  for (var i = 0; i < 6; i++) {
    var i4 = i * 4;
    if (planes[i4]*x + planes[i4+1]*y + planes[i4+2]*z + planes[i4+3] < 0) return false;
  }
  return true;
}

self.onmessage = function(e) {
  var d = e.data;
  if (d.type !== "INGEST" || typeof d.requestId !== "number") return;

  var allPoints = d.points;
  var frustumPlanes = d.frustum ? d.frustum.planes : null;

  // If frustum culling is requested, filter to visible points only
  var points;
  var preCulled = false;
  if (frustumPlanes !== null) {
    points = [];
    for (var fi = 0; fi < allPoints.length; fi++) {
      var fp = allPoints[fi];
      if (pointInFrustum(fp.x, fp.y, fp.z, frustumPlanes)) {
        points.push(fp);
      }
    }
    preCulled = true;
  } else {
    points = allPoints;
  }

  var count = points.length;
  if (count === 0) {
    self.postMessage({
      type: "PREPROCESSED",
      requestId: d.requestId,
      xyz: new Float32Array(0),
      attributes: undefined,
      count: 0,
      rangeHints: {},
      preCulled: preCulled
    });
    return;
  }

  var attrKeys = [];
  var seenKeys = {};
  for (var i = 0; i < count; i++) {
    var attrs = points[i].attributes;
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var k = 0; k < keys.length; k++) {
        if (!seenKeys[keys[k]]) {
          seenKeys[keys[k]] = true;
          attrKeys.push(keys[k]);
        }
      }
    }
  }

  var xyz = new Float32Array(count * 3);
  var attrValues = {};
  var attrPresence = {};
  for (var a = 0; a < attrKeys.length; a++) {
    attrValues[attrKeys[a]] = new Float32Array(count);
    attrPresence[attrKeys[a]] = new Uint8Array(count);
  }

  var rangeMin = {};
  var rangeMax = {};
  for (var a = 0; a < attrKeys.length; a++) {
    rangeMin[attrKeys[a]] = Infinity;
    rangeMax[attrKeys[a]] = -Infinity;
  }

  for (var i = 0; i < count; i++) {
    var p = points[i];
    var i3 = i * 3;
    xyz[i3]     = p.x;
    xyz[i3 + 1] = p.y;
    xyz[i3 + 2] = p.z;
    if (p.attributes) {
      for (var a = 0; a < attrKeys.length; a++) {
        var key = attrKeys[a];
        if (Object.prototype.hasOwnProperty.call(p.attributes, key)) {
          var v = p.attributes[key];
          attrValues[key][i] = v;
          attrPresence[key][i] = 1;
          if (v < rangeMin[key]) rangeMin[key] = v;
          if (v > rangeMax[key]) rangeMax[key] = v;
        }
      }
    }
  }

  var attributes = attrKeys.length > 0 ? [] : undefined;
  var transferables = [xyz.buffer];
  for (var a = 0; a < attrKeys.length; a++) {
    var key = attrKeys[a];
    attributes.push({ key: key, values: attrValues[key], present: attrPresence[key] });
    transferables.push(attrValues[key].buffer);
    transferables.push(attrPresence[key].buffer);
  }

  var rangeHints = {};
  for (var a = 0; a < attrKeys.length; a++) {
    var key = attrKeys[a];
    if (rangeMin[key] <= rangeMax[key]) {
      rangeHints[key] = { min: rangeMin[key], max: rangeMax[key] };
    }
  }

  self.postMessage({
    type: "PREPROCESSED",
    requestId: d.requestId,
    xyz: xyz,
    attributes: attributes,
    count: count,
    rangeHints: rangeHints,
    preCulled: preCulled
  }, transferables);
};
`;

export function createIngestWorker(): Worker {
  const blob = new Blob([INGEST_WORKER_SCRIPT], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}
