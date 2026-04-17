// Compute shader: frustum cull + GPU LOD + compact visible points into output buffers.
// C – GPU LOD: distant points skipped at stride 2 (lodFarDist threshold).
// D – atomicAdd per visible thread (simpler and faster than workgroup prefix scan
//     at typical visible fractions on current GPU hardware).
// Importance stochastic gate: PCG hash gives each point a per-frame random
//         float; only points whose normalized importance ≥ hashF are included.

struct Uniforms {
  viewProj        : mat4x4<f32>,         // offset   0 (64 bytes)
  planes          : array<vec4<f32>, 6>, // offset  64 (96 bytes)
  pointCount      : u32,                  // offset 160
  attrMin         : f32,                  // offset 164
  attrMax         : f32,                  // offset 168
  colorMode       : u32,                  // offset 172
  pointSizePixels : f32,                  // offset 176
  viewportWidth   : f32,                  // offset 180
  viewportHeight  : f32,                  // offset 184
  lodFarDist      : f32,                  // offset 188 (C: far-LOD distance threshold)
  cameraPos       : vec4<f32>,            // offset 192 (C: camera world position, w unused)
  // Unified Importance Engine
  importanceSamplingEnabled : u32,        // offset 208
  frameSeed                 : u32,        // offset 212
  importanceMin             : f32,        // offset 216
  importanceMax             : f32,        // offset 220
  fovStrength               : f32,        // offset 224 (foveated importance boost)
  // Temporal time window
  nowRelEpoch               : f32,        // offset 228
  timeWindowMs              : f32,        // offset 232
  timeWindowEnabled         : u32,        // offset 236
}

@group(0) @binding(0) var<storage, read>       srcPos       : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       srcAttr      : array<f32>;
@group(0) @binding(2) var<storage, read_write> visiblePos   : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> visibleAttr  : array<f32>;
@group(0) @binding(4) var<storage, read_write> indirect     : array<atomic<u32>>;
@group(0) @binding(5) var<storage, read>       srcTimestamp : array<f32>;
@group(1) @binding(0) var<uniform>             uniforms     : Uniforms;

fn frustumTest(pos: vec3<f32>) -> bool {
  for (var i = 0u; i < 6u; i++) {
    let pl = uniforms.planes[i];
    if (dot(pl.xyz, pos) + pl.w < 0.0) {
      return false;
    }
  }
  return true;
}

// PCG hash — high-quality 1D → 1D mixing.
fn pcg(v: u32) -> u32 {
  var x = v * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (x >> 22u) ^ x;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= uniforms.pointCount) { return; }

  let pos  = srcPos[idx];
  let attr = srcAttr[idx];

  // Discard points older than timeWindowMs when the temporal window is active.
  if (uniforms.timeWindowEnabled == 1u) {
    if (uniforms.nowRelEpoch - srcTimestamp[idx] > uniforms.timeWindowMs) { return; }
  }

  // GPU LOD — skip every other point when camera is beyond lodFarDist.
  let dist    = length(pos.xyz - uniforms.cameraPos.xyz);
  let lodStep = select(1u, 2u, dist > uniforms.lodFarDist);
  if (idx % lodStep != 0u) { return; }

  // Importance stochastic gate — proportional sampling via PCG hash.
  if (uniforms.importanceSamplingEnabled == 1u) {
    let range   = uniforms.importanceMax - uniforms.importanceMin;
    var normImp = select(1.0, clamp((attr - uniforms.importanceMin) / range, 0.0, 1.0), range > 0.001);

    // Foveated importance — boost points near screen centre.
    // fovRadius = 0.3 NDC (~30% from centre); fovBoost ∈ [1, 1+fovStrength].
    if (uniforms.fovStrength > 0.0) {
      let clip = uniforms.viewProj * vec4<f32>(pos.xyz, 1.0);
      if (clip.w > 0.0) {
        let ndcX       = clip.x / clip.w;
        let ndcY       = clip.y / clip.w;
        let distSq     = ndcX * ndcX + ndcY * ndcY;
        let fovBoost   = 1.0 + uniforms.fovStrength * exp(-distSq / 0.09);
        normImp = clamp(normImp * fovBoost, 0.0, 1.0);
      }
    }

    let hashVal = pcg(idx ^ uniforms.frameSeed);
    let hashF   = f32(hashVal) * (1.0 / 4294967296.0);
    if (hashF > normImp) { return; }
  }

  if (!frustumTest(pos.xyz)) { return; }

  let slot = atomicAdd(&indirect[1], 1u);
  visiblePos[slot]  = pos;
  visibleAttr[slot] = attr;
}
