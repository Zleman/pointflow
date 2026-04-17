import { describe, expect, it } from "vitest";
import { Plane, Vector3 } from "three";

describe("pass-all frustum planes (frustumCulling=false)", () => {
  const IDENTITY_PLANES: Plane[] = Array.from(
    { length: 6 },
    () => new Plane(new Vector3(0, 1, 0), 1e9),
  );

  it.each([
    [0, 0, 0],
    [9, 6, 9],
    [-9, -6, -9],
    [1000, -1000, 1000],
    [-9999, 9999, -9999],
  ] as [number, number, number][])(
    "passes point (%d, %d, %d) — distanceToPoint > 0",
    (x, y, z) => {
      const point = new Vector3(x, y, z);
      for (const plane of IDENTITY_PLANES) {
        expect(plane.distanceToPoint(point)).toBeGreaterThan(0);
      }
    },
  );
});

describe("canvas initial camera position from effectiveHalfsize", () => {
  function deriveInitialCamera(effectiveHalfsize: number) {
    if (effectiveHalfsize <= 0) return undefined;
    return {
      position: [
        effectiveHalfsize,
        effectiveHalfsize * 0.5,
        effectiveHalfsize,
      ] as [number, number, number],
    };
  }

  it("returns undefined when effectiveHalfsize is 0 (file mode, no data yet)", () => {
    expect(deriveInitialCamera(0)).toBeUndefined();
  });

  it("returns a position tuple when effectiveHalfsize > 0", () => {
    const result = deriveInitialCamera(15);
    expect(result).not.toBeUndefined();
    expect(result!.position).toHaveLength(3);
  });

  it("places camera outside mock data bounding sphere (radius ≈ 9.2)", () => {
    const MOCK_DATA_RADIUS = 9.2;
    const result = deriveInitialCamera(15)!;
    const [x, y, z] = result.position;
    const dist = Math.sqrt(x * x + y * y + z * z);
    expect(dist).toBeGreaterThan(MOCK_DATA_RADIUS * 1.5);
  });

  it("scales linearly with halfsize", () => {
    const a = deriveInitialCamera(10)!;
    const b = deriveInitialCamera(20)!;
    expect(b.position[0]).toBe(a.position[0] * 2);
    expect(b.position[1]).toBe(a.position[1] * 2);
    expect(b.position[2]).toBe(a.position[2] * 2);
  });

  it("y component is half the x/z to give a slight above-horizon vantage", () => {
    const result = deriveInitialCamera(15)!;
    const [x, y, z] = result.position;
    expect(y).toBe(x * 0.5);
    expect(y).toBe(z * 0.5);
  });

  it("demo stream halfsize 30 gives camera distance > mock data diameter", () => {
    const MOCK_DIAMETER = 18.4;
    const result = deriveInitialCamera(30)!;
    const [x, y, z] = result.position;
    const dist = Math.sqrt(x * x + y * y + z * z);
    expect(dist).toBeGreaterThan(MOCK_DIAMETER);
  });
});

describe("stream demo halfsize calibration", () => {
  const STREAM_HALFSIZE = 30;
  const MOCK_DATA_SPIRAL_RADIUS = 9.2;
  const MOCK_DATA_HEIGHT = 6;

  it("halfsize exceeds max data dimension", () => {
    expect(STREAM_HALFSIZE).toBeGreaterThan(MOCK_DATA_SPIRAL_RADIUS);
    expect(STREAM_HALFSIZE).toBeGreaterThan(MOCK_DATA_HEIGHT);
  });

  it("far clip (halfsize * 10) comfortably contains the data", () => {
    const far = STREAM_HALFSIZE * 10;
    expect(far).toBeGreaterThan(MOCK_DATA_SPIRAL_RADIUS * 5);
  });

  it("orbit maxDistance (halfsize * 3) >= AutoFrameCamera target distance", () => {
    const maxDist = STREAM_HALFSIZE * 3;
    const autoFrameLinear = MOCK_DATA_SPIRAL_RADIUS * 2 * 2.5;
    const autoFrameCamDist = autoFrameLinear * Math.sqrt(3);
    expect(maxDist).toBeGreaterThanOrEqual(autoFrameCamDist);
  });
});
