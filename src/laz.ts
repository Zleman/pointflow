/**
 * pointflow/laz — opt-in LAZ (compressed LAS) support.
 *
 * Import this subpath when you need to load .laz files. It inlines the
 * laz-perf WASM binary (~210 KB) in the worker blob so no separate fetch
 * is needed — but the cost is only paid by consumers who import this module.
 *
 * Usage:
 *   import { createLazLoader } from "pointflow/laz";
 *   <PointCloud src="/scan.laz" loaderFactory={createLazLoader} />
 *
 * Or with the hook directly:
 *   import { createLazLoader } from "pointflow/laz";
 *   const { status } = usePointCloud(src, { loaderFactory: createLazLoader });
 */

export { createLazWorker as createLazLoader } from "./parsers/laz-worker-blob";
