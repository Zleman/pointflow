import React, { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  Box3,
  Frustum,
  Matrix4,
  PerspectiveCamera,
  Vector3,
} from "three";
import type {
  CopcFileFrameMetrics,
  CopcFileStaticMeta,
  CopcFileViewSnapshot,
  RendererBackend,
  StreamedPointCloudRenderMetrics,
} from "../core/types";

const _mat = new Matrix4();
const _frustum = new Frustum();
const _box = new Box3();
const _min = new Vector3();
const _max = new Vector3();
const _closest = new Vector3();
function orbitDistanceToTarget(camera: PerspectiveCamera, controls: unknown): number {
  if (controls && typeof controls === "object" && "target" in controls) {
    const t = (controls as { target: Vector3 }).target;
    return camera.position.distanceTo(t);
  }
  return 0;
}

function cameraInsideAabb(
  px: number, py: number, pz: number,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): boolean {
  return px >= min[0] && px <= max[0]
    && py >= min[1] && py <= max[1]
    && pz >= min[2] && pz <= max[2];
}

function farthestCornerDistance(
  px: number, py: number, pz: number,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): number {
  let far = 0;
  for (let i = 0; i < 8; i++) {
    const x = (i & 1) ? max[0] : min[0];
    const y = (i & 2) ? max[1] : min[1];
    const z = (i & 4) ? max[2] : min[2];
    const d = Math.hypot(px - x, py - y, pz - z);
    if (d > far) far = d;
  }
  return far;
}

export interface CopcFileMetricsBridgeProps {
  staticMetaRef: React.MutableRefObject<CopcFileStaticMeta | null>;
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  fileViewSnapshotRef?: React.MutableRefObject<CopcFileViewSnapshot | null>;
  loadStatsRef: React.MutableRefObject<{ tilesFetched: number; tilesTotal: number; progress: number }>;
  viewParamsRef?: React.MutableRefObject<{
    vpMatrix: number[];
    cameraPos: [number, number, number];
    cameraVelocity: [number, number, number];
    frameTimeMs: number;
  } | null>;
  lodThreshold: number;
  frustumCulling: boolean;
  basePointSize: number;
  colorBy?: string;
  requestedBackend: RendererBackend;
  activeBackend: "webgpu" | "webgl";
}

export function CopcFileMetricsBridge(props: CopcFileMetricsBridgeProps) {
  const {
    staticMetaRef,
    renderMetricsRef,
    fileViewSnapshotRef,
    loadStatsRef,
    viewParamsRef,
    lodThreshold,
    frustumCulling,
    basePointSize,
    colorBy,
    requestedBackend,
    activeBackend,
  } = props;

  const { camera, controls, size } = useThree();
  const propsRef = useRef(props);
  propsRef.current = props;
  const vpScratch = useRef(new Float32Array(16));
  const prevCamPosRef = useRef<[number, number, number] | null>(null);

  useFrame((_, delta) => {
    const st = staticMetaRef.current;
    if (!st) return;

    const cam = camera as PerspectiveCamera;
    const px = cam.position.x;
    const py = cam.position.y;
    const pz = cam.position.z;
    const min = st.bboxMin;
    const max = st.bboxMax;
    const ctr = st.center;

    const centerDist = Math.hypot(px - ctr[0], py - ctr[1], pz - ctr[2]);
    const orbitDist = orbitDistanceToTarget(cam, controls);

    _min.set(min[0], min[1], min[2]);
    _max.set(max[0], max[1], max[2]);
    _box.set(_min, _max);
    _box.clampPoint(cam.position, _closest);
    const closestDist = cam.position.distanceTo(_closest);
    const farDist = farthestCornerDistance(px, py, pz, min, max);
    const inside = cameraInsideAabb(px, py, pz, min, max);

    _mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_mat);
    const frustumHits = _frustum.intersectsBox(_box);

    if (viewParamsRef) {
      const prev = prevCamPosRef.current;
      const invDt = delta > 0 ? 1 / delta : 0;
      const vx = prev ? (px - prev[0]) * invDt : 0;
      const vy = prev ? (py - prev[1]) * invDt : 0;
      const vz = prev ? (pz - prev[2]) * invDt : 0;
      prevCamPosRef.current = [px, py, pz];
      vpScratch.current.set(_mat.elements as unknown as ArrayLike<number>);
      viewParamsRef.current = {
        vpMatrix: vpScratch.current as unknown as number[],
        cameraPos: [px, py, pz],
        cameraVelocity: [vx, vy, vz],
        frameTimeMs: delta * 1000,
      };
    }

    const distForAngular = Math.max(orbitDist, 1e-6);
    const horizExtent = max[0] - min[0];
    const angularW = inside
      ? Number.NaN
      : (Math.atan2(horizExtent, distForAngular) * 2 * 180) / Math.PI;

    const vFovRad = (cam.fov * Math.PI) / 180;
    const aspect = size.height > 0 ? size.width / size.height : 1;
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
    const cameraHorizontalFovDeg = (hFovRad * 180) / Math.PI;

    const pixelsPerMeterAtOrbitTarget =
      size.height / (2 * distForAngular * Math.tan(vFovRad / 2));

    const rm = renderMetricsRef?.current;
    const ls = loadStatsRef.current;
    const p = propsRef.current;

    const frame: CopcFileFrameMetrics = {
      cameraToCenterM: centerDist,
      orbitToCameraM: orbitDist,
      cameraToBboxClosestM: closestDist,
      cameraToBboxFarthestM: farDist,
      cameraInsideDatasetBbox: inside,
      centerDistanceMinusClosestM: centerDist - closestDist,
      orbitDistanceMinusClosestM: orbitDist - closestDist,
      frustumIntersectsBbox: frustumHits,
      bboxAngularWidthHorizDeg: angularW,
      cameraHorizontalFovDeg,
      pixelsPerMeterAtOrbitTarget,
      viewportCssWidth: size.width,
      viewportCssHeight: size.height,
      cameraFovDeg: cam.fov,
      cameraNear: cam.near,
      cameraFar: cam.far,
      lodThreshold: p.lodThreshold,
      frustumCulling: p.frustumCulling,
      basePointSize: p.basePointSize,
      colorBy: p.colorBy ?? "",
      renderedPoints: rm?.renderedPoints ?? 0,
      effectiveLodLevel: rm?.effectiveLodLevel ?? 0,
      fps: rm?.fps ?? 0,
      frameTimeMs: rm?.frameTimeMs ?? 0,
      tilesFetched: ls.tilesFetched,
      tilesTotal: ls.tilesTotal,
      loadProgress: ls.progress,
      requestedBackend: p.requestedBackend,
      activeBackend: p.activeBackend,
    };

    const snapRef = fileViewSnapshotRef;
    if (snapRef) {
      snapRef.current = {
        capturedAtIso: new Date().toISOString(),
        static: st,
        frame,
      };
    }
  });

  return null;
}
