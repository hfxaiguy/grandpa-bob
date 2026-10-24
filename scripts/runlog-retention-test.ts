// Unit tests for the browser run-log retention (web/src/agent/runlog-retention.ts)
// against a real SQLite file through the Node platform adapter — the same
// SqliteDatabase contract the browser worker implements.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nodeSqlite } from "../src/platform/node.ts";
import { RUN_LOG_DDL } from "../web/src/agent/log-store.ts";
import { runLogBytes, trimRunLog } from "../web/src/agent/runlog-retention.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-runlog-retention-"));
const file = path.join(dir, "grandma-kat.db");
const db = await nodeSqlite.open(file, { readOnly: false });
await db.exec(RUN_LOG_DDL);

let seq = 0;
const pad = (n: number) => "x".repeat(n);

async function insertRun(runId: string, definitionId: string, contentSize: number): Promise<void> {
  const stmt = await db.prepare(
    "INSERT INTO calls (seq, run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)",
  );
  for (const kind of ["human", "llm_call", "tool_call", "emit"]) {
    seq += 1;
    await stmt.run(seq, runId, definitionId, kind, JSON.stringify({ text: pad(contentSize) }));
  }
}

async function insertMarker(session: string, kind: string, contentSize: number): Promise<void> {
  seq += 1;
  const stmt = await db.prepare(
    "INSERT INTO calls (seq, run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, ?, 'web', NULL, 0, NULL, ?, ?)",
  );
  await stmt.run(seq, session, kind, JSON.stringify({ key: session, bubbles: [pad(contentSize)] }));
}

async function runIds(): Promise<string[]> {
  const rows = (await (
    await db.prepare("SELECT DISTINCT run_id FROM calls WHERE definition_id <> 'web' ORDER BY run_id")
  ).all()) as Array<{ run_id: string }>;
  return rows.map((r) => r.run_id);
}

async function markerSessions(): Promise<string[]> {
  const rows = (await (
    await db.prepare("SELECT DISTINCT run_id FROM calls WHERE definition_id = 'web' ORDER BY run_id")
  ).all()) as Array<{ run_id: string }>;
  return rows.map((r) => r.run_id);
}

// ── engine trim: oldest runs go, the newest keepRuns stay ───────────────────
for (let i = 0; i < 8; i += 1) {
  await insertRun(`2026-10-2${i}_run`, "trunk:aaaaaaaa", 100_000);
}
// A paused run's checkpoint must protect it even though it is old.
seq += 1;
await (
  await db.prepare("INSERT INTO checkpoints (id, run_id, seq, resume_positions) VALUES (?, ?, ?, ?)")
).run("cp-1", "2026-10-20_run", seq, "{}");

const beforeEngine = await runLogBytes(db);
assert.ok(beforeEngine > 1_000_000, `expected >1MB, got ${beforeEngine}`);

const engineTrim = await trimRunLog(db, { maxBytes: 1_000_000, keepRuns: 3, keepSessions: 20 });
assert.ok(engineTrim, "engine trim should fire");
assert.equal(engineTrim.beforeBytes, beforeEngine);
assert.ok(engineTrim.afterBytes < engineTrim.beforeBytes, "VACUUM should shrink the file");
assert.deepEqual(await runIds(), [
  "2026-10-20_run", // checkpointed, old but protected
  "2026-10-25_run",
  "2026-10-26_run",
  "2026-10-27_run",
]);

// ── session fallback: markers only, size still over budget ─────────────────
await db.exec("DELETE FROM calls");
await db.exec("DELETE FROM checkpoints");
seq = 0;
for (let i = 0; i < 5; i += 1) await insertMarker(`web:session-${i}`, "web_turn_end", 200_000);
const beforeSessions = await runLogBytes(db);

const sessionTrim = await trimRunLog(db, { maxBytes: 300_000, keepRuns: 3, keepSessions: 2 });
assert.ok(sessionTrim, "session trim should fire");
assert.equal(sessionTrim.runs, 0, "no engine runs to trim");
assert.equal(sessionTrim.sessions, 3, "three oldest sessions retired");
assert.deepEqual(await markerSessions(), ["web:session-3", "web:session-4"]);
assert.ok((await runLogBytes(db)) < beforeSessions, "file shrinks after the session trim");

// ── size budget: beyond the floor, older runs go until the budget fits ─────
await db.exec("DELETE FROM calls");
await db.exec("DELETE FROM checkpoints");
seq = 0;
for (let i = 0; i < 6; i += 1) await insertRun(`2026-10-3${i}_run`, "trunk:bbbbbbbb", 100_000);
const budgetTrim = await trimRunLog(db, { maxBytes: 700_000, keepRuns: 1, keepSessions: 20 });
assert.ok(budgetTrim, "budget trim should fire");
assert.deepEqual(await runIds(), ["2026-10-35_run"], "only the floor run fits the budget");

// ── no-op when the log is under budget ─────────────────────────────────────
assert.equal(await trimRunLog(db, { maxBytes: 64 * 1024 * 1024, keepRuns: 3, keepSessions: 2 }), null);

await db.close();
await fs.rm(dir, { recursive: true, force: true });
console.log("runlog-retention: ok");
