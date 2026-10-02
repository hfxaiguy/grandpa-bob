/**
 * Nested versioned ports — From('inner', version('v1')) in a BOB tree.
 *
 * A pattern pins a nested tree's snapshot; the host's loadTree resolves the
 * operator ref (inner@v1) from disk at run time, exactly as it would for a
 * dynamically loaded tree tool. Editing the inner draft afterwards must not
 * change what the pinned port runs.
 *
 * Mock model, no network. Run: npm run test:tree-nested
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import { snapshotTree } from "../src/tree-versions.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-nested-version-"));
const patterns = path.join(ws, "patterns");
await fs.mkdir(patterns, { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

const INNER = (tag = "hi") => `export default function ({ Tree, name, Model, Needs, Return }) {
  return Tree(
    name("inner"),
    Model("cheap"),
    Needs("input"),
    Return((m) => "echo:${tag}:" + String(m.input)),
  );
}
`;
await fs.writeFile(path.join(patterns, "inner.mjs"), INNER("draft"));

const OUTER = `export default function ({ Tree, name, From, version, Needs, Return }) {
  return Tree(
    name("outer"),
    Needs("input"),
    From("inner", version("v1")),
    Return((m) => m.inner),
  );
}
`;
await fs.writeFile(path.join(patterns, "outer.mjs"), OUTER);

// Snapshot the inner draft as v1 (a candidate; no prod needed).
const snap = await snapshotTree(ws, "inner");
assert.equal(snap.version, "v1");
assert.ok(await fs.stat(path.join(patterns, "inner.v1.mjs")));

const handler = async () => ({ content: "mock", reasoning: null, tool_calls: [] });
const models = { cheap: { model: "cheap", handler } } as any;
const tools = new ToolRegistry(ws, ["ls"]);
const mkAgent = () => new Agent({ models, workspace: ws, tools, patternName: () => "outer" });

const r = await mkAgent().run("n", "hi");
assert.equal(r.status, "done", "outer runs to completion");
assert.equal((r as { result?: unknown }).result, "echo:draft:hi", "pinned v1 ran");

// Edit the draft; the pinned port still runs v1.
await fs.writeFile(path.join(patterns, "inner.mjs"), INNER("edited"));
const r2 = await mkAgent().run("n2", "hi");
assert.equal((r2 as { result?: unknown }).result, "echo:draft:hi", "v1 file is immutable to draft edits");

// A nested port pinned to a version that does not exist fails clearly.
await fs.writeFile(
  path.join(patterns, "outer2.mjs"),
  OUTER.replace(`version("v1")`, `version("v9")`).replace(`name("outer")`, `name("outer2")`),
);
const missing = new Agent({ models, workspace: ws, tools, patternName: () => "outer2" });
await assert.rejects(() => missing.run("n3", "hi"), /inner@v9.*not registered|not found/);

await fs.rm(ws, { recursive: true, force: true });
console.log("tree-nested-version-test: all assertions passed");
