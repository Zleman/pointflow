---
id: webgpu-pipeline
title: WebGPU rendering pipeline
sidebar_position: 4
---

# WebGPU rendering pipeline

The WebGPU path runs frustum culling and importance sampling on the GPU, eliminating the CPU-side loop that the WebGL path requires.

## Pipeline stages

### 1. CPU-to-GPU upload

Every throttle tick, the CPU ring buffer copies its contents into a GPU storage buffer flagged `STORAGE | COPY_DST`. This is a full-ring upload — O(N) CPU work per tick where N is the current buffer fill. It's the main cost of the WebGPU path and the planned optimization for a future incremental upload path.

### 2. Compute pass

A WGSL compute shader reads all uploaded points and produces a compacted output buffer:

```wgsl
@compute @workgroup_size(256)
fn cull_and_compact(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= uniforms.pointCount) { return; }

  let pos = positions[index];

  // 6-plane frustum test
  if (!passes_frustum(pos, uniforms.frustumPlanes)) { return; }

  // Temporal window filter (when timeWindowMs > 0)
  if (uniforms.timeWindowMs > 0u) {
    let age = uniforms.currentTime - timestamps[index];
    if (age > uniforms.timeWindowMs) { return; }
  }

  // Importance sampling (when enabled)
  if (uniforms.importanceSamplingEnabled == 1u) {
    let hash = pcg_hash(index, uniforms.frameSeed);
    if (f32(hash) / 4294967295.0 > importances[index]) { return; }
  }

  // Atomically append to output buffer
  let out = atomicAdd(&drawIndirectArgs.vertexCount, 1u);
  compacted[out] = index;
}
```

The compute shader:
- Reads positions, timestamps, and importance values from storage buffers.
- Applies frustum, temporal window, and importance tests.
- Uses `atomicAdd` to append surviving point indices to a compacted index buffer.
- Writes the surviving point count directly into the `drawIndirect` arguments buffer.

### 3. Draw pass

`drawIndirect` draws from the compacted buffer using the count that the compute shader wrote. The CPU never needs to know how many points survived. There's no `BufferAttribute.needsUpdate`, no CPU readback, and no draw call preparation on the frame path.

## Double buffering

Two sets of position and attribute storage buffers alternate each tick: one is being written by the CPU (upload) while the other is being read by the GPU (compute + draw). This ensures ingest and rendering never contend on the same memory.

## Support matrix

| Browser | Status |
|---|---|
| Chrome 113+ | Full WebGPU support |
| Edge 113+ | Full WebGPU support |
| Firefox | No WebGPU — uses WebGL fallback |
| Safari 18+ | Experimental WebGPU — uses WebGL fallback by default |
| Node.js / jsdom | No `navigator.gpu` — uses WebGL fallback |

## Known limitations

**Full-ring upload per tick:** The current upload path copies all N positions on every tick even when few points changed. Worker-to-GPU incremental upload (only new chunks since the last tick) is the planned fix and would reduce upload cost proportionally to ingest rate.

**`maxStorageBufferBindingSize`:** GPU devices cap the size of storage buffers, typically at 128–512 MB. PointFlow checks this at initialization and silently caps `maxPoints` if the requested size would exceed the device limit. Use `onRendererResolved` and the active policy to see the effective budget.

## GPU point picking

On `pointerdown`, a second render pass is added to the same command encoder (after the compute pass, before the main draw). The picking pass:

1. Renders all visible points (via the same `drawIndirect` buffer) into a full-resolution R32Uint texture.
2. Each fragment writes `visibleSlot[instanceIndex] + 1` — the ring-buffer slot of the point, offset by one so that 0 means "nothing drawn here".
3. A 1×1 region at the click coordinates is copied to a 256-byte staging buffer via `copyTextureToBuffer`.
4. After `device.queue.submit`, the staging buffer is mapped asynchronously. The encoded value is decoded back to a ring-buffer slot and the CPU ring buffer returns the point's XYZ and attributes.

Coordinates are scaled by the actual device pixel ratio (canvas device pixels / CSS pixels) before the texture read, so the result is correct on HiDPI displays.

The picking pass adds no per-frame cost — it only runs in the frame where a click lands.

## WebGL fallback

The WebGL path achieves the same visible output through CPU-side operations:

1. `copyToTypedArrays` iterates the ring buffer, applies the frustum predicate, applies LOD stride, and writes into pre-allocated `Float32Array` position and color buffers.
2. These buffers upload to `BufferGeometry` attributes with `needsUpdate = true`.
3. `drawArrays` draws from the uploaded attributes.

The cost is higher because the frustum loop runs on the main thread. But the result is correct and it works on every browser including Firefox and older Safari.
