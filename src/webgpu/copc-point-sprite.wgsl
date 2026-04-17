// copc-point-sprite.wgsl
//
// Vertex + fragment shaders for rendering atlas-backed COPC points.
//
// WebGPU has no native point-sprite primitive, so each logical point is
// expanded into two triangles (6 vertices) by the vertex shader using
// vertex_index arithmetic.  The compaction pass encodes firstVertex as
// (atlasPointOffset * 6) so the vertex shader can recover:
//
//   pointIndex = vertex_index / 6          (which atlas point)
//   quadVertex = vertex_index % 6          (0–5, two-triangle quad)
//
// The unit quad offsets (in screen space, ±0.5) are indexed by quadVertex:
//
//   quadVertex  offset
//   0           (-0.5, -0.5)   TL
//   1           ( 0.5, -0.5)   TR
//   2           (-0.5,  0.5)   BL — first triangle
//   3           (-0.5,  0.5)   BL
//   4           ( 0.5, -0.5)   TR
//   5           ( 0.5,  0.5)   BR — second triangle
//
// The fragment shader clips to a circular disk via distance from quad centre,
// producing round point sprites at no additional memory cost.
//
// Color encoding:
//   colorMode 0 → light grey (attrMin == attrMax or no attribute)
//   colorMode 1 → scalar grey ramp (mapped from attrMin–attrMax)
//   colorMode 2 → packed RGBA from atlasColor buffer
//   colorMode 3 → LAS classification colour table

// Dedicated render uniform block (separate GPU buffer from traverse uniforms).
// Layout must match WebGPUCopcScene.tsx _rf32/_ru32 writes (256 B binding).
struct CopcRenderUniforms {
  renderViewProj: mat4x4<f32>,
  viewportWidth:  f32,
  viewportHeight: f32,
  basePointSize:  f32,
  attrMin:        f32,
  attrMax:        f32,
  colorMode:      u32,
}

struct VertexOut {
  @builtin(position) clipPos:   vec4<f32>,
  @location(0)       color:     vec4<f32>,
  @location(1)       quadUv:    vec2<f32>,  // -0.5..0.5 for disk clipping
  @location(2)       pointSize: f32,
}

@group(0) @binding(0) var<storage, read> atlasPos:   array<vec4<f32>>;  // vec4(x,y,z,1)
@group(0) @binding(1) var<storage, read> atlasColor: array<u32>;        // packed RGBA
@group(0) @binding(2) var<storage, read> atlasAttr:  array<f32>;        // scalar attribute
@group(1) @binding(0) var<uniform>       uniforms:   CopcRenderUniforms;

// ── Colour helpers ─────────────────────────────────────────────────────────

// LAS classification colour table (standard 20-class palette).
fn lasClassColor(cls: u32) -> vec3<f32> {
  let c = cls & 31u;
  switch c {
    case  0u: { return vec3<f32>(0.500, 0.500, 0.500); }
    case  1u: { return vec3<f32>(0.800, 0.800, 0.800); }
    case  2u: { return vec3<f32>(0.600, 0.400, 0.200); }
    case  3u: { return vec3<f32>(0.400, 0.700, 0.300); }
    case  4u: { return vec3<f32>(0.200, 0.600, 0.200); }
    case  5u: { return vec3<f32>(0.050, 0.500, 0.050); }
    case  6u: { return vec3<f32>(0.900, 0.100, 0.100); }
    case  7u: { return vec3<f32>(0.000, 0.000, 0.000); }
    case  8u: { return vec3<f32>(1.000, 1.000, 1.000); }
    case  9u: { return vec3<f32>(0.100, 0.400, 0.900); }
    case 10u: { return vec3<f32>(0.600, 0.400, 0.200); }
    case 11u: { return vec3<f32>(0.500, 0.000, 0.500); }
    case 12u: { return vec3<f32>(1.000, 0.000, 1.000); }
    case 17u: { return vec3<f32>(0.700, 0.700, 0.700); }
    default:  { return vec3<f32>(1.000, 0.800, 0.000); }
  }
}

fn unpackColor(packed: u32) -> vec4<f32> {
  let r = f32((packed)       & 0xFFu) / 255.0;
  let g = f32((packed >> 8u) & 0xFFu) / 255.0;
  let b = f32((packed >> 16u) & 0xFFu) / 255.0;
  let a = f32((packed >> 24u) & 0xFFu) / 255.0;
  return vec4<f32>(r, g, b, a);
}

// ── Quad UV table ──────────────────────────────────────────────────────────

fn quadOffset(qi: u32) -> vec2<f32> {
  switch qi {
    case 0u: { return vec2<f32>(-0.5, -0.5); }
    case 1u: { return vec2<f32>( 0.5, -0.5); }
    case 2u: { return vec2<f32>(-0.5,  0.5); }
    case 3u: { return vec2<f32>(-0.5,  0.5); }
    case 4u: { return vec2<f32>( 0.5, -0.5); }
    default: { return vec2<f32>( 0.5,  0.5); }
  }
}

// ── Vertex shader ──────────────────────────────────────────────────────────

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  let pointIndex = vi / 6u;
  let quadVert   = vi % 6u;

  let pos   = atlasPos[pointIndex];
  let clip  = uniforms.renderViewProj * vec4<f32>(pos.xyz, 1.0);
  let depth = clip.w;  // view-space Z (positive = in front)

  // Distance-based point size: larger when close, smaller when far.
  // Clamped to [1, 32] screen pixels.
  let pointSize = clamp(uniforms.basePointSize / max(depth, 0.001), 1.0, 32.0);

  // Expand to screen-space quad.
  let uv       = quadOffset(quadVert);              // ±0.5 in screen space
  let ndcOff   = uv * pointSize / vec2<f32>(uniforms.viewportWidth, uniforms.viewportHeight) * 2.0;
  let ndcPos   = clip.xy / clip.w + ndcOff;
  let finalPos = vec4<f32>(ndcPos * clip.w, clip.z, clip.w);

  // Resolve colour.
  var color = vec4<f32>(0.87843137, 0.87843137, 0.87843137, 1.0);
  if (uniforms.colorMode == 1u) {
    let range = uniforms.attrMax - uniforms.attrMin;
    let t = select(0.5, (atlasAttr[pointIndex] - uniforms.attrMin) / range, range > 0.001);
    let g = mix(0.75, 0.95, clamp(t, 0.0, 1.0));
    color = vec4<f32>(g, g, g, 1.0);
  } else if (uniforms.colorMode == 2u) {
    color = unpackColor(atlasColor[pointIndex]);
  } else if (uniforms.colorMode == 3u) {
    let cls = atlasColor[pointIndex] & 0xFFu;
    color   = vec4<f32>(lasClassColor(cls), 1.0);
  }

  var out: VertexOut;
  out.clipPos   = finalPos;
  out.color     = color;
  out.quadUv    = uv;   // -0.5..0.5
  out.pointSize = pointSize;
  return out;
}

// ── Fragment shader ────────────────────────────────────────────────────────

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  // Circular disk: discard corners of the quad.
  // in.quadUv is ±0.5; unit circle check: dot(uv*2, uv*2) > 1.
  let uv2 = in.quadUv * 2.0;
  if (dot(uv2, uv2) > 1.0) { discard; }

  // Optional soft edge: attenuate alpha near disk boundary.
  let dist = length(uv2);
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);

  return vec4<f32>(in.color.rgb, in.color.a * alpha);
}
