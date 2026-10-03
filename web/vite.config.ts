import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url));

// The browser target is a single-page app plus (later) a Web Worker that hosts
// the agent. `node:*` aliases let existing NodeNext shared modules bundle
// unchanged, redirected to browser implementations:
//   node:fs      -> OPFS
//   node:path    -> shared pure POSIX shim
//   node:crypto  -> shared pure SHA-256 + WebCrypto
//   node:sqlite  -> sqlite-wasm (milestone 2; currently a throwing stub)
// COOP/COEP are set for OPFS-backed WASM SQLite with SharedArrayBuffer later.
export default defineConfig({
  root: ".",
  // sqlite-wasm locates its .wasm and its OPFS async-proxy worker via
  // import.meta.url; dep pre-bundling would rewrite those to the wrong paths.
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  resolve: {
    alias: {
      "node:fs/promises": shim("node-fs-promises.ts"),
      "node:fs": shim("node-fs-promises.ts"),
      "node:path": shim("node-path.ts"),
      "node:crypto": shim("node-crypto.ts"),
      "node:os": shim("node-os.ts"),
      "node:util": shim("node-util.ts"),
      "node:sqlite": shim("node-sqlite.ts"),
      "node:child_process": shim("node-child-process.ts"),
      "node:url": shim("node-url.ts"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
});
