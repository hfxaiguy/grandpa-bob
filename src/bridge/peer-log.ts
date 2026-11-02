/**
 * The desktop-side mirror of a paired profile's run log.
 *
 * The browser tab owns the real log (`logs/grandma-kat.db` in its OPFS
 * workspace). That path is excluded from the workspace sync on purpose — the
 * engine excludes `logs/` ([hashmap.ts](../web/src/sync/hashmap.ts)) and
 * db-sync skips the run log ("append-only and large", [db-sync.ts]) — so the
 * two sides never race on one SQLite file.
 *
 * Instead the tab streams its rows over the paired channel's control plane:
 *
 *   tab  →  log-handshake { epoch, max }      (once per connection)
 *   desk →  log-cursor    { epoch, cursor }
 *   tab  →  log-batch     { epoch, events[] } (ascending seqs, one batch in flight)
 *   desk →  log-ack       { upTo }
 *
 * The stream is append-only with a single writer, so no LWW or merge logic is
 * needed: `cursor` is the highest seq stored, resends are deduped by seq, and
 * an epoch change (a recreated browser log) or a regressed max seq (the tab's
 * log was cleared) resets the desktop copy.
 *
 * Rows keep grandma-kat's `calls` shape (see `LOG_TABLES` in
 * grandma-kat/src/logstore.mjs) so the desktop copy reads like any other run
 * log. Checkpoints are not shipped: the desktop never resumes a browser run.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { peerLogPath } from "./store.js";

/** Same order/shape as grandma-kat's engine log; `seq` is the tab's address. */
const PEER_LOG_DDL = `
CREATE TABLE IF NOT EXISTS calls (
  run_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_path TEXT,
  iteration INTEGER,
  scope_id INTEGER,
  kind TEXT NOT NULL,
  content TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_kind ON calls(kind);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

/** Rows larger than this keep their address + a preview, not the bytes. */
const MAX_CONTENT_BYTES = 256 * 1024;
/** Hard cap per batch; the tab sends far fewer, this only bounds a bad peer. */
const MAX_BATCH_ROWS = 500;
/** The desktop copy keeps at least its recent history, not every row forever. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const TRIM_FRACTION = 0.25;

export interface PeerLogEvent {
  seq: number;
  run_id?: string;
  definition_id?: string;
  branch_path?: string | null;
  iteration?: number | null;
  scope_id?: number | null;
  kind: string;
  content?: unknown;
}

export interface PeerLogStatus {
  epoch: string;
  /** Highest seq the desktop holds (the stream's ack watermark). */
  cursor: number;
  /** Rows held (the whole copy, not the current query window). */
  total: number;
}

export interface PeerLogAppendResult extends PeerLogStatus {
  /** Rows accepted by this batch (after dedupe/validation). */
  inserted: number;
  /** Rows skipped by this batch (oversized content, malformed shape). */
  skipped: number;
  /** Set when the batch was refused (stale epoch, etc.). */
  error?: string;
}

export interface PeerLogQuery {
  /** Exact kinds to include; empty/absent means every row. */
  kinds?: string[];
  /**
   * Failed turns and engine/tool errors only: `llm_error`, `tool_error`, or a
   * `web_turn_end` marker whose content says `status: "error"`. This is the
   * default window the CLI shows, and it overrides `kinds`.
   */
  errorOnly?: boolean;
  /** Rows returned (newest window; ascending in the result). */
  limit?: number;
  /** Only rows with seq > after (a follow cursor). */
  after?: number;
}

export interface PeerLogRead extends PeerLogStatus {
  rows: PeerLogEvent[];
}

function openWrite(profile: string): DatabaseSync {
  const file = peerLogPath(profile);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(PEER_LOG_DDL);
  return db;
}

function openRead(profile: string): DatabaseSync | null {
  const file = peerLogPath(profile);
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  } catch {
    return null;
  }
}

function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

function countRows(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function statusOf(db: DatabaseSync): PeerLogStatus {
  return {
    epoch: getMeta(db, "epoch") ?? "",
    cursor: Number(getMeta(db, "cursor") ?? 0) || 0,
    total: countRows(db),
  };
}

/**
 * Keep the copy bounded: drop the oldest quarter of rows once the used page
 * image passes the budget. Deleted pages go to the freelist, so subsequent
 * inserts reuse them and the file stabilizes near the cap. Housekeeping, never
 * fatal to the stream.
 */
function trimIfOversized(db: DatabaseSync): void {
  try {
    const pageCount = Number(
      (db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined)?.page_count ?? 0,
    );
    const freeList = Number(
      (db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined)
        ?.freelist_count ?? 0,
    );
    const pageSize = Number(
      (db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined)?.page_size ?? 0,
    );
    if ((pageCount - freeList) * pageSize <= MAX_LOG_BYTES) return;
    const total = countRows(db);
    const keep = Math.floor(total * (1 - TRIM_FRACTION));
    if (keep <= 0) return;
    const row = db
      .prepare("SELECT seq FROM calls ORDER BY seq DESC LIMIT 1 OFFSET ?")
      .get(keep - 1) as { seq?: number } | undefined;
    if (typeof row?.seq !== "number") return;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM calls WHERE seq <= ?").run(row.seq);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  } catch {
    /* retention is housekeeping; the stream keeps working */
  }
}

function resetRows(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM calls");
    setMeta(db, "cursor", "0");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Announce the tab's stream identity. Returns the effective cursor the tab
 * should resume from. A different epoch — or a `max` below the stored cursor,
 * i.e. the tab's log was recreated — clears the desktop copy instead of mixing
 * two sequence spaces.
 */
export async function handshakePeerLog(
  profile: string,
  opts: { epoch: string; max?: number },
): Promise<PeerLogStatus> {
  const epoch = String(opts.epoch ?? "").trim();
  if (!epoch) throw new Error("the log stream needs an epoch");
  await fs.mkdir(path.dirname(peerLogPath(profile)), { recursive: true });
  const db = openWrite(profile);
  try {
    const stored = getMeta(db, "epoch");
    const cursor = Number(getMeta(db, "cursor") ?? 0) || 0;
    // Omitted when the tab could not read its max: unknown is not zero.
    const max = typeof opts.max === "number" && Number.isFinite(opts.max) ? Math.max(0, opts.max) : undefined;
    const regressed = max !== undefined && max < cursor;
    const stale = stored !== null && (stored !== epoch || regressed);
    if (stale) resetRows(db);
    if (stored !== epoch || stale) setMeta(db, "epoch", epoch);
    return statusOf(db);
  } finally {
    db.close();
  }
}

/** Coerce one wire row into the calls shape; null when unusable. */
function normalizeRow(raw: unknown): { row: PeerLogEvent; content: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const seq = Number(r.seq);
  const kind = typeof r.kind === "string" ? r.kind.trim() : "";
  if (!Number.isFinite(seq) || seq <= 0 || !kind) return null;
  const runId = typeof r.run_id === "string" ? r.run_id : "";
  const definitionId = typeof r.definition_id === "string" ? r.definition_id : "";
  let content = "";
  try {
    content = JSON.stringify(r.content ?? null);
  } catch {
    content = JSON.stringify({ note: "content was not serializable" });
  }
  if (content.length > MAX_CONTENT_BYTES) {
    content = JSON.stringify({
      truncated: true,
      bytes: content.length,
      preview: content.slice(0, 4 * 1024),
    });
  }
  return {
    row: {
      seq,
      run_id: runId,
      definition_id: definitionId,
      branch_path: typeof r.branch_path === "string" ? r.branch_path : null,
      iteration: Number.isFinite(Number(r.iteration)) ? Number(r.iteration) : null,
      scope_id: Number.isFinite(Number(r.scope_id)) ? Number(r.scope_id) : null,
      kind: kind.slice(0, 64),
      content: r.content ?? null,
    },
    content,
  };
}

/**
 * Append one batch. Rows at or below the stored cursor are ignored (a resend
 * after a lost ack); a batch stamped with another epoch is refused so a stale
 * tab cannot splice a new sequence space into an old one.
 */
export async function appendPeerLog(
  profile: string,
  epoch: string,
  events: unknown[],
): Promise<PeerLogAppendResult> {
  await fs.mkdir(path.dirname(peerLogPath(profile)), { recursive: true });
  const db = openWrite(profile);
  try {
    const stored = getMeta(db, "epoch") ?? "";
    if (!stored || stored !== String(epoch ?? "")) {
      return { ...statusOf(db), inserted: 0, skipped: 0, error: "log epoch mismatch — handshake again" };
    }
    const cursor = Number(getMeta(db, "cursor") ?? 0) || 0;
    const rows: { row: PeerLogEvent; content: string }[] = [];
    let skipped = 0;
    for (const raw of Array.isArray(events) ? events.slice(0, MAX_BATCH_ROWS) : []) {
      const normalized = normalizeRow(raw);
      if (!normalized) {
        skipped++;
        continue;
      }
      // The stream is ordered by seq; older rows are duplicates, not updates.
      if (normalized.row.seq <= cursor) continue;
      rows.push(normalized);
    }
    rows.sort((a, b) => a.row.seq - b.row.seq);
    let inserted = 0;
    let high = cursor;
    if (rows.length) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const stmt = db.prepare(
          "INSERT OR IGNORE INTO calls (seq, run_id, definition_id, branch_path, iteration, scope_id, kind, content) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const { row, content } of rows) {
          const result = stmt.run(
            row.seq,
            row.run_id ?? "",
            row.definition_id ?? "",
            row.branch_path ?? null,
            row.iteration ?? null,
            row.scope_id ?? null,
            row.kind,
            content,
          );
          if (Number(result.changes) > 0) inserted++;
          if (row.seq > high) high = row.seq;
        }
        setMeta(db, "cursor", String(high));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
    return { ...statusOf(db), inserted, skipped };
  } finally {
    trimIfOversized(db);
    db.close();
  }
}

/** Latest rows (ascending), optionally filtered by kind and a follow cursor. */
export async function readPeerLog(profile: string, query: PeerLogQuery = {}): Promise<PeerLogRead> {
  const db = openRead(profile);
  if (!db) return { epoch: "", cursor: 0, total: 0, rows: [] };
  try {
    const limit = Math.max(1, Math.min(1000, Number(query.limit ?? 20) || 20));
    const after = Math.max(0, Number(query.after ?? 0) || 0);
    const kinds = (query.kinds ?? []).filter((k) => typeof k === "string" && k.trim()).slice(0, 20);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.errorOnly) {
      // One predicate so the limit applies to the error set, not to a page of
      // everything that then gets filtered client-side.
      where.push(
        "(kind IN ('llm_error','tool_error') OR " +
          "(kind = 'web_turn_end' AND json_valid(content) AND json_extract(content, '$.status') = 'error'))",
      );
    } else if (kinds.length) {
      where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds.map((k) => k.trim()));
    }
    if (after > 0) {
      where.push("seq > ?");
      params.push(after);
    }
    // No follow cursor: the newest window, returned ascending. With `after`:
    // the next window *after* the cursor in stream order, so a follower never
    // skips over rows behind a large tail.
    const forward = after > 0;
    const sql =
      "SELECT seq, run_id, definition_id, branch_path, iteration, scope_id, kind, content FROM calls" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY seq ${forward ? "ASC" : "DESC"} LIMIT ?`;
    params.push(limit);
    const raw = db.prepare(sql).all(...params) as Record<string, unknown>[];
    if (!forward) raw.reverse();
    const rows = raw.map((r): PeerLogEvent => {
      let content: unknown = null;
      try {
        content = r.content == null ? null : JSON.parse(String(r.content));
      } catch {
        content = r.content;
      }
      return {
        seq: Number(r.seq),
        run_id: String(r.run_id ?? ""),
        definition_id: String(r.definition_id ?? ""),
        branch_path: (r.branch_path as string | null) ?? null,
        iteration: r.iteration == null ? null : Number(r.iteration),
        scope_id: r.scope_id == null ? null : Number(r.scope_id),
        kind: String(r.kind ?? ""),
        content,
      };
    });
    return { ...statusOf(db), rows };
  } finally {
    db.close();
  }
}

export interface PeerLogStats extends PeerLogStatus {
  kinds: Array<{ kind: string; count: number }>;
}

/** Counts per kind, for `npm run peer:log -- --stats`. */
export async function statsPeerLog(profile: string): Promise<PeerLogStats> {
  const db = openRead(profile);
  if (!db) return { epoch: "", cursor: 0, total: 0, kinds: [] };
  try {
    const kinds = (
      db.prepare("SELECT kind, COUNT(*) AS n FROM calls GROUP BY kind ORDER BY n DESC, kind").all() as Array<{
        kind?: string;
        n?: number;
      }>
    ).map((r) => ({ kind: String(r.kind ?? ""), count: Number(r.n ?? 0) }));
    return { ...statusOf(db), kinds };
  } finally {
    db.close();
  }
}
