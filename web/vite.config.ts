import { defineConfig } from "vite";

// The browser target is a single-page app plus (later) a Web Worker that hosts
// the agent. COOP/COEP are set now so OPFS-backed WASM SQLite with
// SharedArrayBuffer works when it lands (milestone 2); OPFS itself does not
// require them.
export default defineConfig({
  root: ".",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
