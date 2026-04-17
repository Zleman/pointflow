import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(dirname, "../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  version: string;
  homepage?: string;
  repository?: { url?: string };
};
const repoRaw = pkg.repository?.url ?? "";
const repoWeb = repoRaw.replace(/^git\+/, "").replace(/\.git$/, "");

export default defineConfig({
  root: dirname,
  define: {
    __POINTFLOW_PKG_VERSION__: JSON.stringify(pkg.version),
    __POINTFLOW_PKG_HOMEPAGE__: JSON.stringify(pkg.homepage ?? repoWeb),
    __POINTFLOW_PKG_REPO__: JSON.stringify(repoWeb),
  },
  plugins: [react()],
  resolve: {
    alias: [
      { find: "pointflow/copc", replacement: path.resolve(dirname, "../src/copc/index.ts") },
      { find: "pointflow", replacement: path.resolve(dirname, "../src/index.ts") },
    ],
    dedupe: ["three", "three/webgpu"],
  },
  optimizeDeps: {
    include: ["three", "three/webgpu", "@react-three/fiber", "@react-three/drei"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const norm = id.replace(/\\/g, "/");
          if (norm.includes("/copc/")) return "copc";
          if (norm.includes("laz-perf")) return "laz";
          return undefined;
        },
      },
    },
  },
});
