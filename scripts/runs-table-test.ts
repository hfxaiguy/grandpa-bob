/**
 * The run registry — `runs.session_id`.
 *
 * The engine writes one `runs` row per run (run_id, session_id, started_at)
 * and the web picker / tree tooling resolve "which runs belong to this
 * session?" through it. The host's onEvent telemetry wrapper in Agent must
 * delegate `startRun`; it did not, so for every web/telegram turn (the ones
 * that pass onEvent) the whole registry went unwritten in production.
 *
 *   1. A run through the wrapper (onEvent present) writes the row with the
 *      conversation key.
 *   2. A resumed turn keeps the original row (same run id, INSERT OR IGNORE).
 *   3. Without onEvent the base logger is used directly — same result.
 *
 * Mock model handler, no network. Run: npm run test:runs-table
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "grandma-kat";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import { ensureRepo } from "../src/tools/git.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-runs-table-"));
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
await ensureRepo(ws);

await fs.writeFile(
  path.join(ws, "patterns", "two-step.mjs"),
  `export default function ({ Tree, name, Model, Human, Prompt }) {
     return Tree(
       name("two-step"),
       Model("cheap"),
       Human("input_1"),
       Prompt((m) => [
         { role: "user", content: "echo: " + String(m.branch.input_1 ?? "") },
       ]),
     );
   }\n`,
);

const handler = async () => ({ content: "mock-answer", reasoning: null, tool_calls: [] });
const models = { cheap: { model: "cheap", handler } } as any;
const tools = new ToolRegistry(ws, ["ls"]);

// The production shape: a shared logger OBJECT (not a path string).
const dbPath = path.join(ws, "logs", "grandma-kat.db");
const katLogger = createLogger(dbPath, "none") as { close(): void };
const agent = new Agent({
  models,
  workspace: ws,
  tools,
  patternName: () => "two-step",
  logger: katLogger,
});

const rows = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const out = db.prepare("SELECT run_id, session_id FROM runs ORDER BY rowid").all();
  db.close();
  return out as { run_id: string; session_id: string | null }[];
};

// 1. A turn WITH onEvent goes through the wrapper — the delegation under test.
{
  const r1 = await agent.run("web:alpha", "", () => {}, { onEvent: () => {} });
  assert.equal(r1.status, "waiting", "paused at the human");
  const after = rows();
  assert.equal(after.length, 1, "the run was registered");
  assert.equal(after[0].session_id, "web:alpha", "the conversation key landed on the run row");
  const runId = after[0].run_id;

  // 2. The resumed turn continues the same run — still exactly one row.
  const r2 = await agent.run("web:alpha", "ping", () => {}, { onEvent: () => {} });
  assert.equal(r2.status, "done", "resumed and completed");
  const after2 = rows();
  assert.equal(after2.length, 1, "a resumed run keeps its original row");
  assert.equal(after2[0].run_id, runId, "same run id");
  assert.equal(after2[0].session_id, "web:alpha");
}

// 3. Without onEvent the base logger is used directly (already worked, pinned
//    so a future wrapper change cannot regress this path either).
{
  const r = await agent.run("web:beta", "", () => {});
  assert.equal(r.status, "waiting");
  const after = rows();
  assert.equal(after.length, 2, "the second conversation registered too");
  assert.equal(after[1].session_id, "web:beta");
}

katLogger.close();
await fs.rm(ws, { recursive: true, force: true });
console.log("runs-table-test: all assertions passed");
process.exit(0);
