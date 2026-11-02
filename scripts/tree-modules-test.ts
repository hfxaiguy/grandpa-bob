/**
 * Child-module guards — the shared half of in-place tree-module editing.
 *
 * A tree's helper `.mjs` files (site_walk, tools, src/*) are ordinary code,
 * not trees. The addressability + confinement rules live in the shared
 * `web/src/tree-files.ts` (the browser worker imports the same module), so
 * this test drives them directly:
 *
 *   1. listModuleFiles names only real child modules: top-level and nested,
 *      never the tree file, node_modules, hidden files, symlinks or a
 *      sub-app's own folder.
 *   2. resolveModuleEntry returns null for the tree file, a missing module,
 *      a `..` escape, an absolute path, or a symlink planted in the app.
 *   3. modulePathFor rejects every unsafe shape by construction.
 *
 * The hash-guarded write surface above these guards lives in
 * `web/src/tree-context.ts` and is covered by `scripts/tree-context-test.ts`.
 * This file keeps the shared addressability/confinement rules.
 *
 * No network. Run: `npm run test:tree-modules`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listModuleFiles, modulePathFor, resolveModuleEntry } from "../web/src/tree-files.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-modules-"));
const app = path.join(root, "app", "demo");
await fs.mkdir(path.join(app, "src"), { recursive: true });
await fs.mkdir(path.join(app, "node_modules"), { recursive: true });
await fs.mkdir(path.join(app, "app", "child"), { recursive: true });
const outside = path.join(root, "outside.mjs");
await fs.writeFile(path.join(app, "tree.prod.mjs"), "// ## demo: app/demo/tree.prod.mjs\nexport default 1;\n");
await fs.writeFile(path.join(app, "site_walk.mjs"), "export const walk = () => 1;\n");
await fs.writeFile(path.join(app, "src", "ingest.mjs"), "export const ingest = () => 2;\n");
await fs.writeFile(path.join(app, "node_modules", "dep.mjs"), "export const dep = 3;\n");
await fs.writeFile(path.join(app, ".hidden.mjs"), "export const h = 4;\n");
await fs.writeFile(path.join(app, "app", "child", "deep.mjs"), "export const d = 5;\n");
await fs.writeFile(outside, "export const escaped = 6;\n");
await fs.symlink(outside, path.join(app, "link.mjs"));

try {
  // 1. listing
  const mods = await listModuleFiles(root, "demo");
  assert.deepEqual(mods, ["site_walk.mjs", "src/ingest.mjs"], "only real child modules are listed");

  // 2. resolution
  const resolved = await resolveModuleEntry(root, "demo", "site_walk.mjs");
  assert.ok(resolved, "a real module resolves");
  assert.equal(resolved.file, path.join("app", "demo", "site_walk.mjs"));
  assert.match(await fs.readFile(path.join(root, resolved.file), "utf8"), /walk/);
  assert.equal(await resolveModuleEntry(root, "demo", "tree.prod.mjs"), null, "a tree file is not a child module");
  assert.equal(await resolveModuleEntry(root, "demo", "nope.mjs"), null, "a missing module resolves null");
  assert.equal(await resolveModuleEntry(root, "demo", "link.mjs"), null, "a symlink escape is not addressable");
  assert.equal(await resolveModuleEntry(root, "nope", "x.mjs"), null, "an unknown app resolves null");

  // 3. path confinement (by construction — no filesystem involved)
  const rejects = (m: string) => assert.equal(modulePathFor("demo", m), null, `should reject ${m}`);
  rejects("../outside.mjs");
  rejects("src/../../outside.mjs");
  rejects("/tmp/outside.mjs");
  rejects("config.js");
  rejects("README.md");
  rejects(".hidden.mjs");
  rejects("src/.cache/x.mjs");
  rejects("node_modules/dep.mjs");
  rejects("app/child/deep.mjs");
  assert.ok(modulePathFor("demo", "src/ingest.mjs"), "nested src modules are addressable");

  console.log("tree-modules: shared guards passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(0);
