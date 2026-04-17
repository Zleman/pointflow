/**
 * WebGPUCopcScene — R3F inner component for GPU-resident COPC LOD rendering.
 *
 * Implements the C3-B-2 architecture from M15.8:
 *   - Per-frame command buffer with chained dispatchWorkgroupsIndirect
 *   - Each traversal wave is its own compute pass (implicit pipeline barrier)
 *   - Compaction pass produces sparse DrawIndirectArgs
 *   - Pack pass condenses them into a packed list + draw count
 *   - Single multiDrawIndirect (or N-call fallback if feature unavailable)
 *
 * Must be placed inside an R3F <Canvas> using the WebGPU renderer backend.
 * The parent CopcPointCloud provides:
 *   - The parsed CopcIndex (once loaded)
 *   - Decoded TileData via the CopcSceneRef.uploadTile() callback
 */

import React, { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Matrix4, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from "three";
import { getDeviceFromRenderer, getCanvasContextFromRenderer } from "../webgpu/device";
import {
  createCopcGpuPipeline, uploadNodeTable,
  allocSlotForTile, uploadTilePoints, setNodeAtlasSlot,
  setSlotDesc, clearSlotDesc,
  NO_SLOT, TRAVERSE_WORKGROUP_SIZE,
} from "../copc/copc-gpu-pipeline";
import type { CopcGpuPipeline, CopcGpuPipelineConfig } from "../copc/copc-gpu-pipeline";
import { extractFrustumPlanes } from "../copc/copc-frustum";
import { computeCopcLodCut } from "../copc/copc-cpu-lod-cut";
import type { TileData } from "../copc/copc-source";
import type { CopcIndex } from "../copc/copc-types";
import type { StreamedPointCloudRenderMetrics } from "../core/types";
import { voxelKeyString } from "../copc/copc-types";
import { maxAtlasPointsPerSlot } from "../copc/copc-atlas-manager";

import traverseWaveSource   from "../webgpu/copc-traverse-wave.wgsl?raw";
import compactSource        from "../webgpu/copc-compact-draw-args.wgsl?raw";
import packSource           from "../webgpu/copc-pack-draw-list.wgsl?raw";
import pointSpriteSource    from "../webgpu/copc-point-sprite.wgsl?raw";
import {
  recordAllocationFailure,
  recordMissingNode,
  sampleAttributeRange,
} from "./webgpu-copc/scene-ref-api";

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Ref exposed to CopcPointCloud so it can push tiles into the atlas.
 */
export interface CopcSceneRef {
  /**
   * Upload a decoded tile into an available atlas slot.
   * @param inFlight  VoxelKey strings currently being fetched — not eligible for LRU eviction.
   * @returns true on success; false if the tile is too large for any tier.
   */
  uploadTile(keyStr: string, tile: TileData, inFlight: ReadonlySet<string>): boolean;
  /** Release the atlas slot for the given node (tile evicted from CopcSource cache). */
  releaseTile(keyStr: string): void;
}

export interface WebGPUCopcSceneProps {
  index: CopcIndex | null;
  maxDepth?: number;
  colorBy?: string;
  frustumCulling?: boolean;
  basePointSize?: number;
  lodThreshold?: number;
  /** Minimum camera–orbit-target distance (scene units); must match OrbitControls minDistance. */
  minOrbitDistance?: number;
  pipelineConfig?: CopcGpuPipelineConfig;
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  orbitControlsRef?: React.RefObject<any>;
  onSceneReady?: (ref: CopcSceneRef) => void;
  onRendererResolved?: (backend: "webgpu") => void;
}

// ── Uniform buffer layouts ────────────────────────────────────────────────
// Traverse: must match FrameUniforms in copc-traverse-wave.wgsl (208 B used, 256 B binding).
// Render:   must match CopcRenderUniforms in copc-point-sprite.wgsl (separate buffer).
//
// Traverse (bytes):
//   0–63 viewProj, 64–159 planes, 160–175 cameraPos, 176 fov, 180 lod, 184–188 viewport,
//   192 waveIndex, 196–207 _pad0..2
//
// Render CopcRenderUniforms (bytes):
//   0–63 renderViewProj, 64 viewportW, 68 viewportH, 72 basePointSize, 76 attrMin, 80 attrMax, 84 colorMode

const TRAVERSE_UNIFORM_SIZE = 256;
const RENDER_UNIFORM_SIZE   = 256;
const WAVE_INDEX_BYTE_OFFSET = 192;

const _vpMatrix       = new Matrix4();
const _renderVpMatrix = new Matrix4();
const _camWorldRel    = new Matrix4();
const _viewRelInv     = new Matrix4();
const _scratch        = new ArrayBuffer(TRAVERSE_UNIFORM_SIZE);
const _f32scratch     = new Float32Array(_scratch);
const _u32scratch     = new Uint32Array(_scratch);
const _renderScratch  = new ArrayBuffer(RENDER_UNIFORM_SIZE);
const _rf32           = new Float32Array(_renderScratch);
const _ru32           = new Uint32Array(_renderScratch);

const uploadMetricsRef = {
  frameCount: 0,
  totalUploadAttempts: 0,
  totalUploadFailures: 0,
  tierFailures: [0, 0, 0],
  nodeIdMissingFailures: 0,
  allocOversizeFailures: 0,
  allocAtlasFullFailures: 0,
  lastLogFrame: 0,
};

// ── GPU state ─────────────────────────────────────────────────────────────

interface GpuState {
  device:        GPUDevice;
  canvasCtx:     GPUCanvasContext;
  pipeline:      CopcGpuPipeline;
  uniformBuffer: GPUBuffer;
  renderUniformBuffer: GPUBuffer;
  /** Pre-written staging buffer: u32[maxDepth] = [0, 1, 2, ...] for encoder.copyBufferToBuffer. */
  waveIdxStage:  GPUBuffer;
  /** The CopcIndex reference that was last uploaded — prevents double uploadNodeTable calls. */
  uploadedIndex: CopcIndex | null;

  traversePipeline: GPUComputePipeline;
  compactPipeline:  GPUComputePipeline;
  packPipeline:     GPUComputePipeline;
  renderPipeline:   GPURenderPipeline;
  /** True when the device supports "multi-draw-indirect" — enables single-call rendering. */
  supportsMultiDraw: boolean;

  /** Traversal bind group 0 variants for ping-pong (even: A→B, odd: B→A). */
  traverseBG0Even: GPUBindGroup;
  traverseBG0Odd:  GPUBindGroup;
  /** Traversal bind group 1 (frame-constant nodes / selected / counts / indirect). */
  traverseBG1: GPUBindGroup;

  compactBG0: GPUBindGroup;
  packBG0:    GPUBindGroup;

  /** Render bind group 0 (atlas buffers). */
  renderBG0: GPUBindGroup;
  /** Render bind group 1 (uniforms). */
  renderBG1: GPUBindGroup;
}

// ── Component ─────────────────────────────────────────────────────────────

export function WebGPUCopcScene(props: WebGPUCopcSceneProps) {
  const {
    index,
    maxDepth      = 12,
    colorBy,
    frustumCulling = true,
    basePointSize  = 2.0,
    lodThreshold   = 0.002,
    minOrbitDistance = 1e-3,
    pipelineConfig,
    renderMetricsRef,
    orbitControlsRef,
    onSceneReady,
    onRendererResolved,
  } = props;

  const gpuRef   = useRef<GpuState | null>(null);
  const indexRef = useRef<CopcIndex | null>(null);
  const frameCountRef = useRef(0);

  // Keep refs up to date without triggering effect re-runs.
  indexRef.current = index;

  // Mutable render props — read inside the RAF loop via ref to avoid stale closure.
  const renderPropsRef = useRef({ frustumCulling, lodThreshold, colorBy, basePointSize, maxDepth });
  renderPropsRef.current = { frustumCulling, lodThreshold, colorBy, basePointSize, maxDepth };

  const attrStatsRef = useRef({ min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, samples: 0 });
  useEffect(() => {
    attrStatsRef.current = { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, samples: 0 };
  }, [colorBy, index]);

  // Stable ref for callbacks — avoids stale closures inside the RAF loop.
  const onRendererResolvedRef = useRef(onRendererResolved);
  onRendererResolvedRef.current = onRendererResolved;

  // pipelineConfig ref — only read during lazy GPU init.
  const pipelineConfigRef = useRef(pipelineConfig);
  pipelineConfigRef.current = pipelineConfig;

  // ── Re-upload node table when index changes ────────────────────────────

  useEffect(() => {
    const g = gpuRef.current;
    if (!g || !index) return;
    // Guard against double-upload: lazy init already uploaded this index when the
    // GPU became ready while index was already loaded. uploadNodeTable rewrites the
    // full node buffer; atlas slots are preserved from AtlasManager when nodeIds match.
    if (g.uploadedIndex === index) return;
    uploadNodeTable(g.device, g.pipeline, index, maxDepth);
    g.uploadedIndex = index;
  }, [index, maxDepth]);

  // ── Expose tile upload API to parent ──────────────────────────────────

  const sceneRefStable = useRef<CopcSceneRef>({
    uploadTile(keyStr, tile, inFlight) {
      const g = gpuRef.current;
      if (!g || !indexRef.current) return false;
      const nodeId = g.pipeline.keyToId.get(keyStr);
      uploadMetricsRef.totalUploadAttempts++;

      const pointCount = tile.count;

      if (nodeId === undefined) {
        recordMissingNode(uploadMetricsRef);
        return false;
      }

      const maxPts = maxAtlasPointsPerSlot(g.pipeline.atlas.tiers);
      const slot = allocSlotForTile(g.device, g.pipeline, nodeId, tile.count, inFlight);
      if (!slot) {
        recordAllocationFailure(uploadMetricsRef, pointCount, maxPts, g.pipeline);
        return false;
      }

      const ctr = indexRef.current?.info.center;
      const origin = ctr ? ([ctr[0], ctr[1], ctr[2]] as const) : undefined;
      const currentColorBy = renderPropsRef.current.colorBy;
      sampleAttributeRange({
        colorBy: currentColorBy,
        tile,
        attrStats: attrStatsRef.current,
      });
      const written = uploadTilePoints(g.device, g.pipeline, slot, tile, currentColorBy, origin);
      setSlotDesc(g.device, g.pipeline, slot.globalIndex, slot.firstVertex, written);
      return true;
    },

    releaseTile(keyStr) {
      const g = gpuRef.current;
      if (!g || !indexRef.current) return;
      const nodeId = g.pipeline.keyToId.get(keyStr);
      if (nodeId === undefined) return;

      const slot = g.pipeline.atlas.releaseNodeSlot(nodeId);
      if (!slot) return;
      setNodeAtlasSlot(g.device, g.pipeline, nodeId, NO_SLOT);
      clearSlotDesc(g.device, g.pipeline, slot.globalIndex);
    },
  });

  // Notify parent once on mount.
  useEffect(() => {
    onSceneReady?.(sceneRefStable.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Native wheel zoom ──────────────────────────────────────────────────────
  // OrbitControls' scroll handling may silently fail in the WebGPU context.
  // This native listener directly scales the camera-to-target distance,
  // guaranteeing zoom works regardless of OrbitControls event plumbing.
  const { gl, camera } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const idx = indexRef.current;
      if (!idx) return;
      const [cx, cy, cz] = idx.info.center;
      const orbitTarget = orbitControlsRef?.current?.target as Vector3 | undefined;
      const target = orbitTarget ?? new Vector3(cx, cy, cz);
      const dir = new Vector3().subVectors(camera.position as Vector3, target);
      const dist = dir.length();
      // zoomFactor > 1 = zoom in (scroll up = negative deltaY)
      const factor = Math.pow(0.9, -e.deltaY * 0.01);
      const newDist = Math.max(minOrbitDistance, dist * factor);
      dir.normalize().multiplyScalar(newDist);
      (camera.position as Vector3).copy(target).add(dir);
      camera.updateMatrixWorld();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [gl, camera, minOrbitDistance]);

  // ── Per-frame render loop (R3F useFrame priority 1) ─────────────────────
  // frameloop must be "always" so OrbitControls' useFrame(-1) runs; positive
  // priority disables R3F's *automatic* gl.render at end of update().
  // We do NOT call gl.render() here: it would consume the canvas swapchain texture
  // before our COPC pass (WebGPU: avoid multiple getCurrentTexture() per frame).
  // Instead mirror Renderer._renderScene world-matrix updates (Renderer.js ~643–645).

  useFrame((state, delta) => {
      const currentGl = state.gl;
      const camera = state.camera;

      // ── Lazy GPU init ────────────────────────────────────────────────
      if (!gpuRef.current) {
        const device    = getDeviceFromRenderer(currentGl);
        const canvasCtx = getCanvasContextFromRenderer(currentGl);
        if (!device || !canvasCtx) {
          // R3F skips gl.render when a useFrame subscriber has priority > 0, so
          // WebGPURenderer.init() may not have run yet. Call it manually — idempotent.
          if (!(currentGl as any)._copcInitCalled) {
            (currentGl as any)._copcInitCalled = true;
            const initFn = (currentGl as any).init;
            if (typeof initFn === "function") {
              (initFn as () => Promise<void>).call(currentGl).catch((e: unknown) => {
                console.error("[COPC] renderer.init() failed:", e);
              });
            }
          }
          return; // renderer not ready yet — retry next frame
        }
        const STO = GPUBufferUsage.STORAGE;
        const DST = GPUBufferUsage.COPY_DST;
        const SRC = GPUBufferUsage.COPY_SRC;

        const copcPipeline = createCopcGpuPipeline(device, pipelineConfigRef.current);

        const uniformBuffer = device.createBuffer({
          size:  TRAVERSE_UNIFORM_SIZE,
          usage: GPUBufferUsage.UNIFORM | DST,
          label: "copc-traverse-uniforms",
        });
        const renderUniformBuffer = device.createBuffer({
          size:  RENDER_UNIFORM_SIZE,
          usage: GPUBufferUsage.UNIFORM | DST,
          label: "copc-render-uniforms",
        });

        const waveIdxStage = device.createBuffer({
          size:  copcPipeline.maxDepth * 4,
          usage: SRC | DST,
          label: "copc-wave-idx-stage",
        });
        device.queue.writeBuffer(
          waveIdxStage, 0,
          new Uint32Array(Array.from({ length: copcPipeline.maxDepth }, (_, i) => i)),
        );

        const traverseMod = device.createShaderModule({ code: traverseWaveSource,  label: "copc-traverse" });
        const compactMod  = device.createShaderModule({ code: compactSource,        label: "copc-compact"  });
        const spriteMod   = device.createShaderModule({ code: pointSpriteSource,    label: "copc-sprite"   });

        const traverseBGL0 = device.createBindGroupLayout({
          label: "traverse-bg0",
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          ],
        });
        const traverseBGL1 = device.createBindGroupLayout({
          label: "traverse-bg1",
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          ],
        });

        const traversePipeline = device.createComputePipeline({
          label:  "copc-traverse",
          layout: device.createPipelineLayout({ bindGroupLayouts: [traverseBGL0, traverseBGL1] }),
          compute: { module: traverseMod, entryPoint: "main" },
        });

        const mkBG0 = (qIn: GPUBuffer, qOut: GPUBuffer) =>
          device.createBindGroup({
            layout:  traverseBGL0,
            entries: [
              { binding: 0, resource: { buffer: qIn  } },
              { binding: 1, resource: { buffer: qOut } },
            ],
          });

        const traverseBG0Even = mkBG0(copcPipeline.workQueueA, copcPipeline.workQueueB);
        const traverseBG0Odd  = mkBG0(copcPipeline.workQueueB, copcPipeline.workQueueA);

        const traverseBG1 = device.createBindGroup({
          layout:  traverseBGL1,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer                    } },
            { binding: 1, resource: { buffer: copcPipeline.nodeBuffer          } },
            { binding: 2, resource: { buffer: copcPipeline.selectedSlotsBuffer } },
            { binding: 3, resource: { buffer: copcPipeline.queueCountBuffer    } },
          ],
        });

        const compactBGL0 = device.createBindGroupLayout({
          label: "compact-bg0",
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          ],
        });

        const compactPipeline = device.createComputePipeline({
          label:  "copc-compact",
          layout: device.createPipelineLayout({ bindGroupLayouts: [compactBGL0] }),
          compute: { module: compactMod, entryPoint: "main" },
        });

        const compactBG0 = device.createBindGroup({
          layout:  compactBGL0,
          entries: [
            { binding: 0, resource: { buffer: copcPipeline.selectedSlotsBuffer } },
            { binding: 1, resource: { buffer: copcPipeline.slotDescBuffer      } },
            { binding: 2, resource: { buffer: copcPipeline.drawArgsBuffer      } },
          ],
        });

        // ── Pack pipeline (draws packer) ───────────────────────────────────
        const packMod  = device.createShaderModule({ label: "copc-pack", code: packSource });
        const packBGL0 = device.createBindGroupLayout({
          label: "pack-bg0",
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          ],
        });
        const packPipeline = device.createComputePipeline({
          label:  "copc-pack",
          layout: device.createPipelineLayout({ bindGroupLayouts: [packBGL0] }),
          compute: { module: packMod, entryPoint: "main" },
        });
        const packBG0 = device.createBindGroup({
          layout:  packBGL0,
          entries: [
            { binding: 0, resource: { buffer: copcPipeline.drawArgsBuffer   } },
            { binding: 1, resource: { buffer: copcPipeline.packListBuffer   } },
            { binding: 2, resource: { buffer: copcPipeline.drawCountBuffer  } },
          ],
        });

        const supportsMultiDraw = device.features.has("multi-draw-indirect" as GPUFeatureName);

        const renderBGL0 = device.createBindGroupLayout({
          label: "sprite-bg0",
          entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
          ],
        });
        const renderBGL1 = device.createBindGroupLayout({
          label: "sprite-bg1",
          entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
          ],
        });

        let canvasColorFormat: GPUTextureFormat;
        try {
          canvasColorFormat = canvasCtx.getCurrentTexture().format;
        } catch {
          canvasColorFormat = navigator.gpu.getPreferredCanvasFormat();
        }

        const renderPipeline = device.createRenderPipeline({
          label:  "copc-sprite",
          layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL0, renderBGL1] }),
          vertex:   { module: spriteMod, entryPoint: "vs_main" },
          fragment: {
            module:  spriteMod,
            entryPoint: "fs_main",
            targets: [{ format: canvasColorFormat, blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
            } }],
          },
          primitive: { topology: "triangle-list", cullMode: "none" },
        });

        const renderBG0 = device.createBindGroup({
          layout:  renderBGL0,
          entries: [
            { binding: 0, resource: { buffer: copcPipeline.atlasPosBuffer  } },
            { binding: 1, resource: { buffer: copcPipeline.atlasColorBuffer } },
            { binding: 2, resource: { buffer: copcPipeline.atlasAttrBuffer  } },
          ],
        });

        const renderBG1 = device.createBindGroup({
          layout:  renderBGL1,
          entries: [{ binding: 0, resource: { buffer: renderUniformBuffer } }],
        });

        gpuRef.current = {
          device, canvasCtx,
          pipeline: copcPipeline,
          uniformBuffer,
          renderUniformBuffer,
          waveIdxStage,
          traversePipeline,
          compactPipeline,
          packPipeline,
          renderPipeline,
          supportsMultiDraw,
          traverseBG0Even,
          traverseBG0Odd,
          traverseBG1,
          compactBG0,
          packBG0,
          renderBG0,
          renderBG1,
          uploadedIndex: null,
        };

        // If index already arrived, upload the node table immediately.
        if (indexRef.current) {
          uploadNodeTable(device, copcPipeline, indexRef.current, renderPropsRef.current.maxDepth);
          gpuRef.current.uploadedIndex = indexRef.current;
        }

        onRendererResolvedRef.current?.("webgpu");
        return; // render on next frame
      }

      const scene = state.scene;
      if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate) {
        camera.updateMatrixWorld();
      }

      const g = gpuRef.current;
      frameCountRef.current++;
      uploadMetricsRef.frameCount++;
      const { device, canvasCtx, pipeline } = g;
      const maxD       = pipeline.maxDepth;
      const totalSlots = pipeline.atlas.totalSlots;

      const { frustumCulling: fc, lodThreshold: lod, colorBy: cb,
              basePointSize: bps } = renderPropsRef.current;
      const lodThreshold = lod;

      const swapchain = canvasCtx.getCurrentTexture();
      const w = swapchain.width;
      const h = swapchain.height;

      // ── Camera uniforms ────────────────────────────────────────────
      const cam = camera as PerspectiveCamera;
      if (cam.coordinateSystem !== WebGPUCoordinateSystem) {
        cam.coordinateSystem = WebGPUCoordinateSystem;
        cam.updateProjectionMatrix();
      }
      _vpMatrix.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
      const idxInfo = indexRef.current?.info;
      if (idxInfo) {
        const ox = idxInfo.center[0];
        const oy = idxInfo.center[1];
        const oz = idxInfo.center[2];
        _camWorldRel.copy(cam.matrixWorld);
        _camWorldRel.elements[12] -= ox;
        _camWorldRel.elements[13] -= oy;
        _camWorldRel.elements[14] -= oz;
        _viewRelInv.copy(_camWorldRel).invert();
        _renderVpMatrix.copy(cam.projectionMatrix).multiply(_viewRelInv);
      } else {
        _renderVpMatrix.copy(_vpMatrix);
      }
      const vp  = _vpMatrix.elements;
      const fovYRadians = (cam.fov * Math.PI) / 180;
      const focalLength = h / (2.0 * Math.tan(fovYRadians * 0.5));
      if (uploadMetricsRef.frameCount - uploadMetricsRef.lastLogFrame >= 60) {
        const { totalUploadAttempts, totalUploadFailures } = uploadMetricsRef;
        const failureRate = totalUploadAttempts > 0
          ? (totalUploadFailures / totalUploadAttempts) * 100
          : 0;

        const atlas = pipeline.atlas;
        const tierFill = atlas.tiers.map((t: any, i: number) => {
          const freeSlots = atlas.freeSlotCount(t.pointsPerSlot);
          const usedSlots = t.slotCount - freeSlots;
          return `${usedSlots}/${t.slotCount}`;
        });

        console.log(
          `[COPC Metrics] frame=${uploadMetricsRef.frameCount} | ` +
          `uploads=${totalUploadAttempts} | ` +
          `failures=${totalUploadFailures} (${failureRate.toFixed(2)}%) | ` +
          `tierFailures=[${uploadMetricsRef.tierFailures.join(", ")}] | ` +
          `nodeIdMissing=${uploadMetricsRef.nodeIdMissingFailures} | ` +
          `allocOversize=${uploadMetricsRef.allocOversizeFailures} | ` +
          `allocAtlasFull=${uploadMetricsRef.allocAtlasFullFailures}`,
        );
        console.log(`[COPC Metrics] Atlas tier fill: [${tierFill.join(", ")}]`);

        if (totalUploadAttempts > 10 && totalUploadFailures / totalUploadAttempts > 0.10) {
          console.warn(
            `[COPC Metrics] HIGH UPLOAD FAILURE RATE: ${(totalUploadFailures / totalUploadAttempts * 100).toFixed(1)}%`,
          );
        }

        uploadMetricsRef.lastLogFrame = uploadMetricsRef.frameCount;
        uploadMetricsRef.totalUploadAttempts = 0;
        uploadMetricsRef.totalUploadFailures = 0;
        uploadMetricsRef.tierFailures.fill(0);
        uploadMetricsRef.nodeIdMissingFailures = 0;
        uploadMetricsRef.allocOversizeFailures = 0;
        uploadMetricsRef.allocAtlasFullFailures = 0;
      }

      const rm = renderMetricsRef;
      if (rm) {
        const idxM = indexRef.current;
        let cameraDistance = 0;
        if (idxM) {
          const [cx, cy, cz] = idxM.info.center;
          const dx = cam.position.x - cx;
          const dy = cam.position.y - cy;
          const dz = cam.position.z - cz;
          cameraDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        const vpFlat = Array.from(_vpMatrix.elements) as number[];
        const selectedIds = computeCopcLodCut(
          pipeline.nodes,
          pipeline.rootNodeIds,
          pipeline.atlas,
          vpFlat,
          focalLength,
          lodThreshold,
          fc,
          false,
        );
        let renderedPoints = 0;
        let effectiveLodLevel = 0;
        for (const id of selectedIds) {
          const n = pipeline.nodes[id];
          if (n) {
            renderedPoints += n.pointCount;
            if (n.key.depth > effectiveLodLevel) effectiveLodLevel = n.key.depth;
          }
        }
        const frameTimeMs = delta * 1000;
        const fps = delta > 1e-6 ? Math.min(240, 1 / delta) : 60;
        rm.current = {
          renderedPoints,
          effectiveLodLevel,
          cameraDistance,
          frameTimeMs,
          fps,
        };
      }

      const planes = fc
        ? extractFrustumPlanes(Array.from(vp) as number[])
        : Array.from({ length: 6 }, () => [0, 1, 0, 1e9]);

      // Write frame uniforms (waveIndex patched per wave via copyBufferToBuffer).
      for (let i = 0; i < 16; i++) _f32scratch[i] = vp[i];
      for (let p = 0; p < 6; p++) {
        _f32scratch[16 + p * 4]     = planes[p][0];
        _f32scratch[16 + p * 4 + 1] = planes[p][1];
        _f32scratch[16 + p * 4 + 2] = planes[p][2];
        _f32scratch[16 + p * 4 + 3] = planes[p][3];
      }
      _f32scratch[40] = cam.position.x;
      _f32scratch[41] = cam.position.y;
      _f32scratch[42] = cam.position.z;
      _f32scratch[43] = 0.0;
      _f32scratch[44] = focalLength;
      _f32scratch[45] = lodThreshold;
      _f32scratch[46] = w;
      _f32scratch[47] = h;
      _u32scratch[48] = 0;  // waveIndex — overwritten per wave
      _u32scratch[49] = 0;
      _u32scratch[50] = 0;
      _u32scratch[51] = 0;

      device.queue.writeBuffer(g.uniformBuffer, 0, _scratch, 0, TRAVERSE_UNIFORM_SIZE);

      const rvp = _renderVpMatrix.elements;
      for (let i = 0; i < 16; i++) _rf32[i] = rvp[i];
      _rf32[16] = w;
      _rf32[17] = h;
      _rf32[18] = bps;
      const st = attrStatsRef.current;
      let attrMin = 0.0;
      let attrMax = 1.0;
      if (
        cb &&
        cb !== "rgb" &&
        cb !== "classification" &&
        Number.isFinite(st.min) &&
        Number.isFinite(st.max) &&
        st.samples > 0
      ) {
        if (st.max > st.min) {
          attrMin = st.min;
          attrMax = st.max;
        } else {
          attrMin = st.min - 0.5;
          attrMax = st.max + 0.5;
        }
      }
      _rf32[19] = attrMin;
      _rf32[20] = attrMax;
      _ru32[21] = cb === "rgb" ? 2 : cb === "classification" ? 3 : cb ? 1 : 0;
      device.queue.writeBuffer(g.renderUniformBuffer, 0, _renderScratch, 0, RENDER_UNIFORM_SIZE);

      // ── Re-seed wave 0 work queue ──────────────────────────────────
      // workQueueA gets overwritten by wave 1 each frame (odd waves write
      // back into A).  Re-write root node IDs before every submit so wave 0
      // always sees the correct input.  writeBuffer executes before the
      // encoder on the same queue so sequencing is guaranteed.
      const roots = pipeline.rootNodeIds;
      if (roots.length > 0) {
        device.queue.writeBuffer(pipeline.workQueueA, 0, new Uint32Array(roots));
      }

      // ── Command buffer ─────────────────────────────────────────────
      const encoder = device.createCommandEncoder({ label: "copc-frame" });

      // Reset selected slots bitfield.
      encoder.clearBuffer(g.pipeline.selectedSlotsBuffer);
      // Reset queue counts [1..maxD] — keep [0] = numRoots intact (set by uploadNodeTable).
      if (maxD > 0) {
        encoder.clearBuffer(g.pipeline.queueCountBuffer, 4, maxD * 4);
      }

      // ── Traversal waves ────────────────────────────────────────────
      // Fixed dispatch count: ceil(MAX_NODES / 64). Threads with
      // idx >= queueCounts[wave] return immediately (cheap early-out).
      // This avoids the buffer-usage conflict that dispatchWorkgroupsIndirect
      // would cause (same buffer as storage(rw) and indirect in one pass).
      const maxWaveWorkgroups = Math.ceil(pipeline.maxNodes / TRAVERSE_WORKGROUP_SIZE);
      for (let wave = 0; wave < maxD; wave++) {
        // Patch waveIndex into uniform buffer (sequenced by encoder).
        encoder.copyBufferToBuffer(g.waveIdxStage, wave * 4, g.uniformBuffer, WAVE_INDEX_BYTE_OFFSET, 4);

        const computePass = encoder.beginComputePass({ label: `copc-wave-${wave}` });
        computePass.setPipeline(g.traversePipeline);
        computePass.setBindGroup(0, wave % 2 === 0 ? g.traverseBG0Even : g.traverseBG0Odd);
        computePass.setBindGroup(1, g.traverseBG1);
        computePass.dispatchWorkgroups(maxWaveWorkgroups);
        computePass.end();
      }

      // ── Compaction pass ────────────────────────────────────────────
      const compactPass = encoder.beginComputePass({ label: "copc-compact" });
      compactPass.setPipeline(g.compactPipeline);
      compactPass.setBindGroup(0, g.compactBG0);
      compactPass.dispatchWorkgroups(Math.max(1, Math.ceil(totalSlots / 64)));
      compactPass.end();

      // ── Pack pass ──────────────────────────────────────────────────
      // Reset draw count to 0 before the pack dispatch, then compact
      // non-zero draw args into packListBuffer for multiDrawIndirect.
      encoder.clearBuffer(g.pipeline.drawCountBuffer);
      const packPass = encoder.beginComputePass({ label: "copc-pack" });
      packPass.setPipeline(g.packPipeline);
      packPass.setBindGroup(0, g.packBG0);
      packPass.dispatchWorkgroups(Math.max(1, Math.ceil(totalSlots / 64)));
      packPass.end();

      // ── Render pass ────────────────────────────────────────────────
      const colorView = swapchain.createView();
      const renderPass = encoder.beginRenderPass({
        label: "copc-render",
        colorAttachments: [{
          view:       colorView,
          loadOp:     "clear",
          clearValue: { r: 64 / 255, g: 64 / 255, b: 64 / 255, a: 1 },
          storeOp:    "store",
        }],
      });

      renderPass.setPipeline(g.renderPipeline);
      renderPass.setBindGroup(0, g.renderBG0);
      renderPass.setBindGroup(1, g.renderBG1);

      // Single multiDrawIndirect from the packed list (one call vs. N calls).
      // Falls back to N individual drawIndirect calls when the feature is unavailable.
      if (g.supportsMultiDraw) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (renderPass as any).multiDrawIndirect(
          g.pipeline.packListBuffer,
          0,
          totalSlots,                     // maxDrawCount upper bound — GPU reads actual count from drawCountBuffer
          g.pipeline.drawCountBuffer,
          0,
        );
      } else {
        // Fallback: N individual indirect draws — GPU discards draws with vertexCount=0 cheaply.
        for (let slot = 0; slot < totalSlots; slot++) {
          renderPass.drawIndirect(g.pipeline.drawArgsBuffer, slot * 16);
        }
      }

      renderPass.end();

      device.queue.submit([encoder.finish()]);
  }, 1);

  useEffect(() => () => {
    const g = gpuRef.current;
    if (g) {
      g.pipeline.destroy();
      g.uniformBuffer.destroy();
      g.renderUniformBuffer.destroy();
      g.waveIdxStage.destroy();
      gpuRef.current = null;
    }
  }, []);

  // R3F requires at least one scene object — empty group is enough.
  return <group />;
}
