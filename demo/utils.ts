import type { PointChunk, PointRecord } from "pointflow";
import { ATTRIBUTE_PROFILES } from "./constants";
import type { AttributeProfile } from "./constants";

export function makeAttributes(keys: string[]): Record<string, number> {
  const attributes: Record<string, number> = {};
  for (const key of keys) {
    switch (key) {
      case "velocity":
        attributes[key] = Math.random();
        break;
      case "intensity":
        attributes[key] = Math.random();
        break;
      case "temperature":
        attributes[key] = 0.2 + Math.random() * 0.8;
        break;
      case "pressure":
        attributes[key] = 0.1 + Math.random() * 0.9;
        break;
      default:
        attributes[key] = Math.random();
    }
  }
  return attributes;
}

let mockSequence = 0;

export type MockStreamShape = "lorenz" | "spiralGalaxy" | "fibonacciSphere" | "lissajous3d";

// Lorenz ODE integration state - must persist across chunks and reset with the sequence.
let lorenzState = { x: 0.1, y: 0.0, z: 0.0 };

export function resetMockSequence(): void {
  mockSequence = 0;
  lorenzState = { x: 0.1, y: 0.0, z: 0.0 };
}

export function makeMockChunk(
  pointsPerChunk: number,
  attributeProfile: AttributeProfile,
  shape: MockStreamShape = "lorenz"
): PointChunk {
  if (!Number.isFinite(pointsPerChunk)) return { points: [] };
  const safeCount = Math.floor(pointsPerChunk);
  if (safeCount <= 0) return { points: [] };
  const attributeKeys = ATTRIBUTE_PROFILES[attributeProfile].keys;
  const points: PointRecord[] = Array.from({ length: safeCount }, (_, i) => {
    const seq = mockSequence + i;
    let x = 0, y = 0, z = 0;
    const attrs = makeAttributes(attributeKeys);

    if (shape === "lorenz") {
      // Lorenz chaotic attractor - integrate ODE one Euler step per point.
      // Array.from calls the factory in order so lorenzState accumulates correctly.
      const sigma = 10, rho = 28, beta = 8 / 3, dt = 0.006;
      const dx = sigma * (lorenzState.y - lorenzState.x);
      const dy = lorenzState.x * (rho - lorenzState.z) - lorenzState.y;
      const dz = lorenzState.x * lorenzState.y - beta * lorenzState.z;
      lorenzState.x += dx * dt;
      lorenzState.y += dy * dt;
      lorenzState.z += dz * dt;
      x = lorenzState.x * 0.4;
      y = lorenzState.y * 0.4;
      z = (lorenzState.z - 24) * 0.4;
      // Speed at this trajectory point → drives color.
      const speed = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (attrs.velocity !== undefined) attrs.velocity = Math.min(1, speed / 350);
      if (attrs.intensity !== undefined) attrs.intensity = 0.5 + 0.5 * Math.sin(lorenzState.z * 0.12);

    } else if (shape === "spiralGalaxy") {
      // 2-arm logarithmic spiral galaxy. Arms stream outward simultaneously.
      const N_ARMS = 2, PERIOD_PER_ARM = 25_000, MAX_RADIUS = 10, WINDING = 3.5;
      const arm = seq % N_ARMS;
      const armIdx = Math.floor(seq / N_ARMS);
      const rNorm = (armIdx % PERIOD_PER_ARM) / PERIOD_PER_ARM;
      const r = rNorm * MAX_RADIUS;
      const armOffset = (arm / N_ARMS) * Math.PI * 2;
      const spiralAngle = WINDING * rNorm * Math.PI * 2 + armOffset;
      // Angular spread: wide at core, tight at edge.
      const angularSpread = 0.08 + (1 - rNorm) * 0.22;
      const jitterA = (Math.sin(seq * 43.7) + Math.sin(seq * 23.1) * 0.4) * angularSpread;
      const jitterR = Math.sin(seq * 89.3) * 0.5 * (1 - rNorm * 0.5);
      x = (r + jitterR) * Math.cos(spiralAngle + jitterA);
      z = (r + jitterR) * Math.sin(spiralAngle + jitterA);
      // Thin galactic disk; slightly puffier at center.
      y = Math.sin(seq * 127.1) * 0.6 * Math.exp(-rNorm * 3);
      if (attrs.velocity !== undefined) attrs.velocity = 1 - rNorm * 0.8;   // bright core
      if (attrs.intensity !== undefined) attrs.intensity = 0.3 + rNorm * 0.7;

    } else if (shape === "fibonacciSphere") {
      // Fibonacci/golden-angle sphere lattice. Any prefix is already well-distributed
      // so the sphere is recognizable from the very first chunk.
      const SPHERE_TOTAL = 50_000;
      const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
      const idx = seq % SPHERE_TOTAL;
      const yUnit = 1 - (2 * idx) / (SPHERE_TOTAL - 1);   // ∈ [-1, 1]
      const rUnit = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
      const theta = GOLDEN_ANGLE * idx;
      const RADIUS = 8;
      x = rUnit * Math.cos(theta) * RADIUS;
      y = yUnit * RADIUS;
      z = rUnit * Math.sin(theta) * RADIUS;
      if (attrs.velocity !== undefined) attrs.velocity = (yUnit + 1) / 2;   // pole-to-pole gradient
      if (attrs.intensity !== undefined) attrs.intensity = rUnit;            // 0 at poles, 1 at equator

    } else {
      // lissajous3d - 3:2:5 frequency ratios with phase offsets.
      // Irrational-feeling fills 3D space; wraps every PERIOD points.
      const PERIOD = 20_000;
      const t = (seq * Math.PI * 2) / PERIOD;
      x = 8 * Math.sin(3 * t);
      y = 7 * Math.sin(2 * t + Math.PI / 4);
      z = 6 * Math.sin(5 * t + Math.PI / 7);
      if (attrs.velocity !== undefined) attrs.velocity = 0.5 + 0.5 * Math.sin(t * 2);
      if (attrs.intensity !== undefined) attrs.intensity = 0.5 + 0.5 * Math.cos(t * 3);
    }

    return { x, y, z, attributes: attrs };
  });
  mockSequence += safeCount;
  return { points };
}

export function p95FromSorted(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx] ?? 0;
}

export function isDemoRemoteUrlAllowed(urlStr: string, allowedSampleUrls: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const hostOk = new Set(allowedSampleUrls.map((s) => {
    try {
      return new URL(s).hostname;
    } catch {
      return "";
    }
  }));
  hostOk.delete("");
  return hostOk.has(u.hostname);
}

/** True when FileScene should mount CopcPointCloud (HTTPS path or file-picker #.copc.laz hint). */
export function isCopcDatasetUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const hashIdx = lower.indexOf("#");
  const base = hashIdx >= 0 ? lower.slice(0, hashIdx) : lower;
  const hash = hashIdx >= 0 ? lower.slice(hashIdx + 1) : "";
  if (base.includes(".copc.") || base.endsWith(".copc.laz")) return true;
  const h = hash.toLowerCase();
  return h === ".copc.laz" || h === ".copc";
}
