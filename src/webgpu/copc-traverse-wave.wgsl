// copc-traverse-wave.wgsl
//
// One compute dispatch per LOD wave.  Reads the current wave's work queue,
// runs per-node frustum cull + screen-space LOD test, and either:
//   - Selects the node for rendering (sets its bit in selectedSlots), or
//   - Pushes its children into the next wave's work queue.
//
// Each wave is dispatched with a fixed workgroup count (ceil(MAX_NODES/64)).
// Threads where idx >= inputCount return immediately (cheap early-out).
// This avoids the indirect-dispatch buffer conflict (a buffer cannot be
// both storage(read-write) and indirect in the same compute pass).
//
// Bind groups:
//   group(0) — per-wave, ping-pong (even waves: A→B, odd waves: B→A)
//   group(1) — frame-constant (uniforms, node table, shared atomic buffers)

// ── Structs ────────────────────────────────────────────────────────────────

struct CopcGpuNode {
  bboxMinX:   f32,
  bboxMinY:   f32,
  bboxMinZ:   f32,
  bboxMaxX:   f32,
  bboxMaxY:   f32,
  bboxMaxZ:   f32,
  error:      f32,
  atlasSlot:  u32,
  pointCount: u32,
  parent:     u32,
  flags:      u32,
  _pad:       u32,
  children:   array<u32, 8>,
}

struct FrameUniforms {
  viewProj:       mat4x4<f32>,         // offset   0 (64 bytes)
  planes:         array<vec4<f32>, 6>, // offset  64 (96 bytes)
  cameraPos:      vec4<f32>,           // offset 160 (16 bytes)
  focalLength:    f32,                 // offset 176
  lodThreshold:   f32,                 // offset 180
  viewportWidth:  f32,                 // offset 184
  viewportHeight: f32,                 // offset 188
  waveIndex:      u32,                 // offset 192
  _pad0:          u32,
  _pad1:          u32,
  _pad2:          u32,
}

// ── Bindings ───────────────────────────────────────────────────────────────

// group(0) — per-wave, swapped between dispatches
@group(0) @binding(0) var<storage, read>       workQueueIn:  array<u32>;
@group(0) @binding(1) var<storage, read_write> workQueueOut: array<u32>;

// group(1) — frame-constant
@group(1) @binding(0) var<uniform>             uniforms:      FrameUniforms;
@group(1) @binding(1) var<storage, read>       nodes:         array<CopcGpuNode>;
@group(1) @binding(2) var<storage, read_write> selectedSlots: array<atomic<u32>>; // bitfield
@group(1) @binding(3) var<storage, read_write> queueCounts:   array<atomic<u32>>; // per-depth counters

const NO_SLOT: u32 = 0xFFFFFFFFu;

// ── Helpers ────────────────────────────────────────────────────────────────

fn aabbInFrustum(minX: f32, minY: f32, minZ: f32,
                 maxX: f32, maxY: f32, maxZ: f32) -> bool {
  for (var i = 0u; i < 6u; i++) {
    let p  = uniforms.planes[i];
    let px = select(minX, maxX, p.x >= 0.0);
    let py = select(minY, maxY, p.y >= 0.0);
    let pz = select(minZ, maxZ, p.z >= 0.0);
    if (p.x * px + p.y * py + p.z * pz + p.w < 0.0) { return false; }
  }
  return true;
}

fn selectNode(slot: u32) {
  let wordIdx = slot >> 5u;
  let bitMask = 1u << (slot & 31u);
  atomicOr(&selectedSlots[wordIdx], bitMask);
}

// ── Main ───────────────────────────────────────────────────────────────────

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx        = gid.x;
  let waveIndex  = uniforms.waveIndex;
  let inputCount = atomicLoad(&queueCounts[waveIndex]);
  if (idx >= inputCount) { return; }

  let nodeId = workQueueIn[idx];
  let node   = nodes[nodeId];

  // ── Frustum cull ────────────────────────────────────────────────────────
  if (!aabbInFrustum(node.bboxMinX, node.bboxMinY, node.bboxMinZ,
                     node.bboxMaxX, node.bboxMaxY, node.bboxMaxZ)) {
    return;
  }

  // ── Screen-space error ─────────────────────────────────────────────────
  let cx   = (node.bboxMinX + node.bboxMaxX) * 0.5;
  let cy   = (node.bboxMinY + node.bboxMaxY) * 0.5;
  let cz   = (node.bboxMinZ + node.bboxMaxZ) * 0.5;
  let clip = uniforms.viewProj * vec4<f32>(cx, cy, cz, 1.0);
  // clip.w check removed: UTM-scale coordinates cause f32 catastrophic cancellation
  // making clip.w appear ≤ 0 for valid in-frustum nodes. Use abs() as safety guard.
  let safeW = max(abs(clip.w), 0.0001);

  let screenError = (node.error * uniforms.focalLength) / (safeW * 2.0);

  var allChildrenAbsent = true;
  for (var c = 0u; c < 8u; c++) {
    if (node.children[c] != NO_SLOT) { allChildrenAbsent = false; break; }
  }

  // ── LOD decision (additive) ──────────────────────────────────────────────
  if (node.atlasSlot != NO_SLOT) {
    selectNode(node.atlasSlot);
  }
  if (screenError >= uniforms.lodThreshold && !allChildrenAbsent) {
    for (var c = 0u; c < 8u; c++) {
      let childId = node.children[c];
      if (childId == NO_SLOT) { continue; }
      let outIdx = atomicAdd(&queueCounts[waveIndex + 1u], 1u);
      workQueueOut[outIdx] = childId;
    }
  }
}
