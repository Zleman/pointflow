export function generateSpiralXYZ(count: number): string {
  const lines: string[] = ["x y z intensity"];
  for (let i = 0; i < count; i++) {
    const arm = (i % 2) * Math.PI;
    const t = Math.random();
    const r = t * 2 + Math.random() * 0.15;
    const theta = arm + t * Math.PI * 4;
    const x = (r * Math.cos(theta) + (Math.random() - 0.5) * 0.25).toFixed(5);
    const y = ((Math.random() - 0.5) * 0.3).toFixed(5);
    const z = (r * Math.sin(theta) + (Math.random() - 0.5) * 0.25).toFixed(5);
    const intensity = (1 - t * 0.8 + Math.random() * 0.1).toFixed(4);
    lines.push(`${x} ${y} ${z} ${intensity}`);
  }
  return lines.join("\n");
}

function hsvToRgb255(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function generateRainbowXYZ(count: number): string {
  const lines: string[] = ["x y z red green blue"];
  for (let i = 0; i < count; i++) {
    const arm = (i % 2) * Math.PI;
    const t = i / count;
    const angle = t * Math.PI * 30 + arm;
    const radius = 0.6 + 0.15 * Math.sin(t * Math.PI * 8);
    const x = (radius * Math.cos(angle) + (Math.random() - 0.5) * 0.06).toFixed(5);
    const y = ((t - 0.5) * 5 + (Math.random() - 0.5) * 0.06).toFixed(5);
    const z = (radius * Math.sin(angle) + (Math.random() - 0.5) * 0.06).toFixed(5);
    const hue = (t * 360) % 360;
    const [r, g, b] = hsvToRgb255(hue, 1, 1);
    lines.push(`${x} ${y} ${z} ${r} ${g} ${b}`);
  }
  return lines.join("\n");
}
