/**
 * Tests for the admin pattern registry: listPatterns must surface only
 * runnable patterns (skip *.test.mjs smoke tests and non-.mjs files) and
 * parse the `// name.mjs — description` header convention. listTreeSources
 * also offers every app/<dir>/tree.mjs under the "app" group, and
 * loadPattern resolves those by directory name.
 * No Telegram token or LLM required. Run: npm run test:patterns
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listPatterns, listTreeSources } from "../src/admin.js";
import { loadPattern } from "../src/pattern-loader.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-patterns-"));
const dir = path.join(ws, "patterns");
await fs.mkdir(dir, { recursive: true });

await fs.writeFile(
  path.join(dir, "agent.mjs"),
  "// agent.mjs — the main agent loop\nexport default function () {}\n",
);
await fs.writeFile(
  path.join(dir, "person-scan.mjs"),
  "// person-scan.mjs — the greeted-person scan tree\nexport default function () {}\n",
);
await fs.writeFile(
  path.join(dir, "person-scan.test.mjs"),
  "// smoke test — must NOT be listed\nimport { test } from 'node:test';\n",
);
await fs.writeFile(path.join(dir, "person-scan.md"), "# notation\n");
await fs.writeFile(path.join(dir, "notes.txt"), "not a pattern\n");

const patterns = await listPatterns(ws);
const names = patterns.map((p) => p.name).sort();

assert.deepEqual(names, ["agent", "person-scan"], "only runnable .mjs patterns are listed");
assert.ok(
  !patterns.some((p) => p.file.endsWith(".test.mjs")),
  "*.test.mjs smoke tests must never be offered as patterns",
);

const scan = patterns.find((p) => p.name === "person-scan")!;
assert.equal(scan.file, "person-scan.mjs");
assert.equal(scan.description, "the greeted-person scan tree");

// Missing patterns dir → empty list, no throw.
assert.deepEqual(await listPatterns(path.join(ws, "nope")), []);

// App trees are selectable too: app/<dir>/tree.mjs, described by tree.md.
await fs.mkdir(path.join(ws, "app", "caller-list"), { recursive: true });
await fs.writeFile(
  path.join(ws, "app", "caller-list", "tree.md"),
  "# Caller-list Tree\n\nThe caller-list tree walks a selected list one at a time.\n",
);
await fs.writeFile(
  path.join(ws, "app", "caller-list", "tree.mjs"),
  'export default function ({ Tree }) { return Tree.name("caller_list").prompt(m => "hi"); }\n',
);
// An app without a tree is tools-only and must not appear.
await fs.mkdir(path.join(ws, "app", "tools-only"), { recursive: true });
await fs.writeFile(path.join(ws, "app", "tools-only", "tools.mjs"), "export const tools = [];\n");

const sources = await listTreeSources(ws);
assert.deepEqual(
  sources.map((s) => s.name),
  ["agent", "person-scan", "caller-list"],
  "patterns first, then app trees",
);
assert.equal(sources.find((s) => s.name === "caller-list")!.group, "app");
assert.equal(sources.find((s) => s.name === "agent")!.group, "patterns");
assert.equal(
  sources.find((s) => s.name === "caller-list")!.description,
  "The caller-list tree walks a selected list one at a time.",
);
assert.ok(!sources.some((s) => s.name === "tools-only"), "apps without a tree are skipped");

// loadPattern resolves patterns first, then app trees by directory name.
const loaded = await loadPattern(ws, "caller-list");
assert.ok(loaded && typeof loaded === "object", "app tree loads by directory name");
await assert.rejects(() => loadPattern(ws, "nope"), /not found/);
await assert.rejects(() => loadPattern(ws, "../escape"), /invalid pattern name/);

await fs.rm(ws, { recursive: true, force: true });
console.log("patterns-test: all assertions passed");
