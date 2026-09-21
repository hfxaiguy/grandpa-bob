/**
 * Bot session resume — continuations survive Agent restarts.
 *
 *   1. A waiting conversation persists to <workspace>/logs/sessions.json.
 *   2. A *new* Agent (simulated restart) resumes mid-tree: the checkpoint
 *      routes the next input into the paused .human() slot, not a fresh tree.
 *   3. Switching the pattern file shape drops the stored session (fresh tree)
 *      and still delivers the message into the new tree.
 *   4. A stale/missing checkpoint falls back to a fresh run instead of
 *      throwing — the message is delivered, never swallowed by the pause.
 *   5. clear() empties sessions.json.
 *
 * Mock model handler, no network. Run: npm run test:sessions
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-sessions-"));
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const sessionsFile = path.join(ws, "logs", "sessions.json");

const PATTERN = `export default function ({ Tree }) {
  return Tree.name("relay")
    .model("cheap")
    .human("a")
    .emit((m) => ({ text: "A:" + String(m.branch.a ?? "") }))
    .human("b")
    .emit((m) => ({ text: "B:" + String(m.branch.b ?? "") }));
}\n`;
await fs.writeFile(path.join(ws, "patterns", "relay.mjs"), PATTERN);

const handler = async () => ({ content: "mock-answer", reasoning: null, tool_calls: [] });
const models = { cheap: { model: "cheap", handler } } as any;
const tools = new ToolRegistry(ws, ["ls"]);
const mkAgent = () =>
  new Agent({ models, workspace: ws, tools, patternName: () => "relay" });
const readSessions = async () =>
  JSON.parse(await fs.readFile(sessionsFile, "utf8"));

// ── 1. first turn pauses, continuation persisted ──
{
  const agent = mkAgent();
  const r1 = await agent.run("k", "hello");
  assert.equal(r1.status, "waiting");
  const s = await readSessions();
  assert.equal(typeof s.k?.continuation, "string", "continuation persisted");
  assert.equal(typeof s.k?.pattern, "string", "pattern hash persisted");
  console.log("1. waiting turn persisted to sessions.json");
}

// ── 2. restart resumes mid-tree (input lands in the paused .human("a")) ──
{
  const agent = mkAgent(); // simulated restart: fresh instance, same workspace
  assert.equal(agent.hasContinuation("k"), true, "continuation loaded from disk");
  const emitted: unknown[] = [];
  const r2 = await agent.run("k", "world", (v) => emitted.push(v));
  assert.equal(r2.status, "waiting", "still paused — now at .human(b)");
  assert.deepEqual(emitted, [{ text: "A:world" }], "resumed into .human(a), not a fresh tree");
  console.log("2. restarted agent resumed the tree at the paused slot");
}

// ── 3. pattern shape change drops the stale session ──
{
  await fs.writeFile(
    path.join(ws, "patterns", "relay.mjs"),
    PATTERN.replace('.human("b")', '.human("b").emit(() => ({ text: "mid" })).human("c2")'),
  );
  await new Promise((r) => setTimeout(r, 5)); // bust the import cache-buster
  const agent = mkAgent();
  const before = (await readSessions()).k.pattern;
  const emitted: unknown[] = [];
  const r = await agent.run("k", "again", (v) => emitted.push(v));
  assert.equal(r.status, "waiting");
  assert.deepEqual(emitted, [{ text: "A:again" }], "message delivered into the fresh tree");
  const after = (await readSessions()).k.pattern;
  assert.notEqual(after, before, "pattern hash updated after session was dropped");
  console.log("3. edited pattern started a fresh tree, old session dropped");
}

// ── 4. stale checkpoint in sessions.json falls back to a fresh run ──
{
  const s = await readSessions();
  s.stale = { continuation: "2099-01-01_00-00-00-9:99", pattern: s.k.pattern };
  await fs.writeFile(sessionsFile, JSON.stringify(s));
  const agent = mkAgent();
  assert.equal(agent.hasContinuation("stale"), true);
  const emitted: unknown[] = [];
  const r = await agent.run("stale", "hi", (v) => emitted.push(v));
  assert.equal(r.status, "waiting", "stale checkpoint recovered as fresh tree");
  assert.deepEqual(emitted, [{ text: "A:hi" }], "the message is delivered, not swallowed");
  assert.notEqual((await readSessions()).stale.continuation, "2099-01-01_00-00-00-9:99");
  console.log("4. missing checkpoint caught, fresh tree started, message delivered");
}

// ── 5. clear() persists an empty session map ──
{
  const agent = mkAgent();
  agent.clear("k");
  const s = await readSessions();
  assert.equal(s.k, undefined);
  console.log("5. clear() emptied sessions.json");
}

console.log("sessions-resume-test: all assertions passed");
