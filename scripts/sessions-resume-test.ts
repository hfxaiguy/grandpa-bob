/**
 * Bot session resume — continuations survive Agent restarts.
 *
 * Session state lives in the log DB only (the browser target's design; there
 * is no sessions.json anymore):
 *   - continuations derive from the engine's own `runs` + `checkpoints` rows;
 *   - the host-only bits (resume hash, pin, paused tree path/signature, model
 *     overrides) travel as `web_session_meta` markers in the same DB.
 *
 *   1. A waiting conversation leaves a checkpoint + run row in the log DB.
 *   2. A *new* Agent (simulated restart) resumes mid-tree: the checkpoint
 *      routes the next input into the paused .human() slot, not a fresh tree.
 *   3. Switching the pattern file shape drops the stored session (fresh tree)
 *      and still delivers the message into the new tree.
 *   4. A checkpoint that disappears after restore falls back to a fresh run
 *      instead of throwing — the message is delivered, never swallowed.
 *   5. clear() tombstones the key: a restart does not resurrect it.
 *   6. An input-driven tree (declares `input`) consumes the message on its
 *      fresh run — callers skip the grow pass via consumesInputDirectly().
 *   7. Only dead-checkpoint / cannot-resume errors drop the session.
 *   8. Editing a sub-tree attached BY NAME (a runtime-loaded port the root
 *      skeleton cannot see) drops the pause before resume.
 *   9. Model overrides persist through the same marker rows.
 *
 * Mock model handler, no network. Run: npm run test:sessions
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-sessions-"));
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const logDb = path.join(ws, "logs", "grandma-kat.db");

const PATTERN = `export default function ({ Tree, name, Model, Human, Emit }) {
  return Tree(
    name("relay"),
    Model("cheap"),
    Human("a"),
    Emit((m) => ({ text: "A:" + String(m.branch.a ?? "") })),
    Human("b"),
    Emit((m) => ({ text: "B:" + String(m.branch.b ?? "") })),
  );
}\n`;
await fs.writeFile(path.join(ws, "patterns", "relay.mjs"), PATTERN);

const handler = async () => ({ content: "mock-answer", reasoning: null, tool_calls: [] });
const models = { cheap: { model: "cheap", handler } } as any;
// A second entry only where an override is exercised (a bare tree with no
// Model() rule needs exactly one model to resolve its default).
const modelsAlt = { cheap: { model: "cheap", handler }, alt: { model: "alt", handler } } as any;
const tools = new ToolRegistry(ws, ["ls"]);
const mkAgent = (patternName = "relay") =>
  new Agent({ models, workspace: ws, tools, patternName: () => patternName });

/** Read-only peek into the engine's log (its own connection, like an operator). */
function logQuery<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(logDb);
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

const latestRun = (key: string) =>
  logQuery<{ run_id: string }>(
    "SELECT run_id FROM runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
    key,
  )[0];

// ── 1. first turn pauses; the log DB is the only store ──
{
  const agent = mkAgent();
  const r1 = await agent.run("k", "hello");
  assert.equal(r1.status, "waiting");
  const run = latestRun("k");
  assert.ok(run, "the run row records its conversation key");
  const cp = logQuery<{ id: string }>("SELECT id FROM checkpoints WHERE run_id = ?", run.run_id);
  assert.equal(cp.length, 1, "the pause left exactly one checkpoint");
  await assert.rejects(fs.access(path.join(ws, "logs", "sessions.json")), "no sessions.json is written");
  console.log("1. waiting turn persisted to the log DB (runs + checkpoints), no sessions.json");
}

// ── 2. restart resumes mid-tree (input lands in the paused .human("a")) ──
{
  const agent = mkAgent(); // simulated restart: fresh instance, same workspace
  assert.equal(agent.hasContinuation("k"), true, "continuation derived from the log DB");
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
    PATTERN.replace('Human("b"),', 'Human("b"), Emit(() => ({ text: "mid" })), Human("c2"),'),
  );
  await new Promise((r) => setTimeout(r, 5)); // bust the import cache-buster
  const agent = mkAgent();
  const emitted: unknown[] = [];
  const r = await agent.run("k", "again", (v) => emitted.push(v));
  assert.equal(r.status, "waiting");
  // The dropped position is announced first (see Agent.noticeDrop), then
  // the message is delivered into the fresh tree.
  assert.equal(emitted.length, 2, "a drop notice precedes the delivery");
  assert.match((emitted[0] as { text: string }).text, /dropped the saved position/);
  assert.deepEqual(emitted[1], { text: "A:again" }, "message delivered into the fresh tree");
  console.log("3. edited pattern started a fresh tree, old session dropped");
}

// ── 4. a checkpoint that dies after restore falls back to a fresh run ──
{
  const seed = mkAgent();
  await seed.run("stale", "seed"); // pause, then let the DB hold the checkpoint
  const agent = mkAgent(); // restore sees the continuation
  assert.equal(agent.hasContinuation("stale"), true);
  // The row vanishes between restore and resume (pruned under a live agent).
  const run = latestRun("stale");
  const db = new DatabaseSync(logDb);
  db.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(run!.run_id);
  db.close();
  const emitted: unknown[] = [];
  const r = await agent.run("stale", "hi", (v) => emitted.push(v));
  assert.equal(r.status, "waiting", "stale checkpoint recovered as fresh tree");
  assert.equal(emitted.length, 2, "a drop notice precedes the delivery");
  assert.match((emitted[0] as { text: string }).text, /dropped the saved position/);
  assert.deepEqual(emitted[1], { text: "A:hi" }, "the message is delivered, not swallowed");
  console.log("4. missing checkpoint caught, fresh tree started, message delivered");
}

// ── 5. clear() tombstones the key (a restart must not resurrect it) ──
{
  const agent = mkAgent();
  agent.clear("k");
  assert.equal(agent.hasContinuation("k"), false);
  const restarted = mkAgent();
  assert.equal(restarted.hasContinuation("k"), false, "clearedAt outranks the orphaned checkpoint");
  console.log("5. clear() persisted a tombstone; restart did not resurrect the session");
}

// ── 5b. model overrides persist through the same marker rows ──
{
  const agent = new Agent({ models: modelsAlt as any, workspace: ws, tools, patternName: () => "relay" });
  assert.equal(agent.setSessionModel("m", "strong", "alt"), true);
  const restarted = new Agent({ models: modelsAlt as any, workspace: ws, tools, patternName: () => "relay" });
  assert.equal(restarted.sessionModel("m"), "alt", "the override survived the restart");
  restarted.clearSessionModel("m");
  const again = new Agent({ models: modelsAlt as any, workspace: ws, tools, patternName: () => "relay" });
  assert.equal(again.sessionModel("m"), undefined, "clearing the override persists too");
  console.log("5b. model overrides persist and clear through session-meta markers");
}

// ── 6. concurrent turns on ONE key serialize (web following telegram) ──
{
  await fs.writeFile(
    path.join(ws, "patterns", "serial.mjs"),
    `export default function ({ Tree, name, Model, Human, Prompt }) {
       return Tree(
         name("serial"),
         Model("cheap"),
         Human("q1"), Prompt(() => [{ role: "user", content: "p" }]),
         Human("q2"), Prompt(() => [{ role: "user", content: "p" }]),
       );
     }\n`,
  );
  let active = 0, peak = 0;
  const slow = {
    cheap: {
      model: "cheap",
      handler: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 25));
        active--;
        return { content: "ok", reasoning: null, tool_calls: [] };
      },
    },
  };
  const agent = new Agent({ models: slow as any, workspace: ws, tools, patternName: () => "serial" });
  const r0 = await agent.run("s", "seed");
  assert.equal(r0.status, "waiting", "tree paused at .human(q1)");
  const [ra, rb] = await Promise.all([agent.run("s", "A"), agent.run("s", "B")]);
  assert.equal(peak, 1, "turns sharing one key never overlap");
  assert.equal(ra.status, "waiting", "A paused at .human(q2)");
  assert.equal(rb.status, "done", "B resumed after A and completed the tree");
  console.log("6. concurrent turns on the same key serialized cleanly");
}

// ── 6b. input-driven trees consume the message on the fresh run ──
{
  assert.equal(await mkAgent().consumesInputDirectly(), false, "relay is trunk-shaped");
  await fs.writeFile(
    path.join(ws, "patterns", "ask.mjs"),
    `export default function ({ Tree, name, Needs, Emit, Human }) {
  return Tree(
    name("ask"),
    Needs("input"),
    Emit((m) => ({ text: "I:" + String(m.input) })),
    Human("go"),
  );
}\n`,
  );
  const agent = mkAgent("ask");
  assert.equal(await agent.consumesInputDirectly(), true, "ask declares input");
  const emitted: unknown[] = [];
  const r = await agent.run("ask", "hi", (v) => emitted.push(v));
  assert.equal(r.status, "waiting", "paused at its own .human()");
  assert.deepEqual(emitted, [{ text: "I:hi" }], "the fresh run consumed the message itself");
  console.log("6b. input-driven tree ran the message directly");
}

// ── 7. only dead-checkpoint / cannot-resume errors drop the session ──
{
  const { isDroppableContinuationError } = await import("../src/agent.js");
  assert.equal(isDroppableContinuationError("checkpoint 'x:1' not found"), true);
  assert.equal(
    isDroppableContinuationError("cannot resume: tree '' is not registered (call .name() to register)"),
    true,
    "a resume that cannot rebuild the tree stack is recoverable",
  );
  assert.equal(
    isDroppableContinuationError("cannot resume: tree 'draft_profile#3' is not registered (call .name() to register)"),
    true,
  );
  assert.equal(
    isDroppableContinuationError("tree 'app' needs 'input', but it does not resolve in scope"),
    false,
    "a real failure must still propagate",
  );
  console.log("7. only dead-checkpoint / cannot-resume errors drop the session");
}

// ── 8. a changed sub-tree attached by name drops the pause ──
{
  // deep.mjs attaches leaf.mjs as a runtime-loaded port (a versioned From), so
  // the root skeleton hash never sees leaf's shape.
  await fs.writeFile(
    path.join(ws, "patterns", "deep.mjs"),
    `export default function ({ Tree, name, From, version, Return }) {
  return Tree(name("deep"), From("leaf", version("draft")), Return((m) => m.branch.leaf ?? ""));
}\n`,
  );
  await fs.writeFile(
    path.join(ws, "patterns", "leaf.mjs"),
    `export default function ({ Tree, name, Human }) {
  return Tree(name("leaf"), Human("x"));
}\n`,
  );
  const a1 = mkAgent("deep");
  const r1 = await a1.run("deep", "hi");
  assert.equal(r1.status, "waiting", "paused inside the attached leaf");
  // The pause persisted the treePath + subtree signature as marker state.
  const paused = logQuery<{ content: string }>(
    "SELECT content FROM calls WHERE kind = 'web_session_meta' AND run_id = 'deep' ORDER BY seq DESC LIMIT 1",
  )[0];
  const meta = JSON.parse(paused.content) as { treePath?: string; subtreeHash?: string };
  assert.equal(typeof meta.treePath, "string", "the pause records its treePath");
  assert.equal(typeof meta.subtreeHash, "string", "and the subtree signature");

  // Change leaf's shape without touching deep.mjs.
  await fs.writeFile(
    path.join(ws, "patterns", "leaf.mjs"),
    `export default function ({ Tree, name, Memory, Human }) {
  return Tree(name("leaf"), Memory("s", () => 0), Human("x"));
}\n`,
  );
  await new Promise((r) => setTimeout(r, 5)); // bust the import cache-buster

  const a2 = mkAgent("deep"); // simulated restart: fresh cache, reloads from disk
  const emitted: unknown[] = [];
  const r2 = await a2.run("deep", "again", (v) => emitted.push(v));
  // The drop announces itself, then the message is delivered into the fresh
  // tree — leaf's single Human consumes it, so the turn completes.
  assert.equal(r2.status, "done", "the fresh tree consumed the delivered message");
  assert.equal(emitted.length, 1, "a drop notice precedes the delivery");
  assert.match(
    (emitted[0] as { text: string }).text,
    /a tree it depends on changed/,
    "the drop names the changed sub-tree, not a generic mismatch",
  );
  console.log("8. a changed attached sub-tree dropped the pause before resume");
}

console.log("sessions-resume-test: all assertions passed");
