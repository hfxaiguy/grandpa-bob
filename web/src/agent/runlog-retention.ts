/**
 * Run-log retention: keep the browser's KAT log under a size budget.
 *
 * Every engine event is stored with its full content — whole prompts, tool
 * transcripts and reasoning included — so the log grows without bound. The
 * browser target opens it through the `opfs-sahpool` VFS (page-streamed, never
 * loaded into wasm memory), which makes DELETE + VACUUM an ordinary file
 * rewrite; the web session picker reads marker rows from the same `calls`
 * table, so a trim must keep the newest sessions' markers while dropping the
 * older engine rows.
 *
 * Safety rules:
 * - A run with a pending checkpoint (a paused conversation) is never trimmed.
 * - The newest `keepRuns` engine runs are always kept; older runs survive only
 *   while the content budget covers them.
 * - Session markers are only touched when that is not enough, and only past
 *   the newest `keepSessions` sessions.
 *
 * The caller owns the connection's serialization (log-store's queue); this
 * module issues plain SQL and assumes it is the only writer while it runs.
 */
import type { SqliteDatabase } from "../../../src/platform/types";

export interface RunLogPolicy {
  /** Trim when the database exceeds this many bytes. */
  maxBytes: number;
  /**
   * Minimum engine runs (newest by MAX(seq)) kept regardless of size. Older
   * runs survive only while the budget allows, so this is a floor, not a
   * window.
   */
  keepRuns: number;
  /** Sessions whose marker rows survive the size-driven fallback trim. */
  keepSessions: number;
}

export const RUN_LOG_POLICY: RunLogPolicy = {
  maxBytes: 64 * 1024 * 1024,
  keepRuns: 10,
  keepSessions: 20,
};

export interface RunLogTrim {
  beforeBytes: number;
  afterBytes: number;
  /** Engine runs deleted. */
  runs: number;
  /** Session marker groups deleted in the fallback pass. */
  sessions: number;
  /** Rows deleted in total. */
  rows: number;
}

/** Batch size for `IN (...)` deletes (one statement per batch). */
const CHUNK = 100;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function all(db: SqliteDatabase, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const stmt = await db.prepare(sql);
  return (await stmt.all(...params)) as Record<string, unknown>[];
}

async function get(db: SqliteDatabase, sql: string, params: unknown[] = []): Promise<Record<string, unknown> | undefined> {
  const stmt = await db.prepare(sql);
  return (await stmt.get(...params)) as Record<string, unknown> | undefined;
}

/** Logical database size in bytes. */
export async function runLogBytes(db: SqliteDatabase): Promise<number> {
  const row = await get(db, "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()");
  return Number(row?.bytes ?? 0);
}

async function deleteRuns(db: SqliteDatabase, runIds: string[], markerOnly: boolean): Promise<number> {
  let rows = 0;
  for (const batch of chunks(runIds, CHUNK)) {
    const placeholders = batch.map(() => "?").join(",");
    const sql = markerOnly
      ? `DELETE FROM calls WHERE definition_id = 'web' AND run_id IN (${placeholders})`
      : `DELETE FROM calls WHERE run_id IN (${placeholders})`;
    const stmt = await db.prepare(sql);
    const result = await stmt.run(...batch);
    rows += Number(result.changes ?? 0);
  }
  return rows;
}

/** VACUUM is the only way to return deleted pages to the file; best effort. */
async function compact(db: SqliteDatabase): Promise<void> {
  try {
    await db.exec("VACUUM");
  } catch {
    /* older/fallback engines may not have the headroom; rows are still gone */
  }
}

/**
 * Trim the log when it exceeds `policy.maxBytes`. Returns null when nothing
 * needed doing (or nothing was trimmable), otherwise what changed.
 */
export async function trimRunLog(
  db: SqliteDatabase,
  policy: RunLogPolicy = RUN_LOG_POLICY,
): Promise<RunLogTrim | null> {
  const beforeBytes = await runLogBytes(db);
  if (!beforeBytes || beforeBytes <= policy.maxBytes) return null;

  // A paused run resumes from its checkpoint's seq — never delete its rows.
  const pending = new Set(
    (await all(db, "SELECT DISTINCT run_id FROM checkpoints")).map((row) => String(row.run_id)),
  );

  // Engine runs, newest first, with their content weight. Marker rows
  // (definition_id 'web') are not runs.
  const runs = await all(
    db,
    `SELECT run_id,
            MAX(seq) AS last_seq,
            SUM(LENGTH(CAST(content AS BLOB))) AS bytes
       FROM calls
      WHERE definition_id <> 'web' AND run_id IS NOT NULL
      GROUP BY run_id
      ORDER BY last_seq DESC`,
  );

  // Keep the newest `keepRuns` unconditionally; beyond that, keep a run only
  // while the budget still covers it. Paused runs are always kept.
  const keep = new Set<string>();
  let keptBytes = 0;
  for (const row of runs) {
    const runId = String(row.run_id);
    const bytes = Number(row.bytes ?? 0);
    if (keep.size < policy.keepRuns || pending.has(runId) || keptBytes + bytes <= policy.maxBytes) {
      keep.add(runId);
      keptBytes += bytes;
    }
  }
  const trimRuns = runs
    .map((row) => String(row.run_id))
    .filter((runId) => !keep.has(runId));

  let rows = 0;
  if (trimRuns.length) rows += await deleteRuns(db, trimRuns, false);

  let afterBytes = beforeBytes;
  if (rows) {
    await compact(db);
    afterBytes = await runLogBytes(db);
  }

  // Still over budget with no engine rows left to drop: retire the oldest
  // sessions (their marker rows are the picker's visible chat history).
  let sessions = 0;
  if (afterBytes > policy.maxBytes) {
    const list = await all(
      db,
      `SELECT run_id, MAX(seq) AS last_seq
         FROM calls
        WHERE definition_id = 'web'
        GROUP BY run_id
        ORDER BY last_seq DESC`,
    );
    const trimSessions = list.slice(policy.keepSessions).map((row) => String(row.run_id));
    if (trimSessions.length) {
      sessions = trimSessions.length;
      rows += await deleteRuns(db, trimSessions, true);
      await compact(db);
      afterBytes = await runLogBytes(db);
    }
  }

  if (!rows) return null;
  return { beforeBytes, afterBytes, runs: trimRuns.length, sessions, rows };
}

/** Human-readable size for notes. */
export function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ── age tiers for web sessions ──────────────────────────────────────────
//
// The size-driven trim above bounds the file, but it only ever deletes whole
// runs: an old session either keeps its full trace or disappears. The tiers
// add the middle ground — keep what the UI and recall actually read, drop the
// expensive trace:
//
//   tier 1  active within `hotDays`: untouched
//   tier 2  tombstoned, or past `hotDays` (no live checkpoint): markers,
//           emits, what the user said, app-attribution rows and the FINAL
//           memory write per slot survive; model rounds, tool transcripts and
//           plain child results go
//   tier 3  past `deleteDays`: deleted whole, checkpoint included
//
// Sessions are marker groups; their engine rows are found through the run ids
// recorded in the `web_turn_end` markers. A marker with no timestamp has an
// unknown age and is left to the size policy — a legacy hand-written row must
// not age out by accident. Only `definition_id = 'web'` sessions are touched,
// so a shared desktop log's Telegram history (bridge mode) is never compacted.
//
// Tier 2 is lossless for everything the UI rebuilds: the picker and turn
// summaries read markers, and the memory panel/restore replays through
// `memory-track`, which keeps the last value per (scope_id, child) anyway.
// Tree rows survive because app attribution is derived from them. What IS
// lost: read_runs expanded/deps recall for a compacted session, and refs into
// dropped rows resolve to null.

export interface RunLogTiers {
  /** Sessions active within this window keep full fidelity. */
  hotDays: number;
  /** Sessions older than this are deleted whole (checkpoint included). */
  deleteDays: number;
}

export const RUN_LOG_TIERS: RunLogTiers = { hotDays: 14, deleteDays: 90 };

export interface SessionTierTrim {
  beforeBytes: number;
  afterBytes: number;
  /** Sessions that kept only their retained rows. */
  compacted: number;
  /** Sessions deleted whole. */
  deleted: number;
  /** Rows deleted in total. */
  rows: number;
  vacuumed: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Mirrors log-store's marker kinds (kept local to avoid an import cycle). */
const SESSION_MARKERS = ["web_turn_end", "web_session_label", "web_session_delete", "web_session_open"];

/** Kinds tier 2 keeps besides the final memory write per slot. */
const RETAINED_KINDS = [
  ...SESSION_MARKERS,
  "emit",
  "human",
  // App attribution (memory-track) is derived from these; they are tiny.
  "tree_enter",
  "tree_exit",
  "tree_suspend",
  "scope_init",
];

interface WebSession {
  key: string;
  /** Engine run ids whose rows belong to this session. */
  runIds: string[];
  /** Latest marker timestamp (ms), 0 when the markers carry none. */
  lastTs: number;
  deleted: boolean;
  /** A live checkpoint means the engine can still resume this run. */
  checkpointed: boolean;
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readWebSessions(db: SqliteDatabase): Promise<Map<string, WebSession>> {
  const markers = await all(
    db,
    `SELECT run_id, kind, content FROM calls
      WHERE definition_id = 'web' AND kind IN (${SESSION_MARKERS.map(() => "?").join(",")})
      ORDER BY seq`,
    SESSION_MARKERS,
  );
  const sessions = new Map<string, WebSession>();
  for (const row of markers) {
    const key = String(row.run_id);
    const c = parseObject(row.content);
    let s = sessions.get(key);
    if (!s) {
      s = { key, runIds: [], lastTs: 0, deleted: false, checkpointed: false };
      sessions.set(key, s);
    }
    const ts = Number(c?.ts) || Number(c?.endedAt) || 0;
    if (ts > s.lastTs) s.lastTs = ts;
    if (String(row.kind) === "web_turn_end") {
      const runId = typeof c?.runId === "string" ? c.runId : "";
      if (runId && runId !== key && !s.runIds.includes(runId)) s.runIds.push(runId);
    } else if (String(row.kind) === "web_session_delete") {
      s.deleted = true;
    }
  }
  if (!sessions.size) return sessions;

  const pending = new Set(
    (await all(db, "SELECT DISTINCT run_id FROM checkpoints")).map((row) => String(row.run_id)),
  );
  for (const s of sessions.values()) {
    s.checkpointed = pending.has(s.key) || s.runIds.some((runId) => pending.has(runId));
  }
  return sessions;
}

function sessionRunIds(s: WebSession): string[] {
  return [s.key, ...s.runIds];
}

/**
 * Run ids that still hold rows tier 2 would drop. A session already compacted
 * has none — the pass must not issue no-op writes (each one is a file write).
 */
async function droppableRunIds(db: SqliteDatabase, runIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const batch of chunks(runIds, CHUNK)) {
    const ids = batch.map(() => "?").join(",");
    const keep = RETAINED_KINDS.map(() => "?").join(",");
    const rows = await all(
      db,
      `SELECT run_id, COUNT(*) n FROM calls
         WHERE run_id IN (${ids})
           AND kind NOT IN (${keep})
           AND seq NOT IN (
             SELECT MAX(seq) FROM calls
              WHERE run_id IN (${ids}) AND kind = 'record'
                AND json_valid(content)
                AND json_extract(content, '$.op') IN ('memory', 'memoryUpdate')
              GROUP BY run_id, scope_id, json_extract(content, '$.child'))
         GROUP BY run_id`,
      [...batch, ...RETAINED_KINDS, ...batch],
    );
    for (const row of rows) if (Number(row.n) > 0) out.add(String(row.run_id));
  }
  return out;
}

/** Delete everything but the retained rows (tier 2). Returns rows removed. */
async function compactRuns(db: SqliteDatabase, runIds: string[]): Promise<number> {
  let rows = 0;
  for (const batch of chunks(runIds, CHUNK)) {
    const ids = batch.map(() => "?").join(",");
    const keep = RETAINED_KINDS.map(() => "?").join(",");
    const stmt = await db.prepare(
      `DELETE FROM calls
         WHERE run_id IN (${ids})
           AND kind NOT IN (${keep})
           AND seq NOT IN (
             SELECT MAX(seq) FROM calls
              WHERE run_id IN (${ids}) AND kind = 'record'
                AND json_valid(content)
                AND json_extract(content, '$.op') IN ('memory', 'memoryUpdate')
              GROUP BY run_id, scope_id, json_extract(content, '$.child'))`,
    );
    try {
      const result = await stmt.run(...batch, ...RETAINED_KINDS, ...batch);
      rows += Number(result.changes ?? 0);
    } catch (err) {
      // The whole-file fallback engine applies the DELETE in memory and THEN
      // exports the file; near the wasm heap's limit that export can fail.
      // Continue when the rows are gone (the VACUUM below persists the small
      // image); a real SQL failure left them behind — rethrow.
      if ((await droppableRunIds(db, batch)).size) throw err;
      rows += batch.length;
    }
  }
  return rows;
}

/** Delete whole sessions, checkpoints included (tier 3). Returns rows removed. */
async function deleteWholeSessions(db: SqliteDatabase, runIds: string[]): Promise<number> {
  let rows = 0;
  for (const batch of chunks(runIds, CHUNK)) {
    const ids = batch.map(() => "?").join(",");
    try {
      const result = await (await db.prepare(`DELETE FROM calls WHERE run_id IN (${ids})`)).run(
        ...batch,
      );
      rows += Number(result.changes ?? 0);
    } catch (err) {
      const left = await get(db, `SELECT COUNT(*) n FROM calls WHERE run_id IN (${ids})`);
      if (Number(left?.n ?? 0) > 0) throw err;
    }
    try {
      await (await db.prepare(`DELETE FROM checkpoints WHERE run_id IN (${ids})`)).run(...batch);
    } catch (err) {
      const left = await get(db, `SELECT COUNT(*) n FROM checkpoints WHERE run_id IN (${ids})`);
      if (Number(left?.n ?? 0) > 0) throw err;
    }
  }
  return rows;
}

/**
 * Apply the session tiers. Returns null when every session is inside the hot
 * window (or has no timestamp), so the common throttled pass does one marker
 * read and stops. Rows only change for sessions past a boundary; VACUUM runs
 * only after a delete, because it rewrites the file.
 */
export async function trimSessionTiers(
  db: SqliteDatabase,
  tiers: RunLogTiers = RUN_LOG_TIERS,
): Promise<SessionTierTrim | null> {
  const sessions = await readWebSessions(db);
  if (!sessions.size) return null;

  const now = Date.now();
  const compact: WebSession[] = [];
  const drop: WebSession[] = [];
  for (const s of sessions.values()) {
    if (!s.lastTs) continue; // unknown age: the size policy owns it
    const age = now - s.lastTs;
    if (age > tiers.deleteDays * DAY_MS) {
      drop.push(s);
      continue;
    }
    if (s.checkpointed) continue; // a paused run replays the whole stream
    if (s.deleted || age > tiers.hotDays * DAY_MS) compact.push(s);
  }
  if (!compact.length && !drop.length) return null;

  const before = await runLogBytes(db);
  let compacted = 0;
  let rows = 0;

  if (compact.length) {
    const ids = compact.flatMap(sessionRunIds);
    const droppable = await droppableRunIds(db, ids);
    const toTrim = ids.filter((id) => droppable.has(id));
    compacted = compact.filter((s) => sessionRunIds(s).some((id) => droppable.has(id))).length;
    if (toTrim.length) rows += await compactRuns(db, toTrim);
  }

  const deleted = drop.length;
  if (drop.length) rows += await deleteWholeSessions(db, drop.flatMap(sessionRunIds));

  if (!rows) return null;
  let vacuumed = false;
  try {
    await db.exec("VACUUM");
    vacuumed = true;
  } catch {
    /* fallback engines may not have the headroom; rows are still gone */
  }
  return {
    beforeBytes: before,
    afterBytes: await runLogBytes(db),
    compacted,
    deleted,
    rows,
    vacuumed,
  };
}
