export function packRgbInterleaved(
  attrs: { key: string; values: Float32Array }[],
  count: number,
): Float32Array | null {
  const r = attrs.find((a) => a.key === "red")?.values;
  const g = attrs.find((a) => a.key === "green")?.values;
  const b = attrs.find((a) => a.key === "blue")?.values;
  if (!r || !g || !b) return null;
  let maxVal = 1;
  for (let i = 0; i < count; i++) {
    if (r[i] > maxVal) maxVal = r[i];
    if (g[i] > maxVal) maxVal = g[i];
    if (b[i] > maxVal) maxVal = b[i];
  }
  const scale = maxVal > 255.5 ? 65535 : maxVal > 1.5 ? 255 : 1;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = r[i] / scale;
    out[i * 3 + 1] = g[i] / scale;
    out[i * 3 + 2] = b[i] / scale;
  }
  return out;
}
