import React, { useCallback } from "react";
import type { CopcIndex } from "../../copc/copc-types";
import type { RendererBackend, StreamedPointCloudRenderMetrics, AttributePackingMode } from "../../core/types";
import type { AtlasTierConfig } from "../../copc/copc-atlas-manager";
import type { CopcGpuPipelineConfig } from "../../copc/copc-gpu-pipeline";
import { resolveRenderer } from "../../webgpu/capability";
import { WebGPUCopcScene, type CopcSceneRef } from "../WebGPUCopcScene";
import { WebGLCopcScene } from "../WebGLCopcScene";

export interface CopcInnerSceneProps {
  index: CopcIndex | null;
  requestedBackend: RendererBackend;
  sceneRefCallback: (ref: CopcSceneRef) => void;
  onRendererResolved: (b: "webgpu" | "webgl") => void;
  orbitControlsRef?: React.RefObject<any>;
  colorBy?: string;
  frustumCulling: boolean;
  basePointSize: number;
  attributePacking: AttributePackingMode;
  lodThreshold: number;
  maxDepth: number;
  atlasTiers?: AtlasTierConfig[];
  pipelineConfig?: CopcGpuPipelineConfig;
  renderMetricsRef?: React.MutableRefObject<StreamedPointCloudRenderMetrics | null>;
  minOrbitDistance: number;
}

export function CopcInnerSceneRouter(props: CopcInnerSceneProps) {
  const {
    index,
    requestedBackend,
    sceneRefCallback,
    onRendererResolved,
    orbitControlsRef,
    colorBy,
    frustumCulling,
    basePointSize,
    attributePacking,
    lodThreshold,
    maxDepth,
    atlasTiers,
    pipelineConfig,
    renderMetricsRef,
    minOrbitDistance,
  } = props;
  const resolved = resolveRenderer(requestedBackend);
  const handleRendererResolved = useCallback((b: "webgpu" | "webgl") => {
    onRendererResolved(b);
  }, [onRendererResolved]);

  if (resolved === "webgpu") {
    return (
      <WebGPUCopcScene
        index={index}
        maxDepth={maxDepth}
        colorBy={colorBy}
        frustumCulling={frustumCulling}
        basePointSize={basePointSize}
        lodThreshold={lodThreshold}
        pipelineConfig={pipelineConfig}
        renderMetricsRef={renderMetricsRef}
        orbitControlsRef={orbitControlsRef}
        minOrbitDistance={minOrbitDistance}
        onSceneReady={sceneRefCallback}
        onRendererResolved={handleRendererResolved as (b: "webgpu") => void}
      />
    );
  }

  return (
    <WebGLCopcScene
      index={index}
      maxDepth={maxDepth}
      colorBy={colorBy}
      frustumCulling={frustumCulling}
      basePointSize={basePointSize}
      attributePacking={attributePacking}
      lodThreshold={lodThreshold}
      atlasTiers={atlasTiers}
      renderMetricsRef={renderMetricsRef}
      onSceneReady={sceneRefCallback}
      onRendererResolved={handleRendererResolved as (b: "webgl") => void}
    />
  );
}
