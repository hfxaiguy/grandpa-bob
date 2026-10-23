/**
 * Pin-on-open — a live session freezes its tree when it opens.
 *
 *   1. A fresh session loads `patterns/<name>.prod.mjs` once.
 *   2. Overwriting that file mid-session does NOT disturb a live session: it
 *      keeps running the tree it opened on (the in-memory freeze).
 *   3. A restart (a fresh Agent, restoring from the log DB) re-loads the tree
 *      from disk; if it changed, the session drops with the "tree changed"
 *      notice and restarts on the current file.
 *   4. Editing another tree's file never touches this session.
 *   5. A Tools-only change does not drop a session (resume only cares about
 *      the child structure).
 *
 * Mock model handler, no network. Run: npm run test:tree-pinning
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-pinning-"));
const patterns = path.join(ws, "patterns");
await fs.mkdir(patterns, { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

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
const mkAgent = (patternName: string) =>
  new Agent({
    models,
    workspace: ws,
    tools,
    patternName: () => patternName,
  });
const texts = (emitted: unknown[]) => emitted.map((e) => (e as { text: string }).text);

// ── 1. a fresh session opens on the prod file ──
await fs.writeFile(path.join(patterns, "relay.prod.mjs"), treeSrc("relay"));
let relay = mkAgent("relay");
{
  const r1 = await relay.run("A", "hello");
  assert.equal(r1.status, "waiting");
  console.log("1. fresh session opened on relay.prod.mjs");
}

// ── 2. pin-on-open: overwriting the file mid-session does not disturb ──
{
  await fs.writeFile(path.join(patterns, "relay.prod.mjs"), treeSrc("relay", SHAPE_EXTRA));
  const emitted: unknown[] = [];
  const r2 = await relay.run("A", "world", (v) => emitted.push(v));
  assert.equal(r2.status, "waiting");
  assert.deepEqual(texts(emitted), ["A:world"], "resumed on the frozen tree, no drop notice");
  console.log("2. live session kept the tree it opened on despite an overwrite");
}

// ── 3. a restart after a change drops with the 'tree changed' notice ──
{
  relay = mkAgent("relay"); // fresh instance = restart; reloads relay.prod from disk
  const emitted: unknown[] = [];
  const r3 = await relay.run("A", "three", (v) => emitted.push(v));
  assert.equal(r3.status, "waiting");
  assert.match(texts(emitted)[0], /tree changed since it paused/);
  assert.deepEqual(texts(emitted)[1], "A:three");
  console.log("3. restart after a change dropped and restarted the session");
}

// ── 4. editing another tree's file leaves this session alone ──
{
  const before = await relay.run("E", "one");
  assert.equal(before.status, "waiting");
  await fs.writeFile(path.join(patterns, "other.prod.mjs"), treeSrc("other", SHAPE_EXTRA));
  const emitted: unknown[] = [];
  const after = await relay.run("E", "two", (v) => emitted.push(v));
  assert.equal(after.status, "waiting");
  assert.deepEqual(texts(emitted), ["A:two"], "no drop notice for an unrelated tree edit");
  console.log("4. editing another tree did not disturb the session");
}

// ── 5. resume-irrelevant churn does NOT drop a session ──
//
// The trunk's Tools() list is built from a filesystem scan of app/ (the
// trunk's appTreeNames() scan), so creating or editing an app dir while a
// session is paused used to change the tree's definition hash and nuke its
// whole saved context. Only the CHILD STRUCTURE matters for resume, so a
// Tools-only change must keep the session.
{
  const toolsSrc = (name: string, toolList: string[]) => `export default function ({ Tree, name, Model, Tools, Human, Emit }) {
  return Tree(
    name(${JSON.stringify(name)}),
    Model("cheap"),
    Tools(${toolList.map((t) => JSON.stringify(t)).join(", ")}),
    Human("a"),
    Emit((m) => ({ text: "A:" + String(m.branch.a ?? "") })),
    Human("b"),
    Emit((m) => ({ text: "B:" + String(m.branch.b ?? "") })),
  );
}
`;
  await fs.writeFile(path.join(patterns, "toolsy.prod.mjs"), toolsSrc("toolsy", ["list_files"]));
  let toolsy = mkAgent("toolsy");
  const r1 = await toolsy.run("T", "one");
  assert.equal(r1.status, "waiting");

  await fs.writeFile(path.join(patterns, "toolsy.prod.mjs"), toolsSrc("toolsy", ["list_files", "git_status"]));
  toolsy = mkAgent("toolsy"); // restart, reloads toolsy.prod from disk
  const emitted: unknown[] = [];
  const r2 = await toolsy.run("T", "two", (v) => emitted.push(v));
  assert.equal(r2.status, "waiting");
  assert.deepEqual(texts(emitted), ["A:two"], "resumed with no drop notice for a Tools-only change");
  console.log("5. a Tools-only change kept the session (no context loss)");
}

await fs.rm(ws, { recursive: true, force: true });
console.log("tree-pinning-test: all assertions passed");
