/**
 * Tree version pinning — a session keeps the version it started on.
 *
 *   1. A fresh session pins the concrete active version (prod → "vN";
 *      draft → "draft") and persists it in sessions.json.
 *   2. Editing the draft and switching the active ref do NOT disturb a
 *      session pinned to an immutable snapshot.
 *   3. A draft-pinned session drops when the draft shape changes.
 *   4. Removing the pinned version drops the session with a specific
 *      "its version was removed" notice and restarts on the active ref.
 *   5. Promotion (rename) does not invalidate a session pinned to the
 *      promoted version — the internal name is stable.
 *   6. clearSessionsForLogical only drops that logical's sessions.
 *
 * Mock model handler, no network. Run: npm run test:tree-pinning
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import { snapshotTree, promoteTree } from "../src/tree-versions.js";

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

// ── 1. fresh session pins the concrete prod version ──
await fs.writeFile(path.join(patterns, "relay.mjs"), treeSrc("relay"));
assert.equal((await snapshotTree(ws, "relay")).version, "v1");
await promoteTree(ws, "relay", "v1");
{
  const agent = mkAgent("relay");
  const r1 = await agent.run("A", "hello");
  assert.equal(r1.status, "waiting");
  assert.equal((await readSessions()).A.ref, "relay@v1", "prod pinned as a concrete version");
  console.log("1. fresh session pinned the concrete prod version");
}

// ── 2. draft edit + active switch leave a snapshot-pinned session alone ──
{
  await fs.writeFile(path.join(patterns, "relay.mjs"), treeSrc("relay", SHAPE_EXTRA));
  const agent = mkAgent("relay", () => "draft"); // active now points at the edited draft
  const emitted: unknown[] = [];
  const r2 = await agent.run("A", "world", (v) => emitted.push(v));
  assert.equal(r2.status, "waiting");
  assert.deepEqual(texts(emitted), ["A:world"], "resumed on v1 with no drop notice");
  assert.equal((await readSessions()).A.ref, "relay@v1", "still pinned to v1");
  console.log("2. snapshot-pinned session survived a draft edit and an active switch");
}

// ── 3. a draft-pinned session drops when the draft changes ──
{
  await fs.writeFile(path.join(patterns, "drafty.mjs"), treeSrc("drafty"));
  let agent = mkAgent("drafty", () => "draft");
  const r1 = await agent.run("D", "one");
  assert.equal(r1.status, "waiting");
  assert.equal((await readSessions()).D.ref, "drafty@draft");

  await fs.writeFile(path.join(patterns, "drafty.mjs"), treeSrc("drafty", SHAPE_EXTRA));
  agent = mkAgent("drafty", () => "draft");
  const emitted: unknown[] = [];
  const r2 = await agent.run("D", "two", (v) => emitted.push(v));
  assert.equal(r2.status, "waiting");
  assert.match(texts(emitted)[0], /dropped the saved position/);
  assert.deepEqual(texts(emitted)[1], "A:two");
  console.log("3. edited draft dropped its draft-pinned session");
}

// ── 4. promotion does not invalidate a session pinned to that version ──
{
  await fs.writeFile(path.join(patterns, "cand.mjs"), treeSrc("cand"));
  await snapshotTree(ws, "cand"); // v1
  await fs.writeFile(path.join(patterns, "cand.mjs"), treeSrc("cand", SHAPE_EXTRA));
  assert.equal((await snapshotTree(ws, "cand")).version, "v2");

  let agent = mkAgent("cand", () => "v2");
  const r1 = await agent.run("E", "x");
  assert.equal(r1.status, "waiting");
  assert.equal((await readSessions()).E.ref, "cand@v2");

  await promoteTree(ws, "cand", "v2"); // rename candidate → prod
  agent = mkAgent("cand", () => "prod");
  const emitted: unknown[] = [];
  const r2 = await agent.run("E", "y", (v) => emitted.push(v));
  assert.equal(r2.status, "waiting");
  assert.deepEqual(texts(emitted), ["A:y"], "resumed on the promoted version, unchanged");
  assert.equal((await readSessions()).E.ref, "cand@v2");
  console.log("4. promote (rename) kept the pinned session valid");
}

// ── 5. removing the pinned version drops with a specific notice ──
{
  await fs.unlink(path.join(patterns, "relay.v1.prod.mjs"));
  const agent = mkAgent("relay", () => "draft");
  const emitted: unknown[] = [];
  const r = await agent.run("A", "three", (v) => emitted.push(v));
  assert.equal(r.status, "waiting");
  assert.match(texts(emitted)[0], /version was removed/);
  assert.deepEqual(texts(emitted)[1], "A:three");
  assert.equal((await readSessions()).A.ref, "relay@draft", "re-pinned to the active ref");
  console.log("5. removed pinned version dropped gracefully and restarted");
}

// ── 6. clearSessionsForLogical only touches that logical ──
{
  const agent = mkAgent("relay", () => "draft");
  assert.equal(agent.hasContinuation("A"), true);
  assert.equal(agent.hasContinuation("D"), true);
  assert.equal(agent.hasContinuation("E"), true);
  const cleared = agent.clearSessionsForLogical("relay");
  assert.deepEqual(cleared, ["A"]);
  assert.equal(agent.hasContinuation("A"), false);
  assert.equal(agent.hasContinuation("D"), true, "another tree's session is untouched");
  assert.equal(agent.hasContinuation("E"), true);
  console.log("6. logical switch cleared only that logical's sessions");
}

await fs.rm(ws, { recursive: true, force: true });
console.log("tree-pinning-test: all assertions passed");
