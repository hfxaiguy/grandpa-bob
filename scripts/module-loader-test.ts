/**
 * Browser module loader: ESM re-exports and the host-owned builtins.
 *
 * The loader evaluates workspace modules in a CommonJS-style scope. App
 * barrels use `export { x } from "./x.js"` (contacts, caller-list), which the
 * old transform rewrote as `module.exports.x = x;from "./x.js";` — a syntax
 * error that made the whole tree fail to load in OPFS mode.
 *
 * `node:sqlite` must *resolve* (a stale app's static import should not fail
 * with "cannot resolve module specifier") but throw the actionable
 * host-owned-store message when used.
 *
 * Run: `npm run test:module-loader`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModuleLoader } from "../web/src/agent/module-loader.ts";
import { createNodePlatform } from "../src/platform/node.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-loader-"));
const platform = createNodePlatform(workspace);
const loader = createModuleLoader(platform);

try {
  await writeFile(
    path.join(workspace, "inner.js"),
    'export const a = 1;\nexport const b = 2;\nexport default "A";\n',
  );
  await writeFile(
    path.join(workspace, "more.js"),
    'export const d = 4;\nexport default "ignored";\n',
  );
  await writeFile(path.join(workspace, "extra.js"), "export const x = 7;\n");
  await writeFile(
    path.join(workspace, "mod.js"),
    [
      'export { a, b as c } from "./inner.js";',
      'export { default as innerDefault } from "./inner.js";',
      'export * from "./more.js";',
      'export * as ns from "./extra.js";',
      "export const local = 3;",
      'export default "hi";',
    ].join("\n"),
  );
  await writeFile(
    path.join(workspace, "locals.js"),
    'const one = 1;\nconst two = 2;\nexport { one, two as deuce };\nexport async function load() { return 9; }\n',
  );

  const mod = await loader.load("mod.js");
  assert.equal(mod.a, 1, "named re-export");
  assert.equal(mod.c, 2, "renamed re-export");
  assert.equal(mod.innerDefault, "A", "default re-export");
  assert.equal(mod.d, 4, "export * re-exports named values");
  assert.equal(mod.default, "hi", "export * must not overwrite local default");
  assert.deepEqual(mod.ns, { x: 7 }, "export * as ns");
  assert.equal(mod.local, 3, "local export still works");

  const locals = await loader.load("locals.js");
  assert.equal(locals.one, 1);
  assert.equal(locals.deuce, 2);
  assert.equal(await locals.load(), 9, "export async function works");

  // A stale app may statically import node:sqlite. That must not fail the
  // tree load with a resolution error; opening a database throws the fix.
  await writeFile(
    path.join(workspace, "sqlite-app.js"),
    [
      'import { DatabaseSync } from "node:sqlite";',
      'export function open() { return new DatabaseSync("/tmp/x.db"); }',
    ].join("\n"),
  );
  const sqliteApp = await loader.load("sqlite-app.js");
  assert.throws(
    () => sqliteApp.open(),
    /host-owned[\s\S]*sync the workspace/,
    "node:sqlite resolves to a host-owned stub that throws with the fix",
  );

  // The injected grandma-kat namespace must expose Emit flags to workspace
  // modules too (the same package the worker bundles).
  await writeFile(
    path.join(workspace, "flag.js"),
    'import { Emit, flag } from "grandma-kat";\nexport const el = Emit("input: hi", flag("machine"));\n',
  );
  const flagApp = await loader.load("flag.js");
  assert.deepEqual(flagApp.el.record.flags, ["machine"], "Emit flags survive the browser loader");

  // Unknown bare specifiers still fail loudly, with the specifier named.
  await writeFile(
    path.join(workspace, "bad.js"),
    'import x from "not-a-package";\nexport default x;\n',
  );
  await assert.rejects(
    () => loader.load("bad.js"),
    /cannot resolve module specifier: not-a-package/,
    "unknown bare specifiers still fail",
  );

  console.log(
    "module-loader: re-exports, host-owned node:sqlite stub and unknown-specifier errors OK",
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
