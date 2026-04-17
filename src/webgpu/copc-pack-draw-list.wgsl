// copc-pack-draw-list.wgsl
//
// Pack pass: runs after the compaction pass, before the render pass.
// Converts the sparse drawArgs array (one entry per atlas slot, many with
// vertexCount=0) into a dense packed list for multiDrawIndirect.
//
// Each thread checks one slot.  If vertexCount > 0 it uses atomicAdd on the
// global draw counter to claim a position in packList and writes the args
// there.  The counter value after all threads complete equals the total
// number of draws, which multiDrawIndirect reads via the drawCount buffer.
//
// Dispatch: ceil(totalSlots / 64) workgroups.

struct DrawIndirectArgs {
  vertexCount:   u32,
  instanceCount: u32,
  firstVertex:   u32,
  firstInstance: u32,
}

@group(0) @binding(0) var<storage, read>           drawArgs:  array<DrawIndirectArgs>;
@group(0) @binding(1) var<storage, read_write>     packList:  array<DrawIndirectArgs>;
@group(0) @binding(2) var<storage, read_write>     drawCount: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let slot = gid.x;
  if (slot >= arrayLength(&drawArgs)) { return; }

  let args = drawArgs[slot];
  if (args.vertexCount == 0u) { return; }

  // Atomically claim the next position in the packed list.
  let idx = atomicAdd(&drawCount[0], 1u);
  packList[idx] = args;
}
