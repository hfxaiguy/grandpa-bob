/**
 * Browser session log — chat sessions live in the workspace's KAT log
 * (`logs/grandma-kat.db`) as host marker rows, the same format
 * `src/web-log.ts` writes on the Node side (definition_id "web"):
 *
 *   web_turn_end       one completed turn (input, bubbles, status, run bounds)
 *   web_session_label  a user rename (latest wins; empty re-derives)
 *   web_session_delete a tombstone (hidden from the picker, trace preserved)
 *   web_session_open   a key adopted from another transport
 *
 * The database belongs to whichever storage backend the page is using: OPFS,
 * or the desktop bridge (the real workspace on disk). That is what makes
 * sessions survive a reload without a server.
 *
 * All access goes through one serial queue and one cached connection per
 * platform. The browser sqlite engine exports the whole file after every
 * mutation, so two overlapping writers (event flush + turn marker) would lose
 * rows.
 */
import type { Platform } from "../platform/types";
import type { DerivedTurn, StoredSession, TurnMarker } from "../web-log-types";
import type { MemoryWrite } from "../memory-track";
import { sanitizeEvent, type SanitizedEvent } from "../sanitize";
import { newTurnApps, seedPausedApp, tagEventApp } from "../app-attribution";
import { emitValue, type EmitComponent } from "../util/emit-text";
import { listAppTrees } from "../tree-sources";
import { LOG_TABLES } from "grandma-kat";
import type { KatEvent } from "./logger";
import { mib, trimRunLog, trimSessionTiers } from "./runlog-retention";

export const MARKER_TURN = "web_turn_end";
export const MARKER_LABEL = "web_session_label";
export const MARKER_DELETE = "web_session_delete";
export const MARKER_OPEN = "web_session_open";
const MARKER_KINDS = [MARKER_TURN, MARKER_LABEL, MARKER_DELETE, MARKER_OPEN];

/** Turns kept per session in a response (matches src/web-log.ts). */
export const MAX_TURNS = 20;
/** Events kept per turn in a response (matches src/web-log.ts). */
export const MAX_TURN_EVENTS = 500;

// The engine's call + checkpoint schema comes from grandma-kat (the same DDL
// its SqliteLogger creates), so the browser log cannot drift from the Node
// logger's tables.
export const RUN_LOG_TABLES = LOG_TABLES;

/**
 * Keeps whole-log kind filters off a full scan; retried on the next boot.
 * Separate on purpose: building it is the schema's only allocation-heavy step,
 * and when the streaming VFS is unavailable that build runs in the whole-file
 * engine, where an old log can exhaust the wasm heap. A deferred index must
 * not stop the log opening.
 */
export const RUN_LOG_INDEX = "CREATE INDEX IF NOT EXISTS idx_calls_kind ON calls(kind)";

/** The complete schema, for tests and tools that want it in one step. */
export const RUN_LOG_DDL = `${RUN_LOG_TABLES}
${RUN_LOG_INDEX}`;

// Legacy rows: memory writes used to be logged with their own kind
// ('memory') before record rows carried an op flag (2026-09-21). The Node
// logger converts them once on open; a browser profile seeded by an older
// web bundle can still carry them, so the shared log store converts them
// too — kind 'record', op 'memory' (or 'memoryUpdate' for a legacy truthy
// `update` flag), patch: true so replay semantics are unchanged (the slot
// is set, no prev/raw entry is pushed).
const LEGACY_MEMORY_ROWS = `
  UPDATE calls SET kind = 'record', content = json_remove(json_set(content,
    '$.op', CASE WHEN json_extract(content, '$.update') IS NOT NULL
                      AND json_extract(content, '$.update') != 0
                 THEN 'memoryUpdate' ELSE 'memory' END,
    '$.patch', json('true')), '$.update')
  WHERE kind = 'memory'`;

export interface SessionSummary extends StoredSession {
  awaiting?: string | null;
}

type Db = Awaited<ReturnType<Platform["sqlite"]["open"]>>;

export function logDbPath(platform: Platform): string {
  return platform.path.join(platform.workspaceRoot, "logs/grandma-kat.db");
}

// One queue per database file *within this JS context*. Every write in the
// browser (event flushes and session markers) goes through it.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(dbPath: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(dbPath) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(
    dbPath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** The open log DB for a platform (one cached handle, schema ensured once). */
const handles = new WeakMap<Platform, Promise<unknown>>();

/** Throttle for the steady-state size check; the first open always checks. */
const TRIM_INTERVAL_MS = 5 * 60_000;
const lastTrimAt = new Map<string, number>();

/**
 * Keep the run log under its size budget. Runs on first open (which is the
 * rescue path for an oversized legacy log) and, throttled, after each turn.
 * Failures are notes, never turn failures: retention is housekeeping.
 */
async function maybeTrim(platform: Platform, db: Db, force = false): Promise<void> {
  const key = logDbPath(platform);
  const now = Date.now();
  if (!force && now - (lastTrimAt.get(key) ?? 0) < TRIM_INTERVAL_MS) return;
  lastTrimAt.set(key, now);
  try {
    // Tier compaction first: it keeps the picker, turn summaries and memory
    // restore intact while reclaiming the trace, so the size-driven trim
    // below only has to delete whole runs when that still is not enough.
    const tiered = await trimSessionTiers(db);
    if (tiered) {
      console.info(
        `[runlog] compacted ${tiered.compacted} session(s), deleted ${tiered.deleted}: ` +
          `${mib(tiered.beforeBytes)} → ${mib(tiered.afterBytes)} (${tiered.rows} rows)`,
      );
    }
    const result = await trimRunLog(db);
    if (result) {
      console.info(
        `[runlog] trimmed ${mib(result.beforeBytes)} → ${mib(result.afterBytes)} ` +
          `(${result.runs} runs, ${result.sessions} sessions, ${result.rows} rows)`,
      );
    }
  } catch (err) {
    console.warn("[runlog] retention failed:", err);
  }
}

async function dbFor(platform: Platform): Promise<Db> {
  const path = logDbPath(platform);
  let pending = handles.get(platform) as Promise<Db> | undefined;
  if (!pending) {
    pending = (async () => {
      await platform.fs.mkdir(platform.path.dirname(path), { recursive: true }).catch(() => {});
      const db = await platform.sqlite.open(path, { readOnly: false });
      await db.exec(RUN_LOG_TABLES);
      // Separate from the tables so a failed build degrades to full scans
      // instead of wedging every log read and turn. The next boot (or the
      // retention pass below) retries it.
      try {
        await db.exec(RUN_LOG_INDEX);
      } catch (err) {
        console.warn("[runlog] could not build idx_calls_kind; continuing without it:", err);
      }
      // With the index built this guard is an index seek: an already-converted
      // profile costs one lookup per open.
      if ((await (await db.prepare("SELECT 1 x FROM calls WHERE kind = 'memory' LIMIT 1")).get())) {
        await db.exec(LEGACY_MEMORY_ROWS);
      }
      // First open of the session: an oversized log gets its one trim now,
      // before reads start paying for it.
      await maybeTrim(platform, db, true);
      return db;
    })();
    pending.catch(() => handles.delete(platform));
    handles.set(platform, pending);
  }
  return pending;
}

/** Run `task` against the log DB, serialized with every other log access. */
export async function withLogDb<T>(
  platform: Platform,
  task: (db: Db) => Promise<T>,
): Promise<T> {
  return enqueue(logDbPath(platform), async () => task(await dbFor(platform)));
}

// ── seq allocation ───────────────────────────────────────────────────────
// Refs are `ref://<label>.<seq>` addresses into THIS table, so the seq the
// engine logs must be the row's seq on disk — not a per-session counter. One
// cursor per log DB is shared by every logger in this worker; it is seeded from
// MAX(seq) once and then handed out synchronously (knit's logger contract is
// synchronous). Turn markers allocate from it too, so a marker never steals
// the next engine seq.

const cursors = new Map<string, number>();

async function seedCursor(platform: Platform): Promise<number> {
  const key = logDbPath(platform);
  const row = (await withLogDb(platform, async (db) => {
    return (await (await db.prepare("SELECT COALESCE(MAX(seq), 0) m FROM calls")).get()) as
      | { m: number }
      | undefined;
  })) ?? { m: 0 };
  const max = Number(row.m ?? 0);
  const current = cursors.get(key) ?? 0;
  if (current < max) cursors.set(key, max);
  return cursors.get(key) ?? 0;
}

/** Seed the seq cursor from the log DB (idempotent, safe to await repeatedly). */
export async function ensureLogCursor(platform: Platform): Promise<void> {
  if (cursors.has(logDbPath(platform))) return;
  await seedCursor(platform);
}

/** The next row seq. Requires ensureLogCursor() to have completed. */
export function nextLogSeq(platform: Platform): number {
  const key = logDbPath(platform);
  const seq = (cursors.get(key) ?? 0) + 1;
  cursors.set(key, seq);
  return seq;
}

function adoptLogSeq(platform: Platform, seq: number): void {
  const key = logDbPath(platform);
  if ((cursors.get(key) ?? 0) < seq) cursors.set(key, seq);
}

// ── writes ───────────────────────────────────────────────────────────────

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insertCalls(events: KatEvent[]): string {
  const values = events.map(
    (e) =>
      `(${[
        sqlLiteral(e.seq),
        sqlLiteral(e.run_id),
        sqlLiteral(e.definition_id),
        sqlLiteral(e.branch_path ?? null),
        sqlLiteral(e.iteration ?? null),
        sqlLiteral(e.scope_id ?? null),
        sqlLiteral(e.kind),
        sqlLiteral(JSON.stringify(e.content ?? null)),
      ].join(",")})`,
  );
  return `INSERT INTO calls (seq, run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES ${values.join(",")}`;
}

/** Persist one batch of engine events (the logger's flush). */
export async function appendEvents(platform: Platform, events: KatEvent[]): Promise<void> {
  if (!events.length) return;
  await ensureLogCursor(platform);
  await withLogDb(platform, async (db) => {
    // The DB may have rows we did not write (a Telegram turn through the
    // desktop bridge). Re-key the batch to start after its max seq so an
    // explicit-seq insert cannot collide. Refs cite rows flushed in earlier
    // batches, so the pending batch is safe to move.
    const row = (await (
      await db.prepare("SELECT COALESCE(MAX(seq), 0) m FROM calls")
    ).get()) as { m: number } | undefined;
    const max = Number(row?.m ?? 0);
    const first = events[0].seq;
    if (typeof first === "number" && max >= first) {
      const shift = max + 1 - first;
      for (const e of events) if (typeof e.seq === "number") e.seq += shift;
    }
    await db.exec(insertCalls(events));
    const last = events[events.length - 1].seq;
    if (typeof last === "number") adoptLogSeq(platform, last);
  });
}

async function insertMarker(
  db: Db,
  platform: Platform,
  runId: string,
  kind: string,
  content: unknown,
): Promise<void> {
  const seq = nextLogSeq(platform);
  const stmt = await db.prepare(
    "INSERT INTO calls (seq, run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, ?, 'web', NULL, 0, NULL, ?, ?)",
  );
  await stmt.run(seq, runId, kind, JSON.stringify(content));
}

/** Persist a finished turn; computes the event-seq bounds from the run id. */
export async function writeTurnEnd(platform: Platform, m: TurnMarker): Promise<void> {
  await ensureLogCursor(platform);
  await withLogDb(platform, async (db) => {
    let fromSeq: number | null = null;
    let toSeq: number | null = null;
    if (m.runId) {
      const max = (await (
        await db.prepare("SELECT MAX(seq) m FROM calls WHERE run_id = ?")
      ).get(m.runId)) as { m: number | null } | undefined;
      toSeq = max?.m == null ? null : Number(max.m);
      // A resumed conversation keeps the run id: start after the previous
      // turn's bound so a reloaded turn replays only its own tail.
      const prev = (await (
        await db.prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      ).get(m.key, MARKER_TURN)) as { content: string } | undefined;
      let prevMarker: TurnMarker | null = null;
      if (prev) {
        try {
          prevMarker = JSON.parse(prev.content) as TurnMarker;
        } catch {
          prevMarker = null;
        }
      }
      fromSeq = prevMarker && prevMarker.runId === m.runId ? (prevMarker.toSeq ?? 0) : 0;
    }
    await insertMarker(db, platform, m.key, MARKER_TURN, {
      ...m,
      fromSeq,
      toSeq,
      ts: Date.now(),
    });
    // Turn boundaries are the natural retention point: the log just grew, and
    // no engine run is mid-flight. Throttled inside maybeTrim.
    await maybeTrim(platform, db);
  });
}

export async function writeLabel(platform: Platform, key: string, label: string): Promise<void> {
  await ensureLogCursor(platform);
  await withLogDb(platform, (db) =>
    insertMarker(db, platform, key, MARKER_LABEL, { key, label, ts: Date.now() }),
  );
}

export async function writeDelete(platform: Platform, key: string): Promise<void> {
  await ensureLogCursor(platform);
  await withLogDb(platform, (db) =>
    insertMarker(db, platform, key, MARKER_DELETE, { key, ts: Date.now() }),
  );
}

export async function ensureOpen(platform: Platform, key: string, label = ""): Promise<void> {
  await ensureLogCursor(platform);
  await withLogDb(platform, async (db) => {
    const row = await (
      await db.prepare("SELECT 1 x FROM calls WHERE run_id = ? AND kind = ? LIMIT 1")
    ).get(key, MARKER_OPEN);
    if (!row) await insertMarker(db, platform, key, MARKER_OPEN, { key, label, ts: Date.now() });
  });
}

// ── checkpoints ─────────────────────────────────────────────────────────
// The engine pauses by saving a checkpoint; this store shadows it into the
// same table the Node logger uses (grandma-kat's `checkpoints`), so a reloaded
// worker can restore. Rows are tiny: resume positions + run/seq. The KAT log
// store component orders a checkpoint write after every call row it depends on
// (see `createSessionLogStore`), so a row on disk always has its replay window.

export interface CheckpointRow {
  id: string;
  run_id: string;
  seq: number;
  resume_positions: string;
}

function normalizeCheckpointRow(row: unknown): CheckpointRow | null {
  const r = row as Record<string, unknown> | null;
  if (!r) return null;
  const seq = Number(r.seq);
  if (typeof r.id !== "string" || typeof r.run_id !== "string" || !Number.isFinite(seq)) {
    return null;
  }
  return {
    id: r.id,
    run_id: r.run_id,
    seq,
    resume_positions: typeof r.resume_positions === "string" ? r.resume_positions : "[]",
  };
}

export async function saveCheckpointRow(platform: Platform, row: CheckpointRow): Promise<void> {
  await withLogDb(platform, async (db) => {
    const stmt = await db.prepare(
      "INSERT OR REPLACE INTO checkpoints (id, run_id, seq, resume_positions) VALUES (?, ?, ?, ?)",
    );
    await stmt.run(row.id, row.run_id, row.seq, row.resume_positions);
  });
}

export async function deleteCheckpointRow(platform: Platform, id: string): Promise<void> {
  await withLogDb(platform, async (db) => {
    const stmt = await db.prepare("DELETE FROM checkpoints WHERE id = ?");
    await stmt.run(id);
  });
}

export async function loadCheckpointRow(
  platform: Platform,
  id: string,
): Promise<CheckpointRow | null> {
  return withLogDb(platform, async (db) => {
    const row = await (
      await db.prepare("SELECT id, run_id, seq, resume_positions FROM checkpoints WHERE id = ?")
    ).get(id);
    return normalizeCheckpointRow(row);
  });
}

async function latestCheckpointRow(db: Db, runId: string): Promise<CheckpointRow | null> {
  const row = await (
    await db.prepare(
      "SELECT id, run_id, seq, resume_positions FROM checkpoints WHERE run_id = ? ORDER BY rowid DESC LIMIT 1",
    )
  ).get(runId);
  return normalizeCheckpointRow(row);
}

export interface ResumableCheckpoint {
  checkpoint: CheckpointRow;
  runId: string;
}

/**
 * The checkpoint a session should resume after a restart, or null.
 *
 * Policy (the host's): the latest turn's run is the resumable one, and only
 * while that run still has a checkpoint row — a finished run deletes its
 * checkpoint, so "latest marker + checkpoint" is exactly "paused". An explicit
 * delete marker after the pause tombstones the conversation.
 */
export async function resumableCheckpoint(
  platform: Platform,
  key: string,
): Promise<ResumableCheckpoint | null> {
  return withLogDb(platform, async (db) => {
    const markerRow = (await (
      await db.prepare(
        "SELECT seq, content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1",
      )
    ).get(key, MARKER_TURN)) as { seq?: number; content?: string } | undefined;
    const marker = parseJson(markerRow?.content) as TurnMarker | null;
    if (!marker || typeof marker.runId !== "string" || !marker.runId) return null;

    const deletedRow = (await (
      await db.prepare(
        "SELECT seq, content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1",
      )
    ).get(key, MARKER_DELETE)) as { seq?: number; content?: string } | undefined;
    if (deletedRow && Number(deletedRow.seq) > Number(markerRow?.seq)) {
      // An explicit delete after the pause tombstones the conversation (seq
      // order, not wall-clock: markers are appended in log order).
      return null;
    }

    const checkpoint = await latestCheckpointRow(db, marker.runId);
    if (!checkpoint) return null;
    return { checkpoint, runId: marker.runId };
  });
}

// ── reads ────────────────────────────────────────────────────────────────

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowContent(row: { content: string } | undefined): Record<string, unknown> | null {
  const parsed = parseJson(row?.content);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

export interface LogRow {
  seq: number;
  run_id: string;
  definition_id?: string;
  branch_path: string | null;
  iteration?: number | null;
  scope_id?: number | null;
  kind: string;
  content: unknown;
}

/** One run-log row by seq, content parsed — the store behind `ref://` handles. */
export async function readRow(platform: Platform, seq: number): Promise<LogRow | null> {
  return withLogDb(platform, async (db) => {
    const row = (await (
      await db.prepare("SELECT * FROM calls WHERE seq = ?")
    ).get(seq)) as { content: string | null } | undefined;
    if (!row) return null;
    return {
      ...(row as unknown as Omit<LogRow, "content">),
      content: parseJson(row.content),
    } as LogRow;
  });
}

/**
 * A run's event rows, oldest first (optionally only up to a checkpoint seq) —
 * the replay window `createSessionLogStore.restore()` hydrates.
 */
export async function loadRunEvents(
  platform: Platform,
  runId: string,
  upToSeq?: number,
): Promise<LogRow[]> {
  return withLogDb(platform, async (db) => {
    const bounded = typeof upToSeq === "number";
    const rows = (await (
      await db.prepare(
        bounded
          ? "SELECT * FROM calls WHERE run_id = ? AND seq <= ? ORDER BY seq"
          : "SELECT * FROM calls WHERE run_id = ? ORDER BY seq",
      )
    ).all(...(bounded ? [runId, upToSeq] : [runId]))) as { content: string | null }[];
    return rows.map(
      (row) =>
        ({
          ...(row as unknown as Omit<LogRow, "content">),
          content: parseJson(row.content),
        }) as LogRow,
    );
  });
}

/**
 * A logical snapshot of the run log for workspace export. The streaming VFS
 * keeps its own file layout under `.gpb-runlog`, so the archive needs SQLite's
 * page image, not the OPFS bytes.
 */
export async function exportLogDb(platform: Platform): Promise<Uint8Array | null> {
  const exportBytes = platform.sqlite.exportBytes;
  if (!exportBytes) return null;
  return withLogDb(platform, () => exportBytes.call(platform.sqlite, logDbPath(platform)));
}

/** The picker: every session key in the log, minus deletions. */
export async function listSessions(
  platform: Platform,
  describeKey: (key: string) => string,
): Promise<SessionSummary[]> {
  return withLogDb(platform, async (db) => {
    const rows = (await (
      await db.prepare(
        `SELECT run_id, kind, content, seq FROM calls WHERE kind IN (${MARKER_KINDS.map(() => "?").join(",")}) ORDER BY seq`,
      )
    ).all(...MARKER_KINDS)) as { run_id: string; kind: string; content: string; seq: number }[];

    const byKey = new Map<
      string,
      {
        label?: string;
        labelTs: number;
        open?: string;
        deleted: boolean;
        turns: number;
        updatedAt: number;
        awaiting: string | null;
        firstInput: string;
      }
    >();
    for (const r of rows) {
      const c = rowContent(r);
      if (!c) continue;
      const key = r.run_id;
      let e = byKey.get(key);
      if (!e) {
        e = { labelTs: 0, deleted: false, turns: 0, updatedAt: 0, awaiting: null, firstInput: "" };
        byKey.set(key, e);
      }
      const ts = Number(c.ts) || 0;
      if (r.kind === MARKER_TURN) {
        e.turns++;
        e.updatedAt = Math.max(e.updatedAt, Number(c.endedAt) || ts);
        if (typeof c.awaiting === "string") e.awaiting = c.awaiting;
        if (!e.firstInput && typeof c.input === "string" && c.input.trim()) e.firstInput = c.input;
      } else if (r.kind === MARKER_LABEL) {
        e.label = typeof c.label === "string" ? c.label : "";
        e.labelTs = ts;
        e.updatedAt = Math.max(e.updatedAt, ts);
      } else if (r.kind === MARKER_OPEN) {
        e.open = typeof c.label === "string" ? c.label : "";
        e.updatedAt = Math.max(e.updatedAt, ts);
      } else if (r.kind === MARKER_DELETE) {
        e.deleted = true;
      }
    }

    const out: SessionSummary[] = [];
    for (const [key, e] of byKey) {
      if (e.deleted) continue;
      const isWeb = key.startsWith("web:");
      // A freshly minted chat with no turns and no label is an empty shell.
      if (!e.turns && e.open === undefined && !(isWeb && e.labelTs)) continue;
      const label = e.label && e.label.trim()
        ? e.label
        : e.firstInput
          ? e.firstInput.slice(0, 80)
          : e.open && e.open.trim()
            ? e.open
            : describeKey(key);
      out.push({
        key,
        label,
        pattern: "",
        updatedAt: e.updatedAt,
        turns: e.turns,
        remote: false,
        awaiting: e.awaiting,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

/** A session's turns, oldest first (latest MAX_TURNS), optionally with tails. */
export async function getTurns(
  platform: Platform,
  key: string,
  opts: { withEvents?: boolean } = {},
): Promise<DerivedTurn[]> {
  return withLogDb(platform, async (db) => {
    // The registry the live host tags with: nested app calls are tile
    // boundaries in the stored stream too.
    const appNames = await appNamesOf(platform);
    const rows = (await (
      await db.prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq")
    ).all(key, MARKER_TURN)) as { content: string }[];
    const markers: TurnMarker[] = [];
    for (const r of rows) {
      const parsed = parseJson(r.content);
      if (parsed && typeof parsed === "object") markers.push(parsed as TurnMarker);
    }
    const kept = markers.slice(-MAX_TURNS);
    const out: DerivedTurn[] = [];
    for (const m of kept) {
      const t: DerivedTurn = {
        turnId: m.turnId,
        runId: m.runId,
        input: m.input ?? "",
        inputApp: m.inputApp,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        status: m.status === "error" ? "error" : m.status === "stopped" ? "stopped" : "done",
        error: m.error ?? null,
        output: m.output ?? null,
        emits: m.emits ?? null,
        levels: m.levels ?? null,
        emitApps: m.emitApps ?? null,
        components: m.components ?? null,
        buttons: m.buttons ?? null,
        fallback: m.fallback ?? null,
        awaiting: m.awaiting ?? null,
        runMode: m.runMode,
        contextLost: m.contextLost,
        events: [],
      };
      if (opts.withEvents && m.runId && m.fromSeq != null && m.toSeq != null) {
        const replayed = await turnEvents(db, m.runId, m.fromSeq, m.toSeq, appNames, m.inputApp);
        t.events = replayed.events;
        // The marker's emit tags were written under the old attribution rule;
        // the run log is authoritative when every stored bubble has one emit.
        if (!t.emits || replayed.emitApps.length === t.emits.length) t.emitApps = replayed.emitApps;
        // Turns persisted before component bubbles existed carry no
        // `components` field at all. The run log's raw emit rows do hold the
        // emitted value (`{ text, component, props }`), so rehydrate the
        // visual bubbles instead of degrading them to text forever.
        if (t.components == null && t.emits?.length && replayed.components.length === t.emits.length) {
          t.components = replayed.components;
        }
      }
      out.push(t);
    }
    return out;
  });
}

async function turnEvents(
  db: Db,
  runId: string,
  fromSeq: number,
  toSeq: number,
  appNames: string[],
  pausedApp?: string | null,
): Promise<{ events: SanitizedEvent[]; emitApps: string[]; components: (EmitComponent | null)[] }> {
  const bounds = "run_id = ? AND seq > ? AND seq <= ?";
  const trees = (await (
    await db.prepare(
      `SELECT seq, kind, content FROM calls WHERE ${bounds} AND kind IN ('tree_enter','tree_exit','tree_suspend') ORDER BY seq`,
    )
  ).all(runId, fromSeq, toSeq)) as { seq: number; kind: string; content: string }[];
  const app = appLookup(trees.map((t) => ({ seq: t.seq, kind: t.kind, content: parseJson(t.content) })), appNames, pausedApp);
  // Emit tags come from the full range, not the capped tail: bubbles must line
  // up with the marker's stored emits even in a very long turn. The raw value
  // is read here too: turns from before component bubbles can recover their
  // `{ component, props }` from it (see getTurns).
  const emits = (await (
    await db.prepare(`SELECT seq, content FROM calls WHERE ${bounds} AND kind = 'emit' ORDER BY seq`)
  ).all(runId, fromSeq, toSeq)) as { seq: number; content: string | null }[];
  const tail = (await (
    await db.prepare(`SELECT * FROM calls WHERE ${bounds} ORDER BY seq DESC LIMIT ${MAX_TURN_EVENTS}`)
  ).all(runId, fromSeq, toSeq)) as {
    seq: number;
    kind: string;
    branch_path: string | null;
    iteration: number | null;
    scope_id: number | null;
    content: string | null;
  }[];
  const events = tail.reverse().map((r) =>
    sanitizeEvent(
      {
        kind: r.kind,
        branch_path: r.branch_path ?? "",
        iteration: r.iteration ?? 0,
        scope_id: r.scope_id,
        seq: r.seq,
        content: (parseJson(r.content) as Record<string, unknown> | null) ?? {},
      },
      app(r.seq),
    ),
  );
  const emitRows = emits.map((e) => {
    const content = parseJson(e.content) as { value?: unknown } | null;
    const { component } = emitValue(content?.value ?? "");
    return { seq: e.seq, component: component ?? null };
  });
  return {
    events,
    emitApps: emitRows.map((e) => app(e.seq)),
    components: emitRows.map((e) => e.component),
  };
}

/** The workspace's runnable app-tree names — the tile boundaries. */
async function appNamesOf(platform: Platform): Promise<string[]> {
  return (await listAppTrees(platform.workspaceRoot).catch(() => [])).map((a) => a.name);
}

function appLookup(
  treeEvents: { seq: number; kind: string; content: unknown }[],
  appNames?: Iterable<string>,
  pausedApp?: string | null,
): (seq: number) => string {
  const st = newTurnApps(appNames);
  // A resumed turn starts inside the app it was paused in: the engine logs the
  // human delivery before the subtree's tree_enter, so the turn window's first
  // rows would otherwise fall to the trunk.
  seedPausedApp(st, pausedApp);
  const seeded = st.current;
  const recs: { seq: number; app: string; after: string }[] = [];
  for (const ev of treeEvents) {
    const app = tagEventApp(st, ev);
    recs.push({ seq: ev.seq, app, after: st.current });
  }
  return (seq: number) => {
    let lo = 0;
    let hi = recs.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (recs[mid].seq <= seq) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (ans < 0) return seeded;
    const r = recs[ans];
    return r.seq === seq ? r.app : r.after;
  };
}

/**
 * Every memory-slot write of a session's persisted turns, oldest first, with
 * the engine's own values (mirrors `WebLog.memoryWrites` on the Node side).
 *
 * Deliberately NOT the sanitized per-turn event window `getTurns` builds: that
 * window is tail-capped (MAX_TURN_EVENTS) and its values are truncated for
 * streaming, so a slot written early in a very long turn — or one holding a
 * large array/string — would restore wrong or not at all. This scans the raw
 * `calls` rows for each turn's seq bounds instead, and is not turn-capped.
 * Turns without run bounds (migrated legacy markers) are skipped.
 */
export async function memoryWrites(platform: Platform, key: string): Promise<MemoryWrite[]> {
  return withLogDb(platform, async (db) => {
    const appNames = await appNamesOf(platform);
    const rows = (await (
      await db.prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq")
    ).all(key, MARKER_TURN)) as { content: string }[];
    const out: MemoryWrite[] = [];
    for (const r of rows) {
      const parsed = parseJson(r.content);
      if (!parsed || typeof parsed !== "object") continue;
      const m = parsed as TurnMarker;
      if (!m.runId || m.fromSeq == null || m.toSeq == null) continue;
      out.push(...(await memoryRows(db, m.runId, m.fromSeq, m.toSeq, appNames, m.inputApp)));
    }
    return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  });
}

/** Raw memory-write rows in one turn's (fromSeq, toSeq], app-tagged. */
async function memoryRows(
  db: Db,
  runId: string,
  fromSeq: number,
  toSeq: number,
  appNames: string[],
  pausedApp?: string | null,
): Promise<MemoryWrite[]> {
  const bounds = "run_id = ? AND seq > ? AND seq <= ?";
  const trees = (await (
    await db.prepare(
      `SELECT seq, kind, content FROM calls WHERE ${bounds} AND kind IN ('tree_enter','tree_exit','tree_suspend') ORDER BY seq`,
    )
  ).all(runId, fromSeq, toSeq)) as { seq: number; kind: string; content: string }[];
  const app = appLookup(trees.map((t) => ({ seq: t.seq, kind: t.kind, content: parseJson(t.content) })), appNames, pausedApp);
  const rows = (await (
    await db.prepare(
      `SELECT seq, kind, branch_path, scope_id, content FROM calls WHERE ${bounds} AND kind = 'record' ORDER BY seq`,
    )
  ).all(runId, fromSeq, toSeq)) as {
    seq: number;
    kind: string;
    branch_path: string | null;
    scope_id: number | null;
    content: string | null;
  }[];
  const out: MemoryWrite[] = [];
  for (const r of rows) {
    const content = (parseJson(r.content) as Record<string, unknown> | null) ?? null;
    const op = content?.op;
    const memWrite = op === "memory" || op === "memoryUpdate";
    if (!memWrite) continue;
    out.push({
      seq: r.seq,
      kind: r.kind,
      branch_path: r.branch_path,
      scope_id: r.scope_id,
      content,
      app: app(r.seq),
    });
  }
  return out;
}

// ── one-key helpers ──────────────────────────────────────────────────────

export async function hasSession(platform: Platform, key: string): Promise<boolean> {
  return withLogDb(platform, async (db) => {
    const row = await (
      await db.prepare(
        `SELECT 1 x FROM calls WHERE run_id = ? AND kind IN (${MARKER_KINDS.map(() => "?").join(",")}) LIMIT 1`,
      )
    ).get(key, ...MARKER_KINDS);
    return !!row;
  });
}

export async function turnCount(platform: Platform, key: string): Promise<number> {
  return withLogDb(platform, async (db) => {
    const row = (await (
      await db.prepare("SELECT COUNT(*) n FROM calls WHERE run_id = ? AND kind = ?")
    ).get(key, MARKER_TURN)) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  });
}

export async function labelOf(platform: Platform, key: string): Promise<string> {
  return withLogDb(platform, async (db) => {
    const pin = rowContent(
      (await (
        await db.prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      ).get(key, MARKER_LABEL)) as { content: string } | undefined,
    );
    if (pin && typeof pin.label === "string" && pin.label.trim()) return pin.label;
    const first = rowContent(
      (await (
        await db.prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq ASC LIMIT 1")
      ).get(key, MARKER_TURN)) as { content: string } | undefined,
    );
    const input = first && typeof first.input === "string" ? first.input.trim() : "";
    if (input) return input.slice(0, 80);
    const open = rowContent(
      (await (
        await db.prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      ).get(key, MARKER_OPEN)) as { content: string } | undefined,
    );
    return open && typeof open.label === "string" ? open.label : "";
  });
}

export async function hasLabelPin(platform: Platform, key: string): Promise<boolean> {
  return withLogDb(platform, async (db) => {
    const pin = rowContent(
      (await (
        await db.prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      ).get(key, MARKER_LABEL)) as { content: string } | undefined,
    );
    return !!(pin && typeof pin.label === "string" && pin.label.trim());
  });
}

export async function lastAwaiting(platform: Platform, key: string): Promise<string | null> {
  return withLogDb(platform, async (db) => {
    const turn = rowContent(
      (await (
        await db.prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      ).get(key, MARKER_TURN)) as { content: string } | undefined,
    );
    return turn && typeof turn.awaiting === "string" ? turn.awaiting : null;
  });
}
