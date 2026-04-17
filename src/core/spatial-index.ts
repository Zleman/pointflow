/**
 * Uniform-grid spatial index helpers for the point ring buffer.
 *
 * Pack/unpack 3-D world positions into 30-bit integer cell keys.
 * Cell size: 10 world units. Supported range: ±5120 units per axis (512 cells × 10 units).
 * Points outside this range wrap (aliasing); correctness is preserved because
 * the per-point isVisible check is still applied for boundary cells.
 */

/** World-unit side length of each spatial cell. */
export const CELL_SIZE = 10.0;

/** Bias so negative cell coordinates map to positive key components (supports ±512 cells). */
const CELL_OFFSET = 512;

/**
 * Pack (x, y, z) world-space coordinates into a 30-bit integer cell key.
 * 10 bits per axis: X in bits 0–9, Y in bits 10–19, Z in bits 20–29.
 */
export function cellKey(x: number, y: number, z: number): number {
  const ix = (Math.floor(x / CELL_SIZE) + CELL_OFFSET) & 0x3FF;
  const iy = (Math.floor(y / CELL_SIZE) + CELL_OFFSET) & 0x3FF;
  const iz = (Math.floor(z / CELL_SIZE) + CELL_OFFSET) & 0x3FF;
  return ix | (iy << 10) | (iz << 20);
}

/** Decode a 30-bit cell key back to the world-space centre of that cell. */
export function cellCenter(key: number): [number, number, number] {
  const ix = (key & 0x3FF) - CELL_OFFSET;
  const iy = ((key >> 10) & 0x3FF) - CELL_OFFSET;
  const iz = ((key >> 20) & 0x3FF) - CELL_OFFSET;
  return [(ix + 0.5) * CELL_SIZE, (iy + 0.5) * CELL_SIZE, (iz + 0.5) * CELL_SIZE];
}
