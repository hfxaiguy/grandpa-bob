/**
 * Pin-on-open — a live session freezes its tree when it opens.
 *
 *   1. A fresh session pins the active ref ("relay@prod") and persists it.
 *   2. Overwriting the `.prod` file mid-session does NOT disturb a live
 *      session: it keeps running the tree it opened on (the in-memory freeze).
 *   3. A restart (a fresh Agent, reading sessions.json) re-loads the tree from
 *      disk; if it changed, the session drops with the "tree changed" notice
 *      and restarts on the active ref.
 *   4. A draft-pinned session behaves the same: frozen within the instance,
 *      dropped after a restart if the draft changed.
 *   5. clearSessionsForLogical only drops that logical's sessions.
 *
 * Mock model handler, no network. Run: npm run test:tree-pinning
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import { promoteDraft } from "../src/tree-versions.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-pinning-"));
const patterns = path.join(ws, "patterns");
await fs.mkdir(patterns, { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const sessionsFile = path.join(ws, "logs", "sessions.json");

/** A two-pause tree factory authored with only the builder surface. */
const treeSrc = (name: string, extra = "") => `export default function ({ Tree, name, Model, Human, Emit }) {
  return Tree(
    name(${JSON.stringify(name)}),
    Model("cheap"),
    Human("a"),
    Emit((m) => ({ text: "A:" + String(m.branch.a ?? "") })),
    Human("b"),
    Emit((m) => ({ text: "B:" + String(m.branch.b ?? "") })),${extra}
  );
}
`;
const SHAPE_EXTRA = `\n    Emit(() => ({ text: "extra" })),`;

const handler = async () => ({ content: "mock-answer", reasoning: null, tool_calls: [] });
const models = { cheap: { model: "cheap", handler } } as any;
const tools = new ToolRegistry(ws, ["ls"]);
const mkAgent = (patternName: string, patternRef?: () => string | undefined) =>
  new Agent({
    models,
    workspace: ws,
    tools,
    patternName: () => patternName,
    ...(patternRef ? { patternRef } : {}),
  });
const readSessions = async () => JSON.parse(await fs.readFile(sessionsFile, "utf8"));
const texts = (emitted: unknown[]) => emitted.map((e) => (e as { text: string }).text);

// ── 1. a fresh session pins the active ref ──
await fs.writeFile(path.join(patterns, "relay.mjs"), treeSrc("relay"));
const promoted = await promoteDraft(ws, "relay");
assert.equal(promoted.file, "patterns/relay.prod.mjs");
assert.ok(await fs.stat(path.join(patterns, "relay.prod.mjs")));
let relay = mkAgent("relay");
{
  const r1 = await relay.run("A", "hello");
  assert.equal(r1.status, "waiting");
  assert.equal((await readSessions()).A.ref, "relay@prod", "the bare prod is the pinned ref");
  console.log("1. fresh session pinned relay@prod");
}

// ── 2. pin-on-open: overwriting .prod mid-session does not disturb ──
{
  await fs.writeFile(path.join(patterns, "relay.prod.mjs"), treeSrc("relay", SHAPE_EXTRA));
  const emitted: unknown[] = [];
  const r2 = await relay.run("A", "world", (v) => emitted.push(v));
  assert.equal(r2.status, "waiting");
  assert.deepEqual(texts(emitted), ["A:world"], "resumed on the frozen tree, no drop notice");
  assert.equal((await readSessions()).A.ref, "relay@prod");
  console.log("2. live session kept the tree it opened on despite a .prod overwrite");
}

// ── 3. a restart after a .prod change drops with the 'tree changed' notice ──
{
  relay = mkAgent("relay"); // fresh instance = restart; reloads relay.prod from disk
  const emitted: unknown[] = [];
  const r3 = await relay.run("A", "three", (v) => emitted.push(v));
  assert.equal(r3.status, "waiting");
  assert.match(texts(emitted)[0], /tree changed since it paused/);
  assert.deepEqual(texts(emitted)[1], "A:three");
  console.log("3. restart after a .prod change dropped and restarted the session");
}

// ── 4. a draft-pinned session: frozen in-instance, dropped after restart ──
{
  await fs.writeFile(path.join(patterns, "drafty.mjs"), treeSrc("drafty"));
  let drafty = mkAgent("drafty", () => "draft");
  const r1 = await drafty.run("D", "one");
  assert.equal(r1.status, "waiting");
  assert.equal((await readSessions()).D.ref, "drafty@draft");

  await fs.writeFile(path.join(patterns, "drafty.mjs"), treeSrc("drafty", SHAPE_EXTRA));
  const emitted: unknown[] = [];
  const r2 = await drafty.run("D", "two", (v) => emitted.push(v));
  assert.equal(r2.status, "waiting");
  assert.deepEqual(texts(emitted), ["A:two"], "the frozen draft is unchanged in-instance");

  drafty = mkAgent("drafty", () => "draft"); // restart
  const emitted2: unknown[] = [];
  await drafty.run("D", "three", (v) => emitted2.push(v));
  assert.match(texts(emitted2)[0], /tree changed since it paused/);
  assert.deepEqual(texts(emitted2)[1], "A:three");
  console.log("4. draft-pinned session froze in-instance and dropped after a restart");
}

// ── 5. clearSessionsForLogical only touches that logical ──
{
  const agent = mkAgent("relay");
  assert.equal(agent.hasContinuation("A"), true);
  assert.equal(agent.hasContinuation("D"), true);
  const cleared = agent.clearSessionsForLogical("relay");
  assert.deepEqual(cleared, ["A"]);
  assert.equal(agent.hasContinuation("A"), false);
  assert.equal(agent.hasContinuation("D"), true, "another tree's session is untouched");
  console.log("5. logical switch cleared only that logical's sessions");
}

await fs.rm(ws, { recursive: true, force: true });
console.log("tree-pinning-test: all assertions passed");
