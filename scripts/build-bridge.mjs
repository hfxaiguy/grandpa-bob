// Bundle the Node bridge peer for the combined channel process.
//
// The browser sync core is written for Vite (extensionless imports, browser
// globals); esbuild lets the same modules run in Node without a second
// implementation. werift stays external (an npm dependency of the repo).
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [path.join(repo, "src/bridge/server.ts")],
  outfile: path.join(repo, "dist/bridge/bridge.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  external: ["werift"],
  logLevel: "warning",
});
console.log("bridge: dist/bridge/bridge.mjs");
