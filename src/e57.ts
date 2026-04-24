/**
 * pointflow/e57 — E57 format support (ASTM E2807).
 *
 * E57 is the ISO standard output format of professional scanners (Leica, FARO, Trimble, Matterport).
 * Import this subpath to load .e57 files. The parser is inlined into the worker blob —
 * no separate fetch is required.
 *
 * Note: E57 requires full-file buffering (random access). Large files may have high
 * initial memory usage before any points are emitted.
 *
 * Usage:
 *   import { createE57Loader } from "pointflow/e57";
 *   <PointCloud src="/scan.e57" loaderFactory={createE57Loader} />
 *
 * Or with the hook directly:
 *   import { createE57Loader } from "pointflow/e57";
 *   const { status } = usePointCloud(src, { loaderFactory: createE57Loader });
 */

export { createE57Worker as createE57Loader } from "./parsers/e57-worker-blob";
