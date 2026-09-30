/**
 * Trees as tools — BOB auto-injects every workspace tree as a callable tool.
 *
 *   1. A pattern can offer a tree by name (.tools("mini")); the model calls
 *      it like any other tool and the tree runs in place.
 *   2. The tool schema comes from the tree's declared needs (required args).
 *   3. A .human() inside the model-called tree suspends the whole run; the
 *      resumed turn continues inside the tree — the prompt round is replayed
 *      from the log, so the model is NOT called again for it. The router
 *      prompt's auto tool loop then continues with a fresh round.
 *   4. Broken app trees are skipped; they cannot break a turn.
 *
 * Mock model handler, no network. Run: npm run test:trees
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-trees-"));
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

const ROUTER = `export default function ({ Tree, name, Model, Tools, Prompt, Emit }) {
  return Tree(
    name("router"),
    Model("cheap"),
    Tools("mini"),
    Prompt("route", (m) => "route:" + String(m.main_input ?? "")),
    Emit((m) => ({ text: "mini-result:" + JSON.stringify(m.raw.branch.route.toolResults[0].result) })),
  );
}\n`;
await fs.writeFile(path.join(ws, "patterns", "router.mjs"), ROUTER);

const MINI = `export default function ({ Tree, name, Needs, Model, Prompt, Human, Memory }) {
  return Tree(
    name("mini"),
    Needs("input"),
    Model("cheap"),
    Prompt((m) => "mini:" + String(m.input ?? "")),
    Human("answer"),
    Memory("out", (m) => "answered:" + String(m.answer)),
  );
}\n`;
await fs.mkdir(path.join(ws, "app", "mini"), { recursive: true });
await fs.writeFile(path.join(ws, "app", "mini", "tree.mjs"), MINI);

// A broken app tree must be skipped, not break the turn.
await fs.mkdir(path.join(ws, "app", "broken"), { recursive: true });
await fs.writeFile(
  path.join(ws, "app", "broken", "tree.mjs"),
  `export default function () { throw new Error("boom"); }\n`,
);

let calls = 0;
const offered: any[][] = [];
const handler = async (_messages: unknown, { tools: toolSchemas }: any = {}) => {
  calls += 1;
  offered.push(toolSchemas ?? []);
  if (calls === 1) {
    return {
      content: "",
      reasoning: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "mini", arguments: JSON.stringify({ input: "banana" }) } },
      ],
    };
  }
  return { content: "mini says banana", reasoning: null, tool_calls: [] };
};

const models = { cheap: { model: "cheap", handler } } as any;
const tools = new ToolRegistry(ws, ["ls"]);
const mkAgent = () => new Agent({ models, workspace: ws, tools, patternName: () => "router" });

// ── 1. the model calls the tree tool; a pause inside suspends the run ──
const agent = mkAgent();
const r1 = await agent.run("k", "please");
assert.equal(r1.status, "waiting", "the tree tool paused at .human('answer') inside mini");
assert.equal(calls, 2, "router prompt + mini prompt, then the pause");
assert.equal(offered[0].length, 1, "the prompt offered exactly the mini tree tool");
assert.equal(offered[0][0].function.name, "mini");
assert.deepEqual(offered[0][0].function.parameters.required, ["input"], "the schema requires the tree's needs");
assert.ok(!offered[0].some((t) => t.function.name === "broken"), "the broken app tree was skipped");

// ── 2. a fresh Agent (restart) resumes inside the tree tool ──
const agent2 = mkAgent();
assert.equal(agent2.hasContinuation("k"), true, "continuation loaded from disk");
const emitted: unknown[] = [];
const r2 = await agent2.run("k", "yes", (v) => emitted.push(v));
assert.equal(r2.status, "done", "mini finished and the router tree completed");
assert.equal(calls, 3, "the router round was replayed, not re-called; the auto loop then ran one fresh round");
assert.deepEqual(emitted, [{ text: 'mini-result:"answered:yes"' }], "the subtree result came back as the tool result");

console.log("tree-tools-test: all assertions passed");
