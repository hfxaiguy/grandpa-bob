/**
 * The browser host's tree-context write surface.
 *
 * `web/src/tree-context.ts` is what knit reaches through `runtime.context.trees`:
 * list/load/save a tree's single `.prod.mjs`, and list/load/save the existing
 * child `.mjs` modules inside an app folder. The shared addressability and
 * confinement rules live in `web/src/tree-files.ts`; this test drives the
 * guarded surface above them against a temp workspace.
 *
 * Covers: list/load, hash-guarded tree saves, new-app README creation (never
 * overwrite), nested app paths, child-module listing/load/save, stale hashes,
 * tree files/sub-apps/symlinks/non-existent modules, invalid names, and the
 * onWrite hook the worker uses to evict its loaded-tree cache.
 *
 * No network. Run: `npm run test:tree-context`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Call, Register, Return, Tree, knit, name } from "grandma-kat";
import { headerSpecOf, makeTreeContext } from "../web/src/tree-context.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-tree-context-"));
const writes: { name: string; kind: string; module?: string }[] = [];
const ctx = makeTreeContext(root, { onWrite: (change) => writes.push(change) });

const TREE = [
  "// demo tree — prose above the notation header",
  "//",
  "// ## demo: app/demo/tree.prod.mjs",
  "// !! input",
  "// -> run: noop {}",
  "export default 1;",
  "",
].join("\n");
const TREE_EDIT = TREE.replace("export default 1;", "export default 3;");
const FRESH_TREE = "// ## fresh: app/fresh/tree.prod.mjs\nexport default 4;\n";

const app = path.join(root, "app", "demo");
await fs.mkdir(path.join(app, "src"), { recursive: true });
await fs.mkdir(path.join(app, "node_modules"), { recursive: true });
await fs.mkdir(path.join(app, "app", "child"), { recursive: true });
await fs.mkdir(path.join(root, "patterns"), { recursive: true });
const outside = path.join(root, "outside.mjs");
await fs.writeFile(path.join(app, "tree.prod.mjs"), TREE);
await fs.writeFile(path.join(app, "README.md"), "# demo\n\nDemo app.\n\n## Guide\nUse it.\n");
await fs.writeFile(path.join(app, "site_walk.mjs"), "export const walk = () => 1;\n");
await fs.writeFile(path.join(app, "src", "ingest.mjs"), "export const ingest = () => 2;\n");
await fs.writeFile(path.join(app, "node_modules", "dep.mjs"), "export const dep = 3;\n");
await fs.writeFile(path.join(app, ".hidden.mjs"), "export const h = 4;\n");
await fs.writeFile(path.join(app, "config.js"), "export const c = 5;\n");
await fs.writeFile(path.join(app, "app", "child", "deep.mjs"), "export const d = 6;\n");
await fs.writeFile(outside, "export const escaped = 7;\n");
await fs.symlink(outside, path.join(app, "link.mjs"));
await fs.writeFile(
  path.join(root, "patterns", "trunk.prod.mjs"),
  "// trunk.mjs — the trunk\nexport default 8;\n",
);

try {
  // ── list + load ────────────────────────────────────────────────────────
  const listed = await ctx.list();
  assert.deepEqual(
    listed.find((t) => t.name === "demo"),
    { name: "demo", kind: "app", description: "Demo app." },
    "app trees are listed with their README description",
  );
  assert.deepEqual(
    listed.find((t) => t.name === "trunk"),
    { name: "trunk", kind: "pattern", description: "the trunk" },
    "patterns are listed too",
  );

  const loaded = await ctx.load({ name: "demo", kind: "app" });
  assert.equal(loaded.exists, true);
  assert.equal(loaded.kind, "app");
  assert.equal(loaded.file, path.join("app", "demo", "tree.prod.mjs"));
  assert.equal(loaded.module, TREE);
  assert.equal(loaded.spec, headerSpecOf(TREE));
  assert.match(loaded.spec, /^## demo: app\/demo\/tree\.prod\.mjs/);
  assert.match(loaded.hash ?? "", /^[0-9a-f]{64}$/);

  const missing = await ctx.load({ name: "missing", kind: "app" });
  assert.deepEqual(missing, {
    exists: false,
    spec: "",
    module: "",
    hash: null,
    file: null,
    kind: "app",
  });
  assert.equal((await ctx.load({ name: "../escape", kind: "app" })).exists, false);

  // ── tree saves ─────────────────────────────────────────────────────────
  const saved = await ctx.save({
    name: "demo",
    kind: "app",
    base_hash: loaded.hash,
    module: TREE_EDIT,
  });
  assert.deepEqual(saved, {
    name: "demo",
    file: path.join("app", "demo", "tree.prod.mjs"),
    created: false,
  });
  assert.equal(await fs.readFile(path.join(app, "tree.prod.mjs"), "utf8"), TREE_EDIT);
  assert.ok(
    writes.some((w) => w.name === "demo" && w.kind === "app" && w.module === undefined),
    "a tree save notifies the host",
  );

  await assert.rejects(
    ctx.save({ name: "demo", kind: "app", base_hash: loaded.hash, module: TREE }),
    /changed while it was being edited/,
    "a stale tree hash is refused",
  );
  assert.equal(await fs.readFile(path.join(app, "tree.prod.mjs"), "utf8"), TREE_EDIT);

  const fresh = await ctx.save({
    name: "fresh",
    kind: "app",
    module: FRESH_TREE,
    readme: "# fresh\n\nFresh app.\n",
  });
  assert.equal(fresh.created, true);
  assert.equal(await fs.readFile(path.join(root, fresh.file), "utf8"), FRESH_TREE);
  const freshReadme = path.join(root, "app", "fresh", "README.md");
  assert.equal(await fs.readFile(freshReadme, "utf8"), "# fresh\n\nFresh app.\n");

  // An existing README is never overwritten.
  await fs.writeFile(freshReadme, "# hand written\n");
  await ctx.save({
    name: "fresh",
    kind: "app",
    module: FRESH_TREE.replace("export default 4;", "export default 5;"),
    readme: "# generated replacement\n",
  });
  assert.equal(await fs.readFile(freshReadme, "utf8"), "# hand written\n");

  // Dotted app names map to nested folders.
  const nested = await ctx.save({
    name: "demo.child",
    kind: "app",
    module: "// ## demo.child: app/demo/app/child/tree.prod.mjs\nexport default 9;\n",
  });
  assert.equal(nested.created, true);
  assert.equal(
    await fs.readFile(path.join(root, "app", "demo", "app", "child", "tree.prod.mjs"), "utf8"),
    "// ## demo.child: app/demo/app/child/tree.prod.mjs\nexport default 9;\n",
  );

  // A flat folder whose name contains a dot keeps its own file on save.
  const flatDir = path.join(root, "app", "flat.name");
  await fs.mkdir(flatDir, { recursive: true });
  await fs.writeFile(path.join(flatDir, "tree.prod.mjs"), "// ## flat.name\nexport default 10;\n");
  const flatLoaded = await ctx.load({ name: "flat.name", kind: "app" });
  assert.equal(flatLoaded.file, path.join("app", "flat.name", "tree.prod.mjs"));
  const flatSaved = await ctx.save({
    name: "flat.name",
    kind: "app",
    base_hash: flatLoaded.hash,
    module: "// ## flat.name\nexport default 11;\n",
  });
  assert.equal(flatSaved.file, path.join("app", "flat.name", "tree.prod.mjs"));
  assert.equal(
    await fs.readFile(path.join(flatDir, "tree.prod.mjs"), "utf8"),
    "// ## flat.name\nexport default 11;\n",
  );
  await assert.rejects(
    fs.access(path.join(root, "app", "flat", "app", "name", "tree.prod.mjs")),
    "a flat dotted app must not gain a nested twin",
  );

  await assert.rejects(
    ctx.save({ name: "../escape", kind: "app", module: "x" }),
    /not a valid app name/,
    "a path-shaped tree name is refused",
  );
  await assert.rejects(
    ctx.save({ name: "a.b", kind: "pattern", module: "x" }),
    /not a valid pattern name/,
    "a dotted pattern name is refused",
  );
  await assert.rejects(
    ctx.save({ name: "trunk", kind: "app", module: "x" }),
    /is a pattern tree; refusing to save it as app/,
    "a save cannot overwrite the other kind",
  );

  // ── child modules ──────────────────────────────────────────────────────
  assert.deepEqual(
    await ctx.listModules({ name: "demo" }),
    ["site_walk.mjs", "src/ingest.mjs"],
    "only existing top-level/nested .mjs modules are listed",
  );
  assert.deepEqual(await ctx.listModules({ name: "../escape" }), []);

  const moduleLoaded = await ctx.loadModule({ name: "demo", module: "site_walk.mjs" });
  assert.equal(moduleLoaded.exists, true);
  assert.equal(moduleLoaded.source, "export const walk = () => 1;\n");
  assert.equal(moduleLoaded.file, "site_walk.mjs");
  assert.match(moduleLoaded.hash ?? "", /^[0-9a-f]{64}$/);

  const moduleWritten = await ctx.saveModule({
    name: "demo",
    module: "site_walk.mjs",
    base_hash: moduleLoaded.hash,
    source: "export const walk = () => 20;\n",
  });
  assert.deepEqual(moduleWritten, {
    name: "demo",
    module: "site_walk.mjs",
    file: path.join("app", "demo", "site_walk.mjs"),
  });
  assert.equal(
    await fs.readFile(path.join(app, "site_walk.mjs"), "utf8"),
    "export const walk = () => 20;\n",
  );
  assert.ok(
    writes.some((w) => w.name === "demo" && w.module === "site_walk.mjs"),
    "a module save notifies the host",
  );

  await assert.rejects(
    ctx.saveModule({
      name: "demo",
      module: "site_walk.mjs",
      base_hash: moduleLoaded.hash,
      source: "export const walk = () => 99;\n",
    }),
    /changed while it was being edited/,
    "a stale module hash is refused",
  );
  assert.equal(
    await fs.readFile(path.join(app, "site_walk.mjs"), "utf8"),
    "export const walk = () => 20;\n",
  );

  const rejects = async (
    module: string,
    name = "demo",
    expected: RegExp = /not an editable module/,
  ) => {
    await assert.rejects(
      ctx.saveModule({ name, module, source: "export default 0;\n" }),
      expected,
      `saveModule should reject ${name}/${module}`,
    );
  };
  await rejects("tree.prod.mjs");
  await rejects("nope.mjs");
  await rejects("config.js");
  await rejects(".hidden.mjs");
  await rejects("node_modules/dep.mjs");
  await rejects("app/child/deep.mjs");
  await rejects("link.mjs");
  await rejects("../outside.mjs");
  await rejects("/tmp/outside.mjs");
  await rejects("site_walk.mjs", "trunk");
  await rejects("site_walk.mjs", "../escape", /not a valid app name/);

  for (const [name, module] of [
    ["demo", "tree.prod.mjs"],
    ["demo", "nope.mjs"],
    ["demo", "link.mjs"],
    ["trunk", "site_walk.mjs"],
  ] as const) {
    const found = await ctx.loadModule({ name, module });
    assert.deepEqual(
      found,
      { exists: false, source: "", hash: null, file: null },
      `loadModule should not resolve ${name}/${module}`,
    );
  }

  // The exact seam knit uses: a Register's fourth argument is runtime.context.
  const probe = Tree(
    name("tree_context_probe"),
    Register("list_targets", "list the trees", async (_m, _args, _tools, context) => {
      assert.ok(context?.trees?.list, "the register receives runtime.context.trees");
      return context.trees.list();
    }),
    Call("list", "list_targets", () => ({})),
    Return((m) => m.branch.list),
  );
  const out = await knit(probe, {
    models: { default: { model: "mock", handler: async () => ({ content: "" }) } },
    tools: {},
    logger: false,
    context: { trees: ctx },
  });
  assert.ok(Array.isArray(out.result), "list_targets returns the host's tree list");
  assert.ok(
    out.result.some((t: { name?: string }) => t.name === "demo"),
    "the register sees the same workspace the context reads",
  );

  console.log(
    `tree-context: ${listed.length} trees, ${writes.length} writes, guarded tree + module paths all passed`,
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(0);
