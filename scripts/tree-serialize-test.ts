/**
 * Tests for src/tree-serialize.ts: build a Tree with the real grandma-kat
 * builder and assert the JSON shape the tree-panel UI consumes — paths that
 * match runtime branch_path, gates, models/tools, and per-kind details.
 * No network or LLM required. Run: npm run test:tree
 */
import assert from "node:assert/strict";
// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree, when, goto, max } from "grandma-kat";
import { serializeTree, fnSnippet } from "../src/tree-serialize.js";

const isYes = (v: unknown) => typeof v === "string" && /^\s*yes\b/i.test(v.trim());

const builder = Tree.name("person-scan")
  .model("cheap")
  .model(when((m: any) => m.branch?.big), "strong")
  .tools("read_file")
  .emit(() => ({ text: "Hi. This is grandpa-bob" }))
  .human("input_1")
  .branch(
    Tree.name("scan_input").prompt("does input_1 mention a person?"),
  )
  .prompt("named_prompt", (m: any) => [{ role: "user", content: String(m.branch.input_1) }])
  .prompt("static_msgs", [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ])
  .branch(
    when((m: any) => isYes(m.branch.scan_input)),
    Tree.name("summarize_people")
      .prompt((m: any) => [
        { role: "system", content: "extract" },
        { role: "user", content: String(m.branch.input_1) },
      ])
      .check((m: any) => !!m.branch, goto("main_check", max(5)))
      .until(goto("named_prompt"), (m: any) => !m.error, max(12)),
  )
  .memory("seen", (m: any, cur: any) => [...(cur ?? []), m.prev?.[0]]);

// The builder itself (not just .def) must serialize.
const t = serializeTree(builder);

assert.equal(t.kind, "tree");
assert.equal(t.name, "person-scan");
assert.equal(t.path, "person-scan");

// models/tools rules, gated and ungated
assert.equal(t.models.length, 2);
assert.deepEqual(
  t.models.map((r) => r.value),
  ["cheap", "strong"],
);
assert.equal(t.models[0].when, null);
assert.match(t.models[1].when ?? "", /^when /);
assert.deepEqual(t.tools[0].value, ["read_file"]);

const byName = (n: string) => t.children.find((c) => c.name === n);

// emit: unnamed, keeps the parent path, carries the fn snippet
const emit = t.children.find((c) => c.kind === "emit")!;
assert.equal(emit.path, "person-scan");
assert.match(String(emit.fn), /grandpa-bob/);

// human pause
const human = byName("input_1")!;
assert.equal(human.kind, "human");
assert.equal(human.path, "person-scan/input_1");

// branch without a gate → nested tree keeps path alignment with branch_path
const scan = byName("scan_input") as any;
assert.equal(scan.kind, "branch");
assert.equal(scan.path, "person-scan/scan_input");
assert.equal(scan.gate, null);
assert.equal(scan.tree.path, "person-scan/scan_input");
assert.equal(scan.tree.children[0].text, "does input_1 mention a person?");

// named prompt with a function body → fn snippet
const named = byName("named_prompt") as any;
assert.equal(named.kind, "prompt");
assert.equal(named.path, "person-scan/named_prompt");
assert.match(named.fn, /role.*user|m\.branch\.input_1/);

// static message-array prompt → serialized messages
const staticMsgs = byName("static_msgs") as any;
assert.equal(staticMsgs.kind, "prompt");
assert.deepEqual(
  staticMsgs.messages.map((m: any) => [m.role, m.content]),
  [["system", "sys"], ["user", "hi"]],
);

// gated branch → gate text + nested children paths
const summarize = byName("summarize_people") as any;
assert.equal(summarize.kind, "branch");
assert.match(summarize.gate, /^when .*isYes/);
assert.equal(summarize.tree.path, "person-scan/summarize_people");
const inner = summarize.tree.children;
assert.equal(inner[0].kind, "prompt");
assert.match(inner[0].fn, /extract/); // function prompt → source snippet
// check with goto+max flow
assert.equal(inner[1].kind, "check");
assert.equal(inner[1].flow, "goto main_check (max 5)");
// until with goto target and max
assert.equal(inner[2].kind, "until");
assert.equal(inner[2].loop, "goto named_prompt max 12");

// memory write leaf
const mem = byName("seen") as any;
assert.equal(mem.kind, "memory");
assert.equal(mem.path, "person-scan/seen");
assert.ok(mem.fn);

// fnSnippet basics
assert.equal(fnSnippet(null), null);
assert.equal(fnSnippet("nope"), null);
assert.equal(fnSnippet(() => 42)?.replace(/\s+/g, ""), "()=>42");
const long = fnSnippet(new Function(`return "${"x".repeat(400)}"`))!;
assert.ok(long.length <= 161 && long.endsWith("\u2026"), `snippet should be capped, got ${long.length}`);

// serializeTree rejects non-trees
assert.throws(() => serializeTree({ kind: "nope" }), TypeError);
assert.throws(() => serializeTree(null), TypeError);

// The real workspace pattern (if present) must serialize without throwing.
const { loadPattern } = await import("../src/pattern-loader.js");
const ws = process.env.WORKSPACE_DIR || `${process.env.HOME}/grandma-workspace`;
try {
  const tree = await loadPattern(ws, "person-scan");
  const s = serializeTree(tree);
  assert.equal(s.name, "person-scan");
  assert.ok(s.children.length >= 4);
} catch (e: any) {
  if (!/failed to load pattern/.test(e.message)) throw e;
  console.log("(workspace person-scan pattern not present — skipped live check)");
}

console.log("tree-serialize-test: all assertions passed");
