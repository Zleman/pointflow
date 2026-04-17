import type { CopcFileViewSnapshot } from "pointflow";

const PF_VERSION = "0.1.0";

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

export function formatCopcFileReportLines(
  snap: CopcFileViewSnapshot | null,
  extras: {
    fileLabel: string | null;
    fileProgress: number;
    heapMb: number | null;
    userAgent: string;
    gpuLines: string[];
  },
): string[] {
  const lines: string[] = [
    "PointFlow - COPC / file view report",
    `Captured (ISO): ${snap?.capturedAtIso ?? new Date().toISOString()}`,
    `PointFlow package: ${PF_VERSION}`,
    `User agent: ${extras.userAgent}`,
    "",
    "── File source ──",
    `Label: ${extras.fileLabel ?? "-"}`,
    `Load progress (UI): ${(extras.fileProgress * 100).toFixed(1)}%`,
    `JS heap (if available): ${extras.heapMb === null ? "n/a" : `${fmt(extras.heapMb, 1)} MB`}`,
  ];

  if (extras.gpuLines.length > 0) {
    lines.push("", "── GPU (best effort) ──", ...extras.gpuLines);
  }

  if (!snap) {
    lines.push(
      "",
      "── Snapshot ──",
      "No COPC geometry snapshot in memory yet.",
      "Load a COPC dataset and wait until the 3D view is active.",
    );
    return lines;
  }

  const s = snap.static;
  const f = snap.frame;

  lines.push(
    "",
    "── COPC index (static) ──",
    `Source src (truncated): ${s.sourceSrc.length > 120 ? `${s.sourceSrc.slice(0, 120)}…` : s.sourceSrc}`,
    `Index nodes: ${s.indexNodeCount.toLocaleString()} | max tree depth (keys): ${s.maxTreeDepth} | user maxDepth: ${s.maxDepthUser}`,
    `Declared total points (sum of node counts): ${s.declaredTotalPoints.toLocaleString()}${s.declaredTotalPointsCapped ? " (CAPPED - true total > Number.MAX_SAFE_INTEGER)" : ""}`,
    `COPC spacing: ${fmt(s.copcSpacing, 6)} | halfsize (root cube): ${fmt(s.copcHalfsize, 2)} m`,
    `BBox min: ${s.bboxMin.map((x) => fmt(x, 2)).join(", ")}`,
    `BBox max: ${s.bboxMax.map((x) => fmt(x, 2)).join(", ")}`,
    `BBox half-diagonal: ${fmt(s.bboxHalfDiagonalM, 2)} m | cube space diagonal: ${fmt(s.bboxCubeSpaceDiagonalM, 2)} m`,
    `Center: ${s.center.map((x) => fmt(x, 2)).join(", ")}`,
    `GPS range: ${fmt(s.gpsMin, 3)} … ${fmt(s.gpsMax, 3)}`,
    `LAS point format: ${s.lasPointFormat} | record length: ${s.lasPointRecLen} | attrs: ${s.lasAttributeKeys.join(", ") || "-"}`,
    `Cache: max ${s.maxCacheMb} MB | concurrent: ${s.maxConcurrent} | OPFS: ${s.persistCache ? "on" : "off"}`,

    ...(s.hierarchyCompleteness
      ? (() => {
          const h = s.hierarchyCompleteness;
          const depthLines: string[] = Object.entries(h.nodesByDepth)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([depth, count]) => `  Depth ${depth}: ${count.toLocaleString()}`);
          const block: string[] = [
            "",
            "── Hierarchy completeness (index) ──",
            `Total nodes: ${h.totalNodes.toLocaleString()}`,
            `Nodes with children: ${h.nodesWithChildren.toLocaleString()}`,
            `Nodes without children: ${h.nodesWithoutChildren.toLocaleString()}`,
            `Oversize nodes without children: ${h.nodesOversizeNoChildren.toLocaleString()}`,
            `Completeness ratio: ${(h.completenessRatio * 100).toFixed(2)}%`,
            `Max depth found: ${h.maxDepthFound}`,
            "Nodes by depth:",
            ...depthLines,
          ];
          if (h.nodesOversizeNoChildren > 0) {
            block.push(
              "",
              "WARNING: Some oversize nodes lack child entries in the COPC index.",
              "Close-range views may look sparse in those regions.",
              "Consider regenerating COPC with a deeper hierarchy (higher max_depth).",
            );
          }
          return block;
        })()
      : []),

    "",
    "── View / camera / geometry (per frame) ──",
    `Renderer: requested ${f.requestedBackend} | active ${f.activeBackend}`,
    `Viewport CSS: ${Math.round(f.viewportCssWidth)}×${Math.round(f.viewportCssHeight)} px`,
    `Camera FOV: ${fmt(f.cameraFovDeg, 1)}° | near ${fmt(f.cameraNear, 2)} m | far ${fmt(f.cameraFar, 1)} m`,
    `Distance camera → dataset center: ${fmt(f.cameraToCenterM, 2)} m`,
    `Orbit radius (camera → controls target): ${fmt(f.orbitToCameraM, 2)} m`,
    `Distance camera → bbox (closest surface): ${fmt(f.cameraToBboxClosestM, 2)} m`,
    `Distance camera → bbox (farthest corner): ${fmt(f.cameraToBboxFarthestM, 2)} m`,
    `Camera inside dataset bbox: ${f.cameraInsideDatasetBbox ? "yes" : "no"}`,
    `centerDist − closestSurfaceDist: ${fmt(f.centerDistanceMinusClosestM, 2)} m (compare orbit vs hull using rows below)`,
    `orbitDist − closestSurfaceDist: ${fmt(f.orbitDistanceMinusClosestM, 2)} m`,
    `Frustum intersects bbox: ${f.frustumIntersectsBbox ? "yes" : "no"}`,
    `Camera horizontal FOV: ${fmt(f.cameraHorizontalFovDeg, 2)}°`,
    ...(f.cameraInsideDatasetBbox
      ? [
          "Approx horizontal angular width of full bbox (via orbit pivot): n/a - camera is inside the dataset bounds; orbit radius is distance to the pivot, not “meters above the terrain”.",
          "Hint: double-click on the view to move the orbit pivot to the surface under the cursor, then zoom.",
        ]
      : [
          `Approx horizontal angular width of bbox at orbit dist: ${fmt(f.bboxAngularWidthHorizDeg, 2)}°`,
        ]),
    `Vertical pixels per metre at orbit target depth: ${fmt(f.pixelsPerMeterAtOrbitTarget, 3)}`,

    "",
    "── Render / LOD / tiles ──",
    `LOD threshold (screen error): ${fmt(f.lodThreshold, 4)} | frustum culling: ${f.frustumCulling ? "on" : "off"}`,
    `Point size (px): ${fmt(f.basePointSize, 2)} | colorBy: ${f.colorBy || "-"}`,
    `Drawn points (LOD selection): ${f.renderedPoints.toLocaleString()} | effective LOD depth: ${f.effectiveLodLevel}`,
    `FPS: ${fmt(f.fps, 1)} | frame ms: ${fmt(f.frameTimeMs, 2)}`,
    `Tiles fetched: ${f.tilesFetched.toLocaleString()} / ${f.tilesTotal.toLocaleString()} | scheduler progress: ${(f.loadProgress * 100).toFixed(1)}%`,
  );

  return lines;
}

export async function collectGpuReportLines(): Promise<string[]> {
  const gpu = navigator.gpu;
  if (!gpu) return ["WebGPU: not exposed in this context"];
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return ["WebGPU: no adapter"];
    const info = "info" in adapter && adapter.info
      ? adapter.info as { vendor?: string; architecture?: string; device?: string; description?: string }
      : null;
    if (!info) return ["WebGPU: adapter present (adapter info not readable in this browser)"];
    const out: string[] = [`WebGPU device: ${info.device ?? "unknown"}`];
    if (info.vendor) out.push(`Vendor: ${info.vendor}`);
    if (info.architecture) out.push(`Architecture: ${info.architecture}`);
    if (info.description) out.push(`Description: ${info.description}`);
    return out;
  } catch {
    return ["WebGPU: adapter query failed"];
  }
}
