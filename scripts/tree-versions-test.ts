/**
 * Tests for src/tree-versions.ts and the discovery filter in
 * src/tree-sources.ts. Uses a throwaway workspace in the OS temp dir — no
 * network, no LLM. Run: npm run test:tree-versions
 *
 * The model is two files per tree: the editable draft (patterns/<n>.mjs,
 * app/<n>/tree.mjs) and the live `*.prod.mjs`, with ONE `.spec.md` shared by
 * both. Versioned `vN` files are legacy (kept on disk, still resolvable by
 * ref for paused sessions) but are no longer produced.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseTreeBase,
  parsePatternFileName,
  parseAppTreeFileName,
  isVersionFileName,
  internalNameFor,
  normalizeRef,
  resolveTreeEntry,
  promoteDraft,
  scanTreeVersions,
} from "../src/tree-versions.js";
import { listTreeSources, listPatterns } from "../src/tree-sources.js";
import { loadPattern, splitTreeRef } from "../src/pattern-loader.js";

// ── filename parsing ──────────────────────────────────────────────────
assert.deepEqual(parseTreeBase("trunk"), { logical: "trunk", version: null, prod: false });
assert.deepEqual(parseTreeBase("trunk.v1"), { logical: "trunk", version: "v1", prod: false });
assert.deepEqual(parseTreeBase("trunk.v1.prod"), { logical: "trunk", version: "v1", prod: true });
assert.deepEqual(parseTreeBase("trunk.prod"), { logical: "trunk", version: null, prod: true });
assert.deepEqual(parseTreeBase("random_enrich.v2"), {
  logical: "random_enrich",
  version: "v2",
  prod: false,
});
assert.deepEqual(parseTreeBase("foo.bar"), { logical: "foo.bar", version: null, prod: false });

assert.equal(parsePatternFileName("trunk.test.mjs"), null);
assert.equal(parsePatternFileName("notes.txt"), null);
assert.equal(parsePatternFileName("trunk.v1.prod.mjs")?.version, "v1");
assert.deepEqual(parseAppTreeFileName("tree.v2.prod.mjs"), { version: "v2", prod: true });
assert.deepEqual(parseAppTreeFileName("tree.prod.mjs"), { version: null, prod: true });
assert.equal(parseAppTreeFileName("tools.mjs"), null);
assert.equal(parseAppTreeFileName("tree.test.mjs"), null);

assert.equal(isVersionFileName("trunk.mjs"), false);
assert.equal(isVersionFileName("trunk.prod.mjs"), true);
assert.equal(isVersionFileName("trunk.v1.mjs"), true);
assert.equal(isVersionFileName("trunk.v1.prod.mjs"), true);
assert.equal(isVersionFileName("trunk.test.mjs"), false);

assert.equal(internalNameFor("trunk", null), "trunk");
assert.equal(internalNameFor("trunk", "v3"), "trunk.v3");
assert.equal(normalizeRef(undefined), "prod");
assert.equal(normalizeRef("@v2"), "v2");
assert.equal(normalizeRef("draft"), "draft");
assert.deepEqual(splitTreeRef("trunk"), { logical: "trunk" });
assert.deepEqual(splitTreeRef("trunk@v2"), { logical: "trunk", ref: "v2" });
assert.deepEqual(splitTreeRef("app@draft"), { logical: "app", ref: "draft" });

// ── a throwaway workspace ─────────────────────────────────────────────
const ws = await fs.mkdtemp(path.join(os.tmpdir(), "bob-tree-versions-"));
const patternsDir = path.join(ws, "patterns");
const contactsDir = path.join(ws, "app", "contacts");
await fs.mkdir(patternsDir, { recursive: true });
await fs.mkdir(contactsDir, { recursive: true });

// Plain tree defs (no grandma-kat import) so the loader can be exercised from
// an OS temp dir without a node_modules lookup.
const TRUNK_V1 = `// trunk.mjs — main assistant\nexport default { kind: "tree", name: "trunk", children: [] };\n`;
await fs.writeFile(path.join(patternsDir, "trunk.mjs"), TRUNK_V1);
await fs.writeFile(
  path.join(contactsDir, "tree.mjs"),
  `// tree.mjs — contacts\nexport default { kind: "tree", name: "contacts", children: [] };\n`,
);

try {
  // Discovery: drafts listed once, nothing prod yet.
  let sources = await listTreeSources(ws);
  const trunk0 = sources.find((s) => s.name === "trunk")!;
  assert.equal(trunk0.draft, true);
  assert.deepEqual(trunk0.versions, []);
  assert.equal(trunk0.prod, null);
  assert.deepEqual(
    sources.map((s) => s.name).sort(),
    ["contacts", "trunk"],
  );

  // promoteDraft copies the draft to the bare `.prod`; the draft stays put and
  // no spec is ever written (one spec per logical).
  const promoted = await promoteDraft(ws, "trunk");
  assert.deepEqual(promoted, { logical: "trunk", file: "patterns/trunk.prod.mjs" });
  assert.ok(await fs.stat(path.join(patternsDir, "trunk.prod.mjs")));
  assert.ok(await fs.stat(path.join(patternsDir, "trunk.mjs")), "the draft stays editable");
  assert.equal(await fileExists(path.join(patternsDir, "trunk.prod.spec.md")), false);
  assert.equal(await fileExists(path.join(patternsDir, "trunk.v1.mjs")), false);

  // Discovery filters prod files out of the tree list.
  const listed = await listPatterns(ws);
  assert.deepEqual(
    listed.map((p) => p.name).sort(),
    ["trunk"],
  );
  sources = await listTreeSources(ws);
  const trunk = sources.find((s) => s.name === "trunk")!;
  assert.equal(trunk.draft, true);
  assert.equal(trunk.prod, "prod", "a bare .prod reports as 'prod'");

  // Resolution: default/prod → the bare prod; draft → the draft.
  const prod = await resolveTreeEntry(ws, "trunk");
  assert.equal(prod?.file, "patterns/trunk.prod.mjs");
  assert.equal(prod?.prod, true);
  assert.equal(prod?.version, null);
  assert.equal(prod?.internalName, "trunk");
  const draftRef = await resolveTreeEntry(ws, "trunk", "draft");
  assert.equal(draftRef?.file, "patterns/trunk.mjs");
  assert.equal(await resolveTreeEntry(ws, "trunk", "v99"), null);
  assert.equal(await resolveTreeEntry(ws, "nope"), null);

  // A bare `.prod` wins over a legacy versioned prod (the enrich-profile case).
  await fs.writeFile(path.join(patternsDir, "trunk.v3.prod.mjs"), TRUNK_V1 + "// v3\n");
  const stillBare = await resolveTreeEntry(ws, "trunk");
  assert.equal(stillBare?.file, "patterns/trunk.prod.mjs", "bare prod wins the prod slot");
  const cat = (await scanTreeVersions(ws)).find((c) => c.logical === "trunk")!;
  assert.equal(cat.prodVersion, null, "the catalog reports the bare prod");
  assert.deepEqual(cat.versions, ["v3"]);

  // Legacy versioned files still resolve by ref (for paused sessions).
  const v3 = await resolveTreeEntry(ws, "trunk", "v3");
  assert.equal(v3?.file, "patterns/trunk.v3.prod.mjs");
  assert.equal(v3?.internalName, "trunk.v3");

  // One spec per logical: the spec resolves from the logical name for EVERY
  // ref, and a versioned spec file is ignored.
  await fs.writeFile(path.join(patternsDir, "trunk.spec.md"), "# trunk spec\n");
  assert.equal((await resolveTreeEntry(ws, "trunk"))?.specFile, "patterns/trunk.spec.md");
  assert.equal((await resolveTreeEntry(ws, "trunk", "draft"))?.specFile, "patterns/trunk.spec.md");
  assert.equal((await resolveTreeEntry(ws, "trunk", "v3"))?.specFile, "patterns/trunk.spec.md");
  await fs.writeFile(path.join(patternsDir, "trunk.v3.spec.md"), "# v3 spec\n");
  assert.equal(
    (await resolveTreeEntry(ws, "trunk", "v3"))?.specFile,
    "patterns/trunk.spec.md",
    "one spec, even for a legacy ref",
  );

  // App trees: the prod lives next to tree.mjs as tree.prod.mjs.
  await fs.writeFile(path.join(contactsDir, "tree.spec.md"), "# contacts spec\n");
  const appPromoted = await promoteDraft(ws, "contacts");
  assert.equal(appPromoted.file, "app/contacts/tree.prod.mjs");
  assert.ok(await fs.stat(path.join(contactsDir, "tree.prod.mjs")));
  const appResolved = await resolveTreeEntry(ws, "contacts");
  assert.equal(appResolved?.file, "app/contacts/tree.prod.mjs");
  assert.equal(appResolved?.specFile, "app/contacts/tree.spec.md");

  // Loader: the default resolves the prod; refs pick the right file.
  assert.equal((await loadPattern(ws, "trunk")).name, "trunk"); // default = prod
  assert.equal((await loadPattern(ws, "trunk@draft")).name, "trunk");
  assert.equal((await loadPattern(ws, "trunk@v3")).name, "trunk.v3");
  assert.equal((await loadPattern(ws, "contacts")).name, "contacts");
  await assert.rejects(() => loadPattern(ws, "trunk@v99"), /failed to load pattern/);
  await assert.rejects(() => loadPattern(ws, "nope"), /failed to load pattern/);
  assert.equal(internalNameFor("trunk", null), "trunk");
  assert.equal(internalNameFor("trunk", "v3"), "trunk.v3");

  console.log("tree-versions-test: all assertions passed");
} finally {
  await fs.rm(ws, { recursive: true, force: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
