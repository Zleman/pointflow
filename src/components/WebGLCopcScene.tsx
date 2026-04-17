/**
 * WebGLCopcScene — CPU-LOD COPC renderer for the WebGL fallback path.
 *
 * Manages the atlas entirely on the CPU (Float32Array / Uint32Array mirrors)
 * and renders via WebGL2 drawArrays.  Uses the same screen-space LOD metric
 * and AtlasManager free-list / LRU as the WebGPU path, so tile management
 * code is shared.  Only the traversal (CPU vs GPU) and draw dispatch differ.
 *
 * Target: 60+ FPS on Autzen Stadium (up from 10–20 with the old ring buffer).
 */

import React, { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { Matrix4, PerspectiveCamera } from "three";
import { computeCopcLodCut } from "../copc/copc-cpu-lod-cut";
import { AtlasManager, DEFAULT_ATLAS_TIERS } from "../copc/copc-atlas-manager";
import type { AtlasTierConfig, AllocatedSlot } from "../copc/copc-atlas-manager";
import type { TileData } from "../copc/copc-source";
import type { CopcIndex } from "../copc/copc-types";
import type { StreamedPointCloudRenderMetrics } from "../core/types";
import type { AttributePackingMode } from "../core/types";
import { voxelKeyString } from "../copc/copc-types";
import type { CopcSceneRef } from "./WebGPUCopcScene";
import { mkProgram } from "./webgl-copc/gl-program";
import { buildNodeMap, type CpuNode } from "./webgl-copc/node-map";

// ── GL state ──────────────────────────────────────────────────────────────

interface GlState {
  gl:       WebGL2RenderingContext;
  prog:     WebGLProgram;
  vao:      WebGLVertexArrayObject;
  posVbo:   WebGLBuffer;
  colVbo:   WebGLBuffer;
  attrVbo:  WebGLBuffer;
  atlas:    AtlasManager;
  keyToId:  Map<string, number>;
  nodes:    CpuNode[];
  roots:    number[];
  /** CPU mirror buffers for atlas data. */
  cpuPos:   Float32Array;   // vec4 per point
  cpuColor: Uint32Array;    // packed RGBA per point
  cpuAttr:  Float32Array | Uint16Array;   // scalar per point
  attrPacking: AttributePackingMode;
  /** Slots that have been written since the last VBO upload. */
  dirty:    boolean;
  uLocs: {
    viewProj:     WebGLUniformLocation | null;
    cameraPos:    WebGLUniformLocation | null;
    attrMin:      WebGLUniformLocation | null;
    attrMax:      WebGLUniformLocation | null;
    colorMode:    WebGLUniformLocation | null;
    pointSize:    WebGLUniformLocation | null;
  };
}

// ── GLSL ─────────────────────────────────────────────────────────────────

const VS = /* glsl */`#version 300 es
precision highp float;
in  vec4  aPos;
in  uint  aColor;
in  float aAttr;
uniform mat4  uViewProj;
uniform vec3  uCameraPos;
uniform float uAttrMin;
uniform float uAttrMax;
uniform int   uColorMode;
uniform float uPointSize;
out vec4 vColor;

vec3 lasClass(uint c) {
  c = c & 31u;
  if(c== 0u) return vec3(.5,.5,.5);
  if(c== 1u) return vec3(.8,.8,.8);
  if(c== 2u) return vec3(.6,.4,.2);
  if(c== 3u) return vec3(.4,.7,.3);
  if(c== 4u) return vec3(.2,.6,.2);
  if(c== 5u) return vec3(.05,.5,.05);
  if(c== 6u) return vec3(.9,.1,.1);
  if(c== 7u) return vec3(0.,0.,0.);
  if(c== 8u) return vec3(1.,1.,1.);
  if(c== 9u) return vec3(.1,.4,.9);
  if(c==10u) return vec3(.6,.4,.2);
  if(c==11u) return vec3(.5,0.,.5);
  if(c==12u) return vec3(1.,0.,1.);
  if(c==17u) return vec3(.7,.7,.7);
  return vec3(1.,.8,0.);
}
void main() {
  gl_Position  = uViewProj * aPos;
  gl_PointSize = clamp(uPointSize / max(gl_Position.w, .001), 1., 32.);
  if(uColorMode==1) {
    float range = uAttrMax-uAttrMin;
    float t = range>.001?(aAttr-uAttrMin)/range:.5;
    float g = mix(.75,.95,clamp(t,0.,1.));
    vColor = vec4(g,g,g,1.);
  } else if(uColorMode==2) {
    vColor = vec4(float(aColor&255u)/255.,float((aColor>>8u)&255u)/255.,float((aColor>>16u)&255u)/255.,1.);
  } else if(uColorMode==3) {
    vColor = vec4(lasClass(aColor&255u),1.);
  } else {
    vColor = vec4(.87843137,.87843137,.87843137,1.);
  }
}`;

const FS = /* glsl */`#version 300 es
precision mediump float;
in  vec4 vColor;
out vec4 fragColor;
void main() {
  vec2 uv = gl_PointCoord*2.-1.;
  if(dot(uv,uv)>1.) discard;
  float alpha = 1.-smoothstep(.8,1.,length(uv));
  fragColor = vec4(vColor.rgb, vColor.a*alpha);
}`;

// ── Props ─────────────────────────────────────────────────────────────────

export interface WebGLCopcSceneProps {
  index: CopcIndex | null;
  maxDepth?: number;
  colorBy?: string;
  frustumCulling?: boolean;
  basePointSize?: number;
  lodThreshold?: number;
  attributePacking?: AttributePackingMode;
  atlasTiers?: AtlasTierConfig[];
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  onSceneReady?: (ref: CopcSceneRef) => void;
  onRendererResolved?: (backend: "webgl") => void;
}

const _vpMatrix = new Matrix4();
const MAX_NODES = 16_384;

// ── Component ─────────────────────────────────────────────────────────────

export function WebGLCopcScene(props: WebGLCopcSceneProps) {
  const {
    index,
    maxDepth       = 12,
    colorBy,
    frustumCulling = true,
    basePointSize  = 2.0,
    lodThreshold   = 0.002,
    attributePacking = "float32",
    atlasTiers,
    renderMetricsRef,
    onSceneReady,
    onRendererResolved,
  } = props;

  const { gl: r3fRenderer, camera, size } = useThree();
  const stateRef = useRef<GlState | null>(null);
  const indexRef = useRef<CopcIndex | null>(null);
  indexRef.current = index;
  const renderPropsRef = useRef({ colorBy });
  renderPropsRef.current = { colorBy };

  // ── Init ───────────────────────────────────────────────────────────

  useEffect(() => {
    // Extract the raw WebGL2 context from R3F's Three.js renderer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const glCtx: WebGL2RenderingContext | null = (r3fRenderer as any).getContext?.()
      ?? (r3fRenderer as any).domElement?.getContext("webgl2")
      ?? null;

    if (!glCtx) {
      console.error("[WebGLCopcScene] WebGL2 context unavailable");
      return;
    }

    onRendererResolved?.("webgl");

    const tiers  = atlasTiers ?? DEFAULT_ATLAS_TIERS;
    const atlas  = new AtlasManager(tiers);
    const cpuPos  = new Float32Array(atlas.totalPoints * 4);
    const cpuColor = new Uint32Array(atlas.totalPoints);
    const cpuAttr  = attributePacking === "unorm16"
      ? new Uint16Array(atlas.totalPoints)
      : new Float32Array(atlas.totalPoints);

    let prog: WebGLProgram;
    try { prog = mkProgram(glCtx, VS, FS); }
    catch (e) { console.error("[WebGLCopcScene] Shader error:", e); return; }

    const vao    = glCtx.createVertexArray()!;
    const posVbo = glCtx.createBuffer()!;
    const colVbo = glCtx.createBuffer()!;
    const attrVbo = glCtx.createBuffer()!;

    // Allocate VBOs.
    glCtx.bindVertexArray(vao);

    glCtx.bindBuffer(glCtx.ARRAY_BUFFER, posVbo);
    glCtx.bufferData(glCtx.ARRAY_BUFFER, cpuPos.byteLength, glCtx.DYNAMIC_DRAW);
    const posLoc = glCtx.getAttribLocation(prog, "aPos");
    glCtx.enableVertexAttribArray(posLoc);
    glCtx.vertexAttribPointer(posLoc, 4, glCtx.FLOAT, false, 0, 0);

    glCtx.bindBuffer(glCtx.ARRAY_BUFFER, colVbo);
    glCtx.bufferData(glCtx.ARRAY_BUFFER, cpuColor.byteLength, glCtx.DYNAMIC_DRAW);
    const colLoc = glCtx.getAttribLocation(prog, "aColor");
    glCtx.enableVertexAttribArray(colLoc);
    glCtx.vertexAttribIPointer(colLoc, 1, glCtx.UNSIGNED_INT, 0, 0);

    glCtx.bindBuffer(glCtx.ARRAY_BUFFER, attrVbo);
    glCtx.bufferData(glCtx.ARRAY_BUFFER, cpuAttr.byteLength, glCtx.DYNAMIC_DRAW);
    const attrLoc = glCtx.getAttribLocation(prog, "aAttr");
    glCtx.enableVertexAttribArray(attrLoc);
    if (attributePacking === "unorm16") {
      glCtx.vertexAttribPointer(attrLoc, 1, glCtx.UNSIGNED_SHORT, true, 0, 0);
    } else {
      glCtx.vertexAttribPointer(attrLoc, 1, glCtx.FLOAT, false, 0, 0);
    }

    glCtx.bindVertexArray(null);

    const state: GlState = {
      gl: glCtx, prog, vao, posVbo, colVbo, attrVbo,
      atlas, keyToId: new Map(), nodes: [], roots: [],
      cpuPos, cpuColor, cpuAttr, attrPacking: attributePacking, dirty: false,
      uLocs: {
        viewProj:  glCtx.getUniformLocation(prog, "uViewProj"),
        cameraPos: glCtx.getUniformLocation(prog, "uCameraPos"),
        attrMin:   glCtx.getUniformLocation(prog, "uAttrMin"),
        attrMax:   glCtx.getUniformLocation(prog, "uAttrMax"),
        colorMode: glCtx.getUniformLocation(prog, "uColorMode"),
        pointSize: glCtx.getUniformLocation(prog, "uPointSize"),
      },
    };
    stateRef.current = state;

    // Build node map if index already available.
    if (indexRef.current) {
      buildNodeMap(indexRef.current, maxDepth, state.keyToId, state.nodes, state.roots, MAX_NODES);
    }

    // Expose tile upload API to parent.
    const sceneRef: CopcSceneRef = {
      uploadTile(keyStr, tile, inFlight) {
        const s = stateRef.current;
        if (!s) return false;
        const nodeId = s.keyToId.get(keyStr);
        if (nodeId === undefined) return false;

        // Try alloc; evict LRU if needed.
        // Guard in-flight nodes from eviction — same pattern as WebGPU path.
        const skipEviction = (evictId: number) => {
          const entry = s.nodes[evictId];
          return entry ? inFlight.has(voxelKeyString(entry.key)) : true;
        };
        let slot: AllocatedSlot | null = s.atlas.alloc(tile.count);
        if (!slot) {
          const ev = s.atlas.lruEvict(tile.count, skipEviction);
          if (!ev) return false;
          slot = ev.slot;
        }
        s.atlas.assignSlot(nodeId, slot);

        const { firstVertex, pointCapacity } = slot;
        const count  = Math.min(tile.count, pointCapacity);
        const currentColorBy = renderPropsRef.current.colorBy;
        const isRgb  = currentColorBy === "rgb";
        const isClassification = currentColorBy === "classification";
        const redCh  = isRgb ? tile.attributes.find(a => a.key === "red")   : null;
        const grnCh  = isRgb ? tile.attributes.find(a => a.key === "green") : null;
        const bluCh  = isRgb ? tile.attributes.find(a => a.key === "blue")  : null;
        const classCh = isClassification ? tile.attributes.find(a => a.key === "classification") : null;
        const attrCh = !isRgb && !isClassification
          ? (currentColorBy ? tile.attributes.find(a => a.key === currentColorBy) : tile.attributes[0])
          : null;

        for (let i = 0; i < count; i++) {
          const fv = firstVertex + i;
          s.cpuPos[fv * 4]     = tile.xyz[i * 3];
          s.cpuPos[fv * 4 + 1] = tile.xyz[i * 3 + 1];
          s.cpuPos[fv * 4 + 2] = tile.xyz[i * 3 + 2];
          s.cpuPos[fv * 4 + 3] = 1.0;
          if (isRgb) {
            const r = redCh ? Math.floor(redCh.values[i] * 255) & 0xFF : 0;
            const g = grnCh ? Math.floor(grnCh.values[i] * 255) & 0xFF : 0;
            const b = bluCh ? Math.floor(bluCh.values[i] * 255) & 0xFF : 0;
            s.cpuColor[fv] = (0xFF << 24) | (b << 16) | (g << 8) | r;
          } else if (isClassification) {
            const cls = classCh ? Math.floor(classCh.values[i]) & 0xFF : 0;
            s.cpuColor[fv] = (0xFF << 24) | cls;
          } else {
            s.cpuColor[fv] = 0xFFFFFFFF;
          }
          const attrValue = attrCh ? attrCh.values[i] : 0.0;
          if (s.attrPacking === "unorm16") {
            s.cpuAttr[fv] = Math.max(0, Math.min(65535, Math.round(attrValue * 65535)));
          } else {
            s.cpuAttr[fv] = attrValue;
          }
        }
        // Store the actual uploaded count so gl.drawArrays uses it, not the
        // index-declared count which could differ on a partial decode.
        s.nodes[nodeId].pointCount = count;
        s.dirty = true;
        return true;
      },
      releaseTile(keyStr) {
        const s = stateRef.current;
        if (!s) return;
        const nodeId = s.keyToId.get(keyStr);
        if (nodeId === undefined) return;
        s.atlas.releaseNodeSlot(nodeId);
      },
    };

    onSceneReady?.(sceneRef);

    return () => {
      glCtx.deleteProgram(prog);
      glCtx.deleteVertexArray(vao);
      glCtx.deleteBuffer(posVbo);
      glCtx.deleteBuffer(colVbo);
      glCtx.deleteBuffer(attrVbo);
      stateRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r3fRenderer]);

  // ── Re-build node map when index changes ──────────────────────────

  useEffect(() => {
    const s = stateRef.current;
    if (!s || !index) return;
    buildNodeMap(index, maxDepth, s.keyToId, s.nodes, s.roots, MAX_NODES);
  }, [index, maxDepth]);

  // ── Frame loop ─────────────────────────────────────────────────────

  useFrame((_, delta) => {
    const s = stateRef.current;
    const cam = camera as PerspectiveCamera;
    const idx = indexRef.current;
    let cameraDistance = 0;
    if (idx) {
      const [cx, cy, cz] = idx.info.center;
      const dx = cam.position.x - cx;
      const dy = cam.position.y - cy;
      const dz = cam.position.z - cz;
      cameraDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const frameTimeMs = delta * 1000;
    const fps = delta > 1e-6 ? Math.min(240, 1 / delta) : 60;
    const writeMetrics = (renderedPoints: number, effectiveLodLevel: number) => {
      if (!renderMetricsRef) return;
      renderMetricsRef.current = {
        renderedPoints,
        effectiveLodLevel,
        cameraDistance,
        frameTimeMs,
        fps,
      };
    };

    if (!s || s.nodes.length === 0) {
      writeMetrics(0, 0);
      return;
    }

    const { gl } = s;

    // Upload dirty CPU data.
    if (s.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, s.posVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.cpuPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.colVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(s.cpuColor.buffer));
      gl.bindBuffer(gl.ARRAY_BUFFER, s.attrVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.cpuAttr);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      s.dirty = false;
    }

    _vpMatrix.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    const fov = cam.projectionMatrix.elements[5];
    const vpFlat = Array.from(_vpMatrix.elements) as number[];

    const selected = computeCopcLodCut(s.nodes, s.roots, s.atlas, vpFlat, fov, lodThreshold, frustumCulling);
    if (selected.length === 0) {
      writeMetrics(0, 0);
      return;
    }

    gl.useProgram(s.prog);
    gl.uniformMatrix4fv(s.uLocs.viewProj,  false, _vpMatrix.elements);
    gl.uniform3f(s.uLocs.cameraPos, cam.position.x, cam.position.y, cam.position.z);
    gl.uniform1f(s.uLocs.attrMin, 0.0);
    gl.uniform1f(s.uLocs.attrMax, 1.0);
    gl.uniform1i(s.uLocs.colorMode,
      colorBy === "rgb" ? 2 : colorBy === "classification" ? 3 : colorBy ? 1 : 0);
    gl.uniform1f(s.uLocs.pointSize, basePointSize);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(s.vao);

    let renderedPoints = 0;
    let effectiveLodLevel = 0;

    for (const nodeId of selected) {
      const slotIdx = s.atlas.getSlot(nodeId);
      if (slotIdx === -1) continue;
      const node = s.nodes[nodeId];
      if (!node || node.pointCount === 0) continue;

      renderedPoints += node.pointCount;
      if (node.key.depth > effectiveLodLevel) effectiveLodLevel = node.key.depth;

      // Compute firstVertex from globalIndex.
      const tierIdx = s.atlas.tiers.findIndex((_, ti) =>
        slotIdx >= s.atlas.tierGlobalOffset[ti] &&
        slotIdx < s.atlas.tierGlobalOffset[ti] + s.atlas.tiers[ti].slotCount,
      );
      if (tierIdx === -1) continue;
      const slotInTier  = slotIdx - s.atlas.tierGlobalOffset[tierIdx];
      const firstVertex = s.atlas.tierVertexOffset[tierIdx]
        + slotInTier * s.atlas.tiers[tierIdx].pointsPerSlot;

      gl.drawArrays(gl.POINTS, firstVertex, node.pointCount);
    }

    writeMetrics(renderedPoints, effectiveLodLevel);

    gl.bindVertexArray(null);
  });

  return <group />;
}

