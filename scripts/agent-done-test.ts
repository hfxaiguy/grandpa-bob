/**
 * Agent.run must treat tree completion as a normal outcome — not every
 * pattern loops at .human() (e.g. person-scan). Verifies:
 *
 *   1. A one-shot tree (no .human()) completes on the first run:
 *      { status: "done", result } and no continuation is stored.
 *   2. A pause-then-complete tree: run 1 waits at .human(), run 2
 *      completes with the result, and the continuation is dropped so
 *      run 3 starts a fresh tree (waits again).
 *
 * Mock model handler, no network. Run: npm run test:agent-done
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import { ensureRepo } from "../src/tools/git.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-agent-done-"));
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
await ensureRepo(ws);

await fs.writeFile(
  path.join(ws, "patterns", "one-shot.mjs"),
  `export default function ({ Tree }) {
     return Tree.name("one-shot")
       .model("cheap")
       .prompt((m) => [
         { role: "user", content: "reply to: " + String(m.main_input ?? "") },
       ]);
   }\n`,
);
await fs.writeFile(
  path.join(ws, "patterns", "two-step.mjs"),
  `export default function ({ Tree }) {
     return Tree.name("two-step")
       .model("cheap")
       .emit(() => ({ text: "hi" }))
       .human("input_1")
       .prompt((m) => [
         { role: "user", content: "echo: " + String(m.branch.input_1 ?? "") },
       ]);
   }\n`,
);

const handler = async () => ({ content: "mock-answer", reasoning: null, tool_calls: [] });
const models = { cheap: { model: "cheap", handler } } as any;
const tools = new ToolRegistry(ws, ["ls"]);

let patternName = "one-shot";
const agent = new Agent({ models, workspace: ws, tools, patternName: () => patternName });

// ── 1. one-shot tree completes immediately, no throw ──
{
  const res = await agent.run("k1", "hello");
  assert.equal(res.status, "done", "one-shot tree should complete, not throw");
  assert.equal(res.status === "done" && res.result, "mock-answer");
  assert.equal(agent.hasContinuation("k1"), false, "no continuation after completion");
}

// ── 2. pause-then-complete tree ──
patternName = "two-step";
{
  const emitted: unknown[] = [];
  const r1 = await agent.run("k2", "", (v) => emitted.push(v));
  assert.equal(r1.status, "waiting", "should pause at .human(input_1)");
  assert.equal(agent.hasContinuation("k2"), true);
  assert.deepEqual(emitted, [{ text: "hi" }]);

  const r2 = await agent.run("k2", "ping");
  assert.equal(r2.status, "done", "resume should complete the tree");
  assert.match(String(r2.status === "done" && r2.result), /mock-answer/);
  assert.equal(agent.hasContinuation("k2"), false, "continuation dropped after completion");

  // Next message starts a fresh tree — pauses at .human() again.
  const r3 = await agent.run("k2", "");
  assert.equal(r3.status, "waiting", "fresh tree should pause again");
}

await fs.rm(ws, { recursive: true, force: true });
console.log("agent-done-test: all assertions passed");
