import { readdir, readFile, writeFile, access } from "fs/promises";
import { join, dirname } from "path";

const RELATIVE = /((?:import|export)[^"']*["'])(\.\.?\/[^"']+)(["'])/g;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function resolveImportPath(fromFile, importPath) {
  const base = join(dirname(fromFile), importPath);
  if (await exists(base + ".js")) return importPath + ".js";
  if (await exists(join(base, "index.js"))) return importPath + "/index.js";
  return importPath + ".js"; // fallback
}

async function processDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return processDir(full);
      if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
        return processFile(full);
      }
    })
  );
}

async function processFile(file) {
  const src = await readFile(file, "utf8");
  const matches = [...src.matchAll(RELATIVE)];
  if (!matches.length) return;

  let out = src;
  for (const m of matches) {
    const [full, prefix, path, suffix] = m;
    if (/\.(js|mjs|cjs|json|wgsl|glsl|css|png|svg)$/.test(path)) continue;
    if (path.includes("?")) continue;
    const resolved = await resolveImportPath(file, path);
    out = out.replace(full, `${prefix}${resolved}${suffix}`);
  }
  if (out !== src) await writeFile(file, out);
}

await processDir("./dist");
console.log("ESM import paths fixed.");
