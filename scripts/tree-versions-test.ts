/**
 * Tests for src/tree-versions.ts and the discovery filter in
 * src/tree-sources.ts. Uses a throwaway workspace in the OS temp dir — no
 * network, no LLM. Run: npm run test:tree-versions
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
  snapshotTree,
  promoteTree,
  pruneVersions,
  scanTreeVersions,
  listTreeEntries,
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
assert.equal(parseAppTreeFileName("tools.mjs"), null);
assert.equal(parseAppTreeFileName("tree.test.mjs"), null);

assert.equal(isVersionFileName("trunk.mjs"), false);
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
  // Discovery: drafts listed once, no snapshots yet.
  let sources = await listTreeSources(ws);
  const trunk0 = sources.find((s) => s.name === "trunk")!;
  assert.equal(trunk0.draft, true);
  assert.deepEqual(trunk0.versions, []);
  assert.equal(trunk0.prod, null);
  assert.deepEqual(
    sources.map((s) => s.name).sort(),
    ["contacts", "trunk"],
  );

  // Snapshot dedupe: first creates v1, a second identical call returns it.
  const s1 = await snapshotTree(ws, "trunk");
  assert.equal(s1.version, "v1");
  assert.equal(s1.created, true);
  assert.ok(await fs.stat(path.join(patternsDir, "trunk.v1.mjs")));
  const s1b = await snapshotTree(ws, "trunk");
  assert.equal(s1b.version, "v1");
  assert.equal(s1b.created, false);

  // Edit the draft → next snapshot is v2.
  await fs.writeFile(path.join(patternsDir, "trunk.mjs"), TRUNK_V1 + "// tweak\n");
  const s2 = await snapshotTree(ws, "trunk");
  assert.equal(s2.version, "v2");

  // Discovery filters snapshots out of the tree list.
  const listed = await listPatterns(ws);
  assert.deepEqual(
    listed.map((p) => p.name).sort(),
    ["trunk"],
  );
  sources = await listTreeSources(ws);
  const trunk = sources.find((s) => s.name === "trunk")!;
  assert.deepEqual(trunk.versions, ["v1", "v2"]);
  assert.equal(trunk.draft, true);
  assert.equal(trunk.prod, null);

  // Resolution: default is draft when no prod; @v1 is the snapshot; unknown is null.
  const noProd = await resolveTreeEntry(ws, "trunk");
  assert.equal(noProd?.file, "patterns/trunk.mjs");
  assert.equal(noProd?.internalName, "trunk");
  const v1 = await resolveTreeEntry(ws, "trunk", "v1");
  assert.equal(v1?.file, "patterns/trunk.v1.mjs");
  assert.equal(v1?.internalName, "trunk.v1");
  const draftRef = await resolveTreeEntry(ws, "trunk", "draft");
  assert.equal(draftRef?.file, "patterns/trunk.mjs");
  assert.equal(await resolveTreeEntry(ws, "trunk", "v99"), null);
  assert.equal(await resolveTreeEntry(ws, "nope"), null);

  // Promote v2: v2 becomes prod, nothing was prod before.
  const promoted = await promoteTree(ws, "trunk", "v2");
  assert.deepEqual(promoted, { promoted: "v2", demoted: null });
  assert.ok(await fs.stat(path.join(patternsDir, "trunk.v2.prod.mjs")));
  assert.equal(await fileExists(path.join(patternsDir, "trunk.v2.mjs")), false);

  // Default now resolves to the prod snapshot; internal name is still v2.
  const prod = await resolveTreeEntry(ws, "trunk");
  assert.equal(prod?.file, "patterns/trunk.v2.prod.mjs");
  assert.equal(prod?.prod, true);
  assert.equal(prod?.internalName, "trunk.v2");
  const explicitV2 = await resolveTreeEntry(ws, "trunk", "v2");
  assert.equal(explicitV2?.file, "patterns/trunk.v2.prod.mjs");

  // Promote v1: v1 becomes prod and v2 is demoted back to a candidate.
  const swap = await promoteTree(ws, "trunk", "v1");
  assert.deepEqual(swap, { promoted: "v1", demoted: "v2" });
  assert.ok(await fs.stat(path.join(patternsDir, "trunk.v1.prod.mjs")));
  assert.ok(await fs.stat(path.join(patternsDir, "trunk.v2.mjs")));
  const afterSwap = await resolveTreeEntry(ws, "trunk", "v2");
  assert.equal(afterSwap?.file, "patterns/trunk.v2.mjs");
  assert.equal(afterSwap?.internalName, "trunk.v2");

  // Manual rename is observed on the next scan (BOB re-reads the directory).
  const manualDir = await fs.mkdtemp(path.join(os.tmpdir(), "bob-tree-manual-"));
  await fs.mkdir(path.join(manualDir, "patterns"), { recursive: true });
  await fs.writeFile(path.join(manualDir, "patterns", "tree.mjs"), TRUNK_V1);
  await fs.writeFile(path.join(manualDir, "patterns", "tree.v3.mjs"), TRUNK_V1 + "// a\n");
  await fs.rename(
    path.join(manualDir, "patterns", "tree.v3.mjs"),
    path.join(manualDir, "patterns", "tree.v3.prod.mjs"),
  );
  const manual = await scanTreeVersions(manualDir);
  const t = manual.find((c) => c.logical === "tree")!;
  assert.equal(t.hasProd, true);
  assert.equal(t.prodVersion, "v3");
  await fs.rm(manualDir, { recursive: true, force: true });

  // Prune keeps prod + newest N, never prod, and respects protection.
  const keepDir = await fs.mkdtemp(path.join(os.tmpdir(), "bob-tree-prune-"));
  await fs.mkdir(path.join(keepDir, "patterns"), { recursive: true });
  await fs.writeFile(path.join(keepDir, "patterns", "p.mjs"), "// p\n");
  for (let i = 1; i <= 13; i++) {
    if (i === 3) continue; // v3 is the prod snapshot below
    await fs.writeFile(path.join(keepDir, "patterns", `p.v${i}.mjs`), `// p v${i}\n`);
  }
  await fs.writeFile(path.join(keepDir, "patterns", "p.v3.prod.mjs"), "// p v3 prod\n");
  const removedDefault = await pruneVersions(keepDir, "p", 10);
  // prod v3 is kept even though it is outside the newest 10 (v4..v13); only
  // the two oldest candidates fall away.
  assert.deepEqual(removedDefault.sort(), ["v1", "v2"]);
  const entries = (await listTreeEntries(keepDir)).filter((e) => e.logical === "p");
  assert.equal(entries.some((e) => e.version === "v3" && e.prod), true);

  // A tighter keep window removes un-protected old candidates, never prod.
  const removed = await pruneVersions(keepDir, "p", 2, ["v5"]);
  assert.ok(removed.includes("v4"));
  assert.ok(!removed.includes("v3")); // prod
  assert.ok(!removed.includes("v5")); // protected
  assert.ok(await fileExists(path.join(keepDir, "patterns", "p.v3.prod.mjs")));
  await fs.rm(keepDir, { recursive: true, force: true });

  // App trees: snapshot lives next to tree.mjs as tree.vN.mjs.
  const appSnap = await snapshotTree(ws, "contacts");
  assert.equal(appSnap.version, "v1");
  assert.ok(await fs.stat(path.join(contactsDir, "tree.v1.mjs")));
  const appResolved = await resolveTreeEntry(ws, "contacts", "v1");
  assert.equal(appResolved?.file, "app/contacts/tree.v1.mjs");
  assert.equal(appResolved?.internalName, "contacts.v1");

  // Loader: version-qualified internal names, and refs pick the right file.
  // (At this point trunk v1 is prod, v2 is a candidate, draft exists.)
  assert.equal((await loadPattern(ws, "trunk")).name, "trunk.v1"); // default = prod
  assert.equal((await loadPattern(ws, "trunk@v2")).name, "trunk.v2");
  assert.equal((await loadPattern(ws, "trunk@draft")).name, "trunk");
  assert.equal((await loadPattern(ws, "contacts@v1")).name, "contacts.v1");
  await assert.rejects(() => loadPattern(ws, "trunk@v99"), /failed to load pattern/);
  await assert.rejects(() => loadPattern(ws, "nope"), /failed to load pattern/);
  // The draft keeps its bare name; snapshots are namespaced and stable.
  assert.equal(internalNameFor("trunk", null), "trunk");
  assert.equal(internalNameFor("trunk", "v1"), "trunk.v1");

  // Spec pairing: a snapshot captures tree.spec.md as tree.vN.spec.md.
  const specDir = await fs.mkdtemp(path.join(os.tmpdir(), "bob-tree-spec-"));
  await fs.mkdir(path.join(specDir, "patterns"), { recursive: true });
  await fs.writeFile(
    path.join(specDir, "patterns", "demo.mjs"),
    `// demo\nexport default { kind: "tree", name: "demo", children: [] };\n`,
  );
  await fs.writeFile(path.join(specDir, "patterns", "demo.spec.md"), "# demo spec v1\n");

  const d1 = await snapshotTree(specDir, "demo");
  assert.equal(d1.version, "v1");
  assert.equal(d1.spec, "patterns/demo.v1.spec.md");
  assert.equal(await fs.readFile(path.join(specDir, "patterns", "demo.v1.spec.md"), "utf8"), "# demo spec v1\n");

  // Identity is the pair: changing only the spec still mints a new version.
  await fs.writeFile(path.join(specDir, "patterns", "demo.spec.md"), "# demo spec v2\n");
  const d2 = await snapshotTree(specDir, "demo");
  assert.equal(d2.version, "v2");
  assert.equal(d2.created, true);
  assert.equal(await fs.readFile(path.join(specDir, "patterns", "demo.v2.spec.md"), "utf8"), "# demo spec v2\n");

  const cat = (await scanTreeVersions(specDir)).find((c) => c.logical === "demo")!;
  assert.deepEqual(cat.versions, ["v1", "v2"]);
  assert.deepEqual(cat.specVersions, ["v1", "v2"]);
  assert.equal(cat.draftSpec, true);
  const rv1 = await resolveTreeEntry(specDir, "demo", "v1");
  assert.equal(rv1?.specFile, "patterns/demo.v1.spec.md");

  // Promote carries the paired spec along with the .mjs (suffix mirrors).
  assert.deepEqual(await promoteTree(specDir, "demo", "v1"), { promoted: "v1", demoted: null });
  assert.ok(await fileExists(path.join(specDir, "patterns", "demo.v1.prod.mjs")));
  assert.ok(await fileExists(path.join(specDir, "patterns", "demo.v1.prod.spec.md")));
  assert.equal(await fileExists(path.join(specDir, "patterns", "demo.v1.spec.md")), false);

  // Demote moves both files back; prune removes both.
  assert.deepEqual(await promoteTree(specDir, "demo", "v2"), { promoted: "v2", demoted: "v1" });
  assert.ok(await fileExists(path.join(specDir, "patterns", "demo.v2.prod.spec.md")));
  assert.ok(await fileExists(path.join(specDir, "patterns", "demo.v1.spec.md")), "v1 demoted with its spec");
  await pruneVersions(specDir, "demo", 0);
  assert.equal(await fileExists(path.join(specDir, "patterns", "demo.v1.mjs")), false);
  assert.equal(await fileExists(path.join(specDir, "patterns", "demo.v1.spec.md")), false, "pruned spec goes too");
  assert.ok(await fileExists(path.join(specDir, "patterns", "demo.v2.prod.spec.md")), "prod spec kept");
  await fs.rm(specDir, { recursive: true, force: true });

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
