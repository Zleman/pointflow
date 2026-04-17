// copc-compact-draw-args.wgsl
//
// Compaction pass: runs once per frame after all traversal waves complete.
// For each atlas slot, reads the selectedSlots bitfield and writes a
// DrawIndirectArgs entry:
//
//   selected → { vertexCount: pointCount * 6,  instanceCount: 1,
//                firstVertex: slot.firstVertex * 6, firstInstance: 0 }
//   not selected → { vertexCount: 0, instanceCount: 0, 0, 0 }
//
// vertexCount = pointCount * 6 because the point sprite shader expands each
// point into 2 triangles (6 vertices) via vertex_index arithmetic.
//
// firstVertex = slot.firstVertex * 6 encodes both the atlas point offset and
// the intra-slot vertex index.  The vertex shader recovers the point index as
// (vertexIndex / 6) + (firstVertex / 6).
//
// Dispatch: ceil(totalSlots / 64) workgroups × 1 × 1.
// Bind group is the same frame-constant group(1) from the traversal pass.

struct SlotDesc {
  firstPoint:   u32,   // index of first point in atlas buffers
  pointCount:   u32,   // number of valid points in this slot
}

// Matches DrawIndirectArgs layout.
struct DrawIndirectArgs {
  vertexCount:   u32,
  instanceCount: u32,
  firstVertex:   u32,
  firstInstance: u32,
}

@group(0) @binding(0) var<storage, read>       selectedSlots: array<u32>;      // bitfield (read)
@group(0) @binding(1) var<storage, read>       slotDescs:     array<SlotDesc>; // per-slot metadata
@group(0) @binding(2) var<storage, read_write> drawArgs:      array<DrawIndirectArgs>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let slot = gid.x;
  let totalSlots = arrayLength(&drawArgs);
  if (slot >= totalSlots) { return; }

  let wordIdx  = slot >> 5u;
  let bitMask  = 1u << (slot & 31u);
  let selected = (selectedSlots[wordIdx] & bitMask) != 0u;

  let desc = slotDescs[slot];

  if (selected && desc.pointCount > 0u) {
    drawArgs[slot].vertexCount   = desc.pointCount * 6u;
    drawArgs[slot].instanceCount = 1u;
    drawArgs[slot].firstVertex   = desc.firstPoint * 6u;
    drawArgs[slot].firstInstance = 0u;
  } else {
    drawArgs[slot].vertexCount   = 0u;
    drawArgs[slot].instanceCount = 0u;
    drawArgs[slot].firstVertex   = 0u;
    drawArgs[slot].firstInstance = 0u;
  }
}
