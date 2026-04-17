/**
 * Build script: inline laz-perf WASM + JS worker into src/parsers/_laz-inlined.ts
 *
 * Usage:
 *   node scripts/build-laz-inlined.mjs
 *
 * Reads:
 *   node_modules/laz-perf/lib/worker/laz-perf.js   (ENVIRONMENT_IS_WORKER=true)
 *   node_modules/laz-perf/lib/worker/laz-perf.wasm
 *
 * Writes:
 *   src/parsers/_laz-inlined.ts
 *
 * The generated file is committed so users can run tests without this script.
 * Re-run whenever laz-perf is upgraded.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const wasmPath = join(root, "node_modules/laz-perf/lib/worker/laz-perf.wasm");
const jsPath   = join(root, "node_modules/laz-perf/lib/worker/laz-perf.js");

const wasmBytes  = readFileSync(wasmPath);
const wasmB64    = wasmBytes.toString("base64");
const lazPerfJs  = readFileSync(jsPath, "utf8");

// Use JSON.stringify for both strings: produces a valid TS double-quoted string
// literal with all special chars (backticks, $, \) properly escaped.
const output = `\
// AUTO-GENERATED — do not edit. Run: node scripts/build-laz-inlined.mjs
// Source: node_modules/laz-perf v${JSON.parse(readFileSync(join(root, "node_modules/laz-perf/package.json"), "utf8")).version}
// WASM size: ${Math.round(wasmBytes.length / 1024)} KB  →  Base64: ${Math.round(wasmB64.length / 1024)} KB
// JS size:   ${Math.round(lazPerfJs.length / 1024)} KB
/* eslint-disable */
// @ts-nocheck

/** Base64-encoded laz-perf WASM binary (lib/worker variant, ENVIRONMENT_IS_WORKER=true). */
export const LAZ_PERF_WASM_B64: string = ${JSON.stringify(wasmB64)};

/** laz-perf Emscripten JS wrapper (lib/worker variant). */
export const LAZ_PERF_JS: string = ${JSON.stringify(lazPerfJs)};
`;

const outPath = join(root, "src/parsers/_laz-inlined.ts");
writeFileSync(outPath, output);

console.log(
  `Written: src/parsers/_laz-inlined.ts\n` +
  `  WASM:      ${Math.round(wasmBytes.length / 1024)} KB → ${Math.round(wasmB64.length / 1024)} KB (base64)\n` +
  `  JS:        ${Math.round(lazPerfJs.length / 1024)} KB\n` +
  `  Total:     ~${Math.round((wasmB64.length + lazPerfJs.length) / 1024)} KB inlined`
);
