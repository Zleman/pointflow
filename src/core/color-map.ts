import type { ColorPalette, RGB } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalize(value: number, min: number, max: number): number {
  if (max <= min) {
    return 0.5;
  }
  return (clamp(value, min, max) - min) / (max - min);
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

// LAS classification → packed R8G8B8 u32 (same encoding as colorMode=2 / "rgb" path)
const _LAS_CLASS_U32: Uint32Array = (() => {
  const t = new Uint32Array(32);
  const s = (i: number, r: number, g: number, b: number) => { t[i] = r | (g << 8) | (b << 16); };
  s(0,  128, 128, 128); // never classified
  s(1,  208, 208, 208); // unassigned
  s(2,  139, 115,  85); // ground
  s(3,  144, 238, 144); // low vegetation
  s(4,   50, 205,  50); // medium vegetation
  s(5,   34, 139,  34); // high vegetation
  s(6,  169, 169, 169); // building
  s(7,  255,   0, 255); // low noise
  s(8,  128, 128, 128); // reserved
  s(9,   65, 105, 225); // water
  s(10, 139,   0,   0); // rail
  s(11, 255, 165,   0); // road surface
  s(12, 128, 128, 128); // reserved
  s(13, 255, 215,   0); // wire guard
  s(14, 255, 215,   0); // wire conductor
  s(15, 255,  69,   0); // transmission tower
  s(16, 255, 215,   0); // wire connector
  s(17, 112, 128, 144); // bridge deck
  s(18, 255, 105, 180); // high noise
  for (let i = 19; i < 32; i++) s(i, 255, 105, 180); // reserved
  return t;
})();

/** Return packed R8G8B8 u32 for a LAS classification integer (clamped 0–31). */
export function lasClassToU32(cls: number): number {
  return _LAS_CLASS_U32[Math.max(0, Math.min(31, cls | 0))];
}

/** Write normalised [0–1] RGB for a LAS classification integer into out[offset..offset+2]. */
export function writeLasClassToRgbBuffer(cls: number, out: Float32Array, offset: number): void {
  const u = _LAS_CLASS_U32[Math.max(0, Math.min(31, cls | 0))];
  out[offset]     = (u & 0xFF) / 255;
  out[offset + 1] = ((u >> 8) & 0xFF) / 255;
  out[offset + 2] = ((u >> 16) & 0xFF) / 255;
}

/** Map a scalar value to an RGB colour using the given palette. Returns 8-bit components (0–255). */
export function mapScalarToRgb(
  value: number,
  min: number,
  max: number,
  palette: ColorPalette = "blue-red"
): RGB {
  const t = normalize(value, min, max);

  if (palette === "grayscale") {
    const g = lerp(0, 255, t);
    return { r: g, g, b: g };
  }

  return {
    r: lerp(30, 240, t),
    g: lerp(80, 60, t),
    b: lerp(240, 40, t)
  };
}

/**
 * Allocation-free scalar mapping for hot paths that write directly into
 * preallocated Float32Array color buffers (normalized 0-1 RGB).
 *
 */
export function writeScalarToRgbBuffer(
  value: number,
  min: number,
  max: number,
  out: Float32Array,
  offset: number,
  palette: ColorPalette = "blue-red"
): void {
  const t = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0.5;
  if (palette === "grayscale") {
    const g = Math.round(255 * t) / 255;
    out[offset] = g;
    out[offset + 1] = g;
    out[offset + 2] = g;
  } else {
    // blue-red palette — matches mapScalarToRgb output
    out[offset]     = Math.round(30  + (240 -  30) * t) / 255;
    out[offset + 1] = Math.round(80  + ( 60 -  80) * t) / 255;
    out[offset + 2] = Math.round(240 + ( 40 - 240) * t) / 255;
  }
}
