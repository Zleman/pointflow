import React, { useEffect, useLayoutEffect, useRef } from "react";
import { Box3, Vector3 } from "three";
import { useThree } from "@react-three/fiber";
import type { OrbitControls } from "@react-three/drei";

type OrbitControlsHandle = React.ComponentRef<typeof OrbitControls>;

export function CameraFitEffect({ halfsize }: { halfsize: number }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.far = halfsize * 10;
    camera.near = Math.max(0.01, halfsize * 0.0001);
    camera.updateProjectionMatrix();
  }, [camera, halfsize]);
  return null;
}

export function AutoFrameCamera({
  totalPoints,
  maxCapacity,
  colorBy,
  copySoAForGPU,
  orbitControlsRef,
  progress,
}: {
  totalPoints: number;
  maxCapacity: number;
  colorBy: string | undefined;
  copySoAForGPU: (
    posOut: Float32Array,
    attrOut: Float32Array,
    cbBy: string | undefined
  ) => { count: number; attrMin: number; attrMax: number };
  orbitControlsRef: React.RefObject<OrbitControlsHandle | null>;
  progress: number;
}) {
  const { camera } = useThree();
  const framedRef = useRef(false);

  useEffect(() => {
    if (totalPoints === 0) framedRef.current = false;
  }, [totalPoints]);

  useLayoutEffect(() => {
    if (framedRef.current || progress < 1 || totalPoints <= 0) return;
    const posOut = new Float32Array(maxCapacity * 4);
    const attrOut = new Float32Array(maxCapacity);
    const { count } = copySoAForGPU(posOut, attrOut, colorBy);
    if (count <= 0) return;

    const box = new Box3();
    const tempVec = new Vector3();
    const sampleCount = Math.min(count, 10000);
    const step = Math.max(1, Math.ceil(count / sampleCount));
    for (let i = 0; i < count; i += step) {
      tempVec.set(posOut[i * 4], posOut[i * 4 + 1], posOut[i * 4 + 2]);
      box.expandByPoint(tempVec);
    }

    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = Math.max(maxDim, 1e-6) * 2.5;

    camera.position.set(
      center.x + distance,
      center.y - distance,
      center.z + distance
    );
    camera.lookAt(center);
    const oc = orbitControlsRef.current;
    if (oc) {
      oc.target.copy(center);
      oc.update();
    }
    framedRef.current = true;
    console.log(
      `[Camera] Auto-framed: center=(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}), distance=${distance.toFixed(2)}m`
    );
  }, [totalPoints, maxCapacity, colorBy, copySoAForGPU, camera, orbitControlsRef, progress]);
  return null;
}

export function CameraFitFromPoints({
  totalPoints,
  maxCapacity,
  colorBy,
  copySoAForGPU,
  onHalfsizeReady,
  progress,
}: {
  totalPoints: number;
  maxCapacity: number;
  colorBy: string | undefined;
  copySoAForGPU: (
    posOut: Float32Array,
    attrOut: Float32Array,
    cbBy: string | undefined
  ) => { count: number; attrMin: number; attrMax: number };
  onHalfsizeReady: (halfsize: number) => void;
  progress: number;
}) {
  const fittedRef = useRef(false);

  useEffect(() => {
    if (totalPoints === 0) fittedRef.current = false;
  }, [totalPoints]);

  useLayoutEffect(() => {
    if (fittedRef.current || progress < 1 || totalPoints <= 0) return;

    const posOut = new Float32Array(maxCapacity * 4);
    const attrOut = new Float32Array(maxCapacity);
    const { count } = copySoAForGPU(posOut, attrOut, colorBy);
    if (count <= 0) return;

    const box = new Box3();
    const tempVec = new Vector3();
    const sampleCount = Math.min(count, 10000);
    const step = Math.max(1, Math.ceil(count / sampleCount));

    for (let i = 0; i < count; i += step) {
      tempVec.set(posOut[i * 4], posOut[i * 4 + 1], posOut[i * 4 + 2]);
      box.expandByPoint(tempVec);
    }

    const size = box.getSize(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const halfsize = maxDim / 2;

    onHalfsizeReady(halfsize);
    fittedRef.current = true;

    console.log(
      `[CameraFit] Calculated from ${count} points: size=(${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)}), halfsize=${halfsize.toFixed(2)}m`
    );
  }, [totalPoints, maxCapacity, colorBy, copySoAForGPU, onHalfsizeReady, progress]);

  return null;
}
