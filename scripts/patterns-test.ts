/**
 * Tests for the admin pattern registry: listPatterns must surface only
 * runnable patterns (skip *.test.mjs smoke tests and non-.mjs files) and
 * parse the `// name.mjs — description` header convention.
 * No Telegram token or LLM required. Run: npm run test:patterns
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listPatterns } from "../src/admin.js";

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

await fs.rm(ws, { recursive: true, force: true });
console.log("patterns-test: all assertions passed");
