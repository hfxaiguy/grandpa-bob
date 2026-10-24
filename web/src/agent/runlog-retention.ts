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

async function get(db: SqliteDatabase, sql: string): Promise<Record<string, unknown> | undefined> {
  const stmt = await db.prepare(sql);
  return (await stmt.get()) as Record<string, unknown> | undefined;
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
