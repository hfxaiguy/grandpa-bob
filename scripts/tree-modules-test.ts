/**
 * Child-module context — the guarded surface knit uses to edit a tree's
 * helper `.mjs` files (site_walk, tools, src/*) in place.
 *
 *   1. listModules names only real child modules: top-level and nested, never
 *      the tree file, node_modules, hidden files, symlinks or a sub-app's
 *      own folder.
 *   2. loadModule returns source + hash; a tree file or a missing module is
 *      exists:false.
 *   3. saveModule writes in place, but refuses a stale base_hash and refuses
 *      anything that resolves outside the app's folder (including `..`,
 *      absolute paths, and symlinks planted in the app).
 *
 * No network. Run: npm run test:tree-modules
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeTreeContext } from "../src/tree-context.js";
import { modulePathFor, resolveModuleEntry } from "../src/tree-files.js";

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

const ctx = makeTreeContext(root);

// 1. listing
const mods = await ctx.listModules({ name: "demo" });
assert.deepEqual(mods, ["site_walk.mjs", "src/ingest.mjs"], "only real child modules are listed");

// 2. load
const loaded = await ctx.loadModule({ name: "demo", module: "site_walk.mjs" });
assert.equal(loaded.exists, true);
assert.match(loaded.source, /walk/);
assert.ok(loaded.hash);
assert.equal((await ctx.loadModule({ name: "demo", module: "tree.prod.mjs" })).exists, false);
assert.equal((await ctx.loadModule({ name: "demo", module: "nope.mjs" })).exists, false);

// 3. save + hash guard
const saved = await ctx.saveModule({
  name: "demo",
  module: "site_walk.mjs",
  base_hash: loaded.hash,
  source: "export const walk = () => 42;\n",
});
assert.equal(saved.file, path.join("app", "demo", "site_walk.mjs"));
assert.match(await fs.readFile(path.join(app, "site_walk.mjs"), "utf8"), /42/);
await assert.rejects(
  ctx.saveModule({ name: "demo", module: "site_walk.mjs", base_hash: loaded.hash, source: "export const walk = () => 0;\n" }),
  /changed while it was being edited/,
);

// 4. path confinement
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
assert.equal(await resolveModuleEntry(root, "demo", "link.mjs"), null, "a symlink escape is not addressable");
assert.equal(await resolveModuleEntry(root, "nope", "x.mjs"), null, "an unknown app resolves null");

await fs.rm(root, { recursive: true, force: true });
console.log("tree-modules: all guards passed");
