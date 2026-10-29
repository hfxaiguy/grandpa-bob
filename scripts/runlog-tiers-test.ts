/**
 * Run-log session tiers (web/src/agent/runlog-retention.ts `trimSessionTiers`).
 *
 * The size-driven trim deletes whole runs; the tiers keep a middle ground so
 * an old session stays recallable without keeping its expensive trace:
 *
 *   tier 1  active within `hotDays`: untouched
 *   tier 2  tombstoned/aged (no live checkpoint): markers, emits, human rows,
 *           tree rows and the FINAL memory write per slot survive; trace goes
 *   tier 3  past `deleteDays`: deleted whole, checkpoint included
 *
 * The load-bearing assertion is that the memory panel payload is byte-equal
 * before and after a tier-2 compaction: `memoryWrites()` → tracker `rebuild()`
 * must restore the same values, app grouping and paths.
 *
 * Run: `npm run test:runlog-tiers`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNodePlatform } from "../src/platform/node.js";
import { createMemoryTracker } from "../web/src/memory-track.js";
import { memoryWrites, withLogDb } from "../web/src/agent/log-store.ts";
import { trimSessionTiers } from "../web/src/agent/runlog-retention.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type Platform = ReturnType<typeof createNodePlatform>;

async function sql(platform: Platform, text: string, params: unknown[] = []): Promise<void> {
  await withLogDb(platform, async (db) => {
    await (await db.prepare(text)).run(...(params as never[]));
  });
}

async function rows(
  platform: Platform,
  text: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return withLogDb(platform, async (db) => {
    return (await (await db.prepare(text)).all(...(params as never[]))) as Record<string, unknown>[];
  });
}

async function insert(
  platform: Platform,
  runId: string,
  definitionId: string,
  kind: string,
  content: unknown,
  opts: { scope?: number | null; branch?: string | null } = {},
): Promise<void> {
  await sql(
    platform,
    "INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, ?, ?, 0, ?, ?, ?)",
    [runId, definitionId, opts.branch ?? "trunk/harbr", opts.scope ?? null, kind, JSON.stringify(content)],
  );
}

interface SeedOptions {
  deleted?: boolean;
  checkpoint?: boolean;
  /** Bytes of trace payload, to make VACUUM measurable. */
  bulk?: number;
}

/** One web session: a turn marker + engine rows for that turn's run id. */
async function seedSession(
  platform: Platform,
  key: string,
  ts: number | null,
  opts: SeedOptions = {},
): Promise<string> {
  const runId = `run-${key}`;
  const scope = 7;
  const branch = "trunk/harbr";
  const bulk = opts.bulk ?? 300_000;

  await insert(platform, runId, "trunk", "tree_enter", { child: "harbr", app: "harbr" }, { branch });
  // Three writes to one slot: only the last one is the value anyone restores.
  for (const value of ["one", "two", "three"]) {
    await insert(platform, runId, "trunk", "record", { child: "slot", childIndex: null, op: "memory", value }, { branch, scope });
  }
  await insert(platform, runId, "trunk", "record", { child: "other", childIndex: null, op: "memoryUpdate", patch: true, value: 42 }, { branch, scope });
  await insert(platform, runId, "trunk", "record", { child: "prompt", childIndex: 0, op: "set", value: "x".repeat(bulk) }, { branch, scope });
  await insert(platform, runId, "trunk", "emit", { value: { text: `reply ${key}` } }, { branch });
  await insert(platform, runId, "trunk", "human", { child: "reply", delivered: true, value: `said ${key}` }, { branch });
  await insert(platform, runId, "trunk", "llm_call", { content: "out", messages: [{ role: "user", content: "y".repeat(bulk) }] }, { branch });
  await insert(platform, runId, "trunk", "tool_call", { tool: "sql_query", args: { query: "SELECT 1 ".repeat(1000) } }, { branch });
  await insert(platform, runId, "trunk", "tool_result", { tool: "sql_query", result: "z".repeat(bulk) }, { branch });
  await insert(platform, runId, "trunk", "tree_exit", { child: "harbr", app: "harbr" }, { branch });
  if (opts.checkpoint) {
    await sql(platform, "INSERT INTO checkpoints (id, run_id, seq, resume_positions) VALUES (?, ?, 1, '[]')", [
      `cp-${key}`,
      runId,
    ]);
  }
  await insert(
    platform,
    key,
    "web",
    "web_turn_end",
    { key, runId, input: `hi ${key}`, fromSeq: 0, toSeq: 999_999_999, ...(ts == null ? {} : { ts }), status: "done" },
    { branch },
  );
  if (opts.deleted) await insert(platform, key, "web", "web_session_delete", { key, ...(ts == null ? {} : { ts }) }, { branch });
  return runId;
}

async function count(platform: Platform, runIds: string[], extra = ""): Promise<number> {
  const ph = runIds.map(() => "?").join(",");
  const [row] = await rows(platform, `SELECT COUNT(*) n FROM calls WHERE run_id IN (${ph}) ${extra}`, runIds);
  return Number(row?.n ?? 0);
}

async function droppedTrace(platform: Platform, runIds: string[]): Promise<number> {
  const ph = runIds.map(() => "?").join(",");
  const [row] = await rows(
    platform,
    `SELECT COUNT(*) n FROM calls
      WHERE run_id IN (${ph})
        AND (kind IN ('llm_call', 'tool_call', 'tool_result')
          OR (kind = 'record' AND json_extract(content, '$.op') = 'set'))`,
    runIds,
  );
  return Number(row?.n ?? 0);
}

async function memoryRows(platform: Platform, runIds: string[]): Promise<Record<string, unknown>[]> {
  const ph = runIds.map(() => "?").join(",");
  return rows(
    platform,
    `SELECT seq, content FROM calls
      WHERE run_id IN (${ph}) AND kind = 'record'
        AND json_extract(content, '$.op') IN ('memory', 'memoryUpdate')
      ORDER BY seq`,
    runIds,
  );
}

async function payload(platform: Platform, key: string): Promise<unknown> {
  const tracker = createMemoryTracker();
  tracker.rebuild(key, await memoryWrites(platform, key));
  return tracker.payload(key);
}

function trim(platform: Platform, tiers = { hotDays: 14, deleteDays: 90 }) {
  return withLogDb(platform, (db) => trimSessionTiers(db, tiers));
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-runlog-tiers-"));
const platform = createNodePlatform(workspace);
try {
  const hot = await seedSession(platform, "web:hot", NOW - 1 * DAY, { bulk: 50_000 });
  const aged = await seedSession(platform, "web:aged", NOW - 20 * DAY);
  const tomb = await seedSession(platform, "web:tomb", NOW - 2 * DAY, { deleted: true, bulk: 50_000 });
  const pinned = await seedSession(platform, "web:pinned", NOW - 30 * DAY, { checkpoint: true });
  const gone = await seedSession(platform, "web:gone", NOW - 100 * DAY, { checkpoint: true });
  // A marker with no timestamp has an unknown age: leave it to the size policy.
  const undated = await seedSession(platform, "web:undated", null, { bulk: 20_000 });

  const hotBefore = await count(platform, ["web:hot", hot]);
  const pinnedBefore = await count(platform, ["web:pinned", pinned]);
  const undatedBefore = await count(platform, ["web:undated", undated]);
  const agedPayloadBefore = await payload(platform, "web:aged");
  const agedMemoryBefore = await memoryRows(platform, ["web:aged", aged]);

  const result = await trim(platform);
  assert.ok(result, "a pass with aged/tombstoned sessions reports a result");

  // Tier 1: recent — untouched.
  assert.equal(await count(platform, ["web:hot", hot]), hotBefore, "recent session untouched");

  // Tier 2: trace dropped, retained rows kept, last memory write per slot.
  assert.equal(await droppedTrace(platform, ["web:aged", aged]), 0, "aged trace dropped");
  assert.equal(await count(platform, ["web:aged", aged], "AND kind = 'emit'"), 1, "emit kept");
  assert.equal(await count(platform, ["web:aged", aged], "AND kind = 'human'"), 1, "human kept");
  assert.equal(await count(platform, ["web:aged", aged], "AND kind = 'tree_enter'"), 1, "tree_enter kept");
  assert.equal(await count(platform, ["web:aged", aged], "AND kind = 'tree_exit'"), 1, "tree_exit kept");
  assert.equal(await count(platform, ["web:aged", aged], "AND kind = 'web_turn_end'"), 1, "turn marker kept");
  const agedMemoryAfter = await memoryRows(platform, ["web:aged", aged]);
  assert.equal(agedMemoryAfter.length, 2, "one row per memory slot survives");
  assert.ok(agedMemoryAfter.length < agedMemoryBefore.length, "intermediate memory writes dropped");
  const slotRow = agedMemoryAfter.find(
    (row) => (JSON.parse(String(row.content)) as { child?: string }).child === "slot",
  );
  assert.equal((JSON.parse(String(slotRow?.content)) as { value?: unknown }).value, "three", "the surviving write is the last value");
  assert.deepEqual(await payload(platform, "web:aged"), agedPayloadBefore, "memory panel payload identical");

  // Tombstoned sessions are sealed immediately even while recent.
  assert.equal(await droppedTrace(platform, ["web:tomb", tomb]), 0, "tombstoned trace dropped");

  // Checkpoints pin a session: resume needs the whole stream.
  assert.equal(await count(platform, ["web:pinned", pinned]), pinnedBefore, "checkpointed session untouched");
  assert.equal(await count(platform, ["web:pinned", pinned], "AND kind = 'llm_call'"), 1, "pinned trace intact");

  // Unknown age is never deleted or compacted by the tier pass.
  assert.equal(await count(platform, ["web:undated", undated]), undatedBefore, "undated session untouched");

  // Tier 3: past the deletion horizon, the whole session (checkpoint and all) goes.
  assert.equal(await count(platform, ["web:gone", gone]), 0, "old session deleted");
  const [cp] = await rows(platform, "SELECT COUNT(*) n FROM checkpoints WHERE run_id = ?", [gone]);
  assert.equal(Number(cp?.n ?? 0), 0, "old checkpoint deleted");

  // The pass reclaimed space; a second pass is a true no-op (no writes).
  assert.ok(result.vacuumed, "deletes vacuum");
  assert.ok(result.afterBytes < result.beforeBytes, "file shrank");
  assert.equal(result.compacted, 2, "aged + tombstoned compacted");
  assert.equal(result.deleted, 1, "one session deleted");
  assert.equal(await trim(platform), null, "second pass has nothing to do");

  console.log("runlog-tiers: recent untouched, trace compacted, resumes pinned, old deleted OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
