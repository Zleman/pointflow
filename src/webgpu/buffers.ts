import type { PackedAttributeChannel } from "../core/types";
import { lasClassToU32 } from "../core/color-map";

export interface WebGPUPointBuffers {
  /** Single GPU ring buffer: vec4<f32> per point (16 bytes). */
  positionBuffer: GPUBuffer;
  /** Single GPU ring buffer: f32 per point (4 bytes). */
  attributeBuffer: GPUBuffer;
  /** Epoch-relative ingest timestamp per point (f32, same ring layout). */
  timestampBuffer: GPUBuffer;
  /** Compacted visible positions output from compute (vec4<f32>). */
  visiblePositionBuffer: GPUBuffer;
  /** Compacted visible attributes output from compute (f32). */
  visibleAttributeBuffer: GPUBuffer;
  /** Indirect draw args: [vertexCount=6, instanceCount (filled by compute), 0, 0]. */
  indirectBuffer: GPUBuffer;
  /** 4-byte MAP_READ staging buffer for async readback of the visible instance count. */
  visibleCountStagingBuffer: GPUBuffer;
  /** Compacted ring-buffer slot indices for visible points (u32 per visible point). */
  visibleSlotBuffer: GPUBuffer;
  /** 256-byte MAP_READ staging buffer for 1×1 R32Uint GPU pick pixel readback. */
  pickStagingBuffer: GPUBuffer;
  /** Next write index in the GPU ring (wraps at capacity). */
  gpuWritePointer: number;
  /** Number of valid points currently in the GPU ring (≤ capacity). */
  gpuTotalCount: number;
  /** Actual point capacity after clamping to device limits. */
  capacity: number;
  destroy(): void;
}

export function createPointBuffers(device: GPUDevice, requestedCapacity: number): WebGPUPointBuffers {
  const maxBindingSize = device.limits.maxStorageBufferBindingSize;
  const capacity = Math.min(requestedCapacity, Math.floor(maxBindingSize / 16));
  const posSize  = capacity * 16;
  const attrSize = Math.max(capacity * 4, 4);

  const mkBuf = (size: number, usage: GPUBufferUsageFlags): GPUBuffer =>
    device.createBuffer({ size, usage });

  const STO = GPUBufferUsage.STORAGE;
  const DST = GPUBufferUsage.COPY_DST;

  const positionBuffer        = mkBuf(posSize,  STO | DST);
  const attributeBuffer       = mkBuf(attrSize, STO | DST);
  const timestampBuffer       = mkBuf(Math.max(attrSize, 4), STO | DST); // f32 per point
  const visiblePositionBuffer = mkBuf(posSize,  STO);
  const visibleAttributeBuffer = mkBuf(attrSize, STO);
  // INDIRECT + STORAGE (atomic write from compute) + COPY_DST (required by encoder.clearBuffer
  // for per-frame instance-count reset) + COPY_SRC (visible-count readback).
  const indirectBuffer = mkBuf(16, GPUBufferUsage.INDIRECT | STO | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
  // Initialize indirect[0] = 6 permanently (instanced quad: 6 vertices per instance).
  device.queue.writeBuffer(indirectBuffer, 0, new Uint32Array([6, 0, 0, 0]));
  const visibleCountStagingBuffer = mkBuf(4, GPUBufferUsage.MAP_READ | DST);
  const visibleSlotBuffer = mkBuf(Math.max(capacity * 4, 4), STO);
  const pickStagingBuffer = mkBuf(256, GPUBufferUsage.MAP_READ | DST);

  return {
    positionBuffer,
    attributeBuffer,
    timestampBuffer,
    visiblePositionBuffer,
    visibleAttributeBuffer,
    indirectBuffer,
    visibleCountStagingBuffer,
    visibleSlotBuffer,
    pickStagingBuffer,
    gpuWritePointer: 0,
    gpuTotalCount: 0,
    capacity,
    destroy() {
      positionBuffer.destroy();
      attributeBuffer.destroy();
      timestampBuffer.destroy();
      visiblePositionBuffer.destroy();
      visibleAttributeBuffer.destroy();
      indirectBuffer.destroy();
      visibleCountStagingBuffer.destroy();
      visibleSlotBuffer.destroy();
      pickStagingBuffer.destroy();
    },
  };
}

/** Reset the CPU-side counters so the GPU ring appears empty after a stream reset. */
export function clearGpuBuffers(buffers: WebGPUPointBuffers): void {
  buffers.gpuTotalCount   = 0;
  buffers.gpuWritePointer = 0;
}

// Module-level scratch buffers — grow lazily, shrink back after a period of low demand.
// Without a cap, a one-time 5M-point bulk ingest would permanently retain ~80 MB of scratch.
const _SCRATCH_NORMAL_SIZE   = 65_536;  // 65k points — normal streaming chunk budget
const _SCRATCH_SHRINK_AFTER  = 10_000; // ms of no large-chunk demand before shrinking back
let _posVec4Scratch:  Float32Array = new Float32Array(0);
let _attrFlatScratch: Float32Array = new Float32Array(0);
let _tsScratch:       Float32Array = new Float32Array(0);
let _scratchLastLargeMs = 0;

function _ensureScratch(count: number): void {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  // Shrink back to normal size if we haven't needed large scratch recently.
  if (
    _posVec4Scratch.length > _SCRATCH_NORMAL_SIZE * 4 &&
    now - _scratchLastLargeMs > _SCRATCH_SHRINK_AFTER
  ) {
    _posVec4Scratch  = new Float32Array(_SCRATCH_NORMAL_SIZE * 4);
    _attrFlatScratch = new Float32Array(_SCRATCH_NORMAL_SIZE);
    _tsScratch       = new Float32Array(_SCRATCH_NORMAL_SIZE);
  }
  if (_posVec4Scratch.length < count * 4) {
    if (count > _SCRATCH_NORMAL_SIZE) _scratchLastLargeMs = now;
    _posVec4Scratch  = new Float32Array(count * 4);
    _attrFlatScratch = new Float32Array(count);
    _tsScratch       = new Float32Array(count);
  }
}

/**
 * Write an incremental xyz chunk into the GPU ring buffer at gpuWritePointer,
 * handling ring wrap. O(chunk) — does NOT scan the full ring.
 * Returns the attribute min/max of the ingested chunk.
 *
 * @param nowRelEpoch Epoch-relative ingest timestamp (Date.now() - epochMs).
 *                    All points in the chunk receive the same ingest timestamp.
 */
export function writeIncrementalChunk(
  device: GPUDevice,
  buffers: WebGPUPointBuffers,
  xyz: Float32Array,
  attributes: PackedAttributeChannel[] | undefined,
  count: number,
  nowRelEpoch = 0,
  colorByKey?: string,
): { attrMin: number; attrMax: number } {
  if (count === 0) return { attrMin: 0, attrMax: 0 };
  const capped = Math.min(count, buffers.capacity);
  _ensureScratch(capped);

  const isRgbMode   = colorByKey === "rgb";
  const isClassMode = colorByKey === "classification";
  let attrCh:  PackedAttributeChannel | null = null;
  let redCh:   PackedAttributeChannel | null = null;
  let greenCh: PackedAttributeChannel | null = null;
  let blueCh:  PackedAttributeChannel | null = null;
  let classCh: PackedAttributeChannel | null = null;

  if (attributes && attributes.length > 0) {
    if (isRgbMode) {
      redCh   = attributes.find(ch => ch.key === "red")   ?? null;
      greenCh = attributes.find(ch => ch.key === "green") ?? null;
      blueCh  = attributes.find(ch => ch.key === "blue")  ?? null;
    } else if (isClassMode) {
      classCh = attributes.find(ch => ch.key === "classification") ?? null;
    } else {
      attrCh = colorByKey
        ? (attributes.find(ch => ch.key === colorByKey) ?? null)
        : attributes[0];
    }
  }
  const attr0 = attrCh ? attrCh.values : null;
  const attrU32 = (isRgbMode || isClassMode) ? new Uint32Array(_attrFlatScratch.buffer) : null;
  let attrMin = Infinity, attrMax = -Infinity;

  for (let i = 0; i < capped; i++) {
    _posVec4Scratch[i * 4]     = xyz[i * 3];
    _posVec4Scratch[i * 4 + 1] = xyz[i * 3 + 1];
    _posVec4Scratch[i * 4 + 2] = xyz[i * 3 + 2];
    _posVec4Scratch[i * 4 + 3] = 1.0;
    _tsScratch[i] = nowRelEpoch;
    if (isRgbMode) {
      const r = redCh   ? (redCh.values[i]   & 0xFF) : 0;
      const g = greenCh ? (greenCh.values[i] & 0xFF) : 0;
      const b = blueCh  ? (blueCh.values[i]  & 0xFF) : 0;
      attrU32![i] = r | (g << 8) | (b << 16);
    } else if (isClassMode) {
      attrU32![i] = lasClassToU32(classCh ? classCh.values[i] : 0);
    } else {
      const a = attr0 ? attr0[i] : 0.0;
      _attrFlatScratch[i] = a;
      if (a < attrMin) attrMin = a;
      if (a > attrMax) attrMax = a;
    }
  }

  const ptr = buffers.gpuWritePointer;
  const cap = buffers.capacity;
  const firstPart  = Math.min(capped, cap - ptr);
  const secondPart = capped - firstPart;

  // Position ring writes (16 bytes per point)
  device.queue.writeBuffer(
    buffers.positionBuffer, ptr * 16,
    _posVec4Scratch.buffer as ArrayBuffer, 0, firstPart * 16
  );
  if (secondPart > 0) {
    device.queue.writeBuffer(
      buffers.positionBuffer, 0,
      _posVec4Scratch.buffer as ArrayBuffer, firstPart * 16, secondPart * 16
    );
  }
  // Attribute ring writes (4 bytes per point)
  device.queue.writeBuffer(
    buffers.attributeBuffer, ptr * 4,
    _attrFlatScratch.buffer as ArrayBuffer, 0, firstPart * 4
  );
  if (secondPart > 0) {
    device.queue.writeBuffer(
      buffers.attributeBuffer, 0,
      _attrFlatScratch.buffer as ArrayBuffer, firstPart * 4, secondPart * 4
    );
  }
  // Timestamp ring writes (4 bytes per point)
  device.queue.writeBuffer(
    buffers.timestampBuffer, ptr * 4,
    _tsScratch.buffer as ArrayBuffer, 0, firstPart * 4
  );
  if (secondPart > 0) {
    device.queue.writeBuffer(
      buffers.timestampBuffer, 0,
      _tsScratch.buffer as ArrayBuffer, firstPart * 4, secondPart * 4
    );
  }

  buffers.gpuWritePointer = (ptr + capped) % cap;
  buffers.gpuTotalCount   = Math.min(buffers.gpuTotalCount + capped, cap);
  return { attrMin, attrMax };
}

/**
 * Bulk-upload pre-converted SoA data (posVec4: vec4 per point, attrFlat: f32 per point)
 * into the GPU ring starting at offset 0. Used for the one-time init upload when GPU
 * becomes available and the CPU ring already has points.
 *
 * @param timestamps Optional epoch-relative timestamps (f32 per point). When omitted,
 *                   the timestamp buffer is left at its current GPU state (zeros on first use).
 */
export function uploadFullData(
  device: GPUDevice,
  buffers: WebGPUPointBuffers,
  posVec4: Float32Array,
  attrFlat: Float32Array,
  count: number,
  timestamps?: Float32Array,
): void {
  if (count === 0) return;
  const capped = Math.min(count, buffers.capacity);
  device.queue.writeBuffer(
    buffers.positionBuffer, 0,
    posVec4.buffer as ArrayBuffer, posVec4.byteOffset, capped * 16
  );
  device.queue.writeBuffer(
    buffers.attributeBuffer, 0,
    attrFlat.buffer as ArrayBuffer, attrFlat.byteOffset, capped * 4
  );
  if (timestamps) {
    device.queue.writeBuffer(
      buffers.timestampBuffer, 0,
      timestamps.buffer as ArrayBuffer, timestamps.byteOffset, capped * 4
    );
  }
  buffers.gpuWritePointer = capped % buffers.capacity;
  buffers.gpuTotalCount   = capped;
}
