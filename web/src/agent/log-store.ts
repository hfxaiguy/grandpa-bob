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
 * the desktop bridge (the real workspace on disk) or a picked folder. That is
 * what makes sessions survive a reload without a server.
 *
 * All access goes through one serial queue and one cached connection per
 * platform. The browser sqlite engine exports the whole file after every
 * mutation, so two overlapping writers (event flush + turn marker) would lose
 * rows.
 */
import type { Platform } from "../../../src/platform/types";
import type { DerivedTurn, StoredSession, TurnMarker } from "../../../src/web-log";
import { sanitizeEvent, type SanitizedEvent } from "../../../src/sanitize";
import { newTurnApps, tagEventApp } from "../../../src/app-attribution";
import type { KatEvent } from "./logger";

export const MARKER_TURN = "web_turn_end";
export const MARKER_LABEL = "web_session_label";
export const MARKER_DELETE = "web_session_delete";
export const MARKER_OPEN = "web_session_open";
const MARKER_KINDS = [MARKER_TURN, MARKER_LABEL, MARKER_DELETE, MARKER_OPEN];

/** Turns kept per session in a response (matches src/web-log.ts). */
export const MAX_TURNS = 20;
/** Events kept per turn in a response (matches src/web-log.ts). */
export const MAX_TURN_EVENTS = 500;

// Mirrors grandma-kat's SqliteLogger schema and src/web-log.ts's marker rows.
export const RUN_LOG_DDL = `
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
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  resume_positions TEXT NOT NULL
)`;

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

async function dbFor(platform: Platform): Promise<Db> {
  const path = logDbPath(platform);
  let pending = handles.get(platform) as Promise<Db> | undefined;
  if (!pending) {
    pending = (async () => {
      await platform.fs.mkdir(platform.path.dirname(path), { recursive: true }).catch(() => {});
      const db = await platform.sqlite.open(path, { readOnly: false });
      await db.exec(RUN_LOG_DDL);
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
        sqlLiteral(e.run_id),
        sqlLiteral(e.definition_id),
        sqlLiteral(e.branch_path ?? null),
        sqlLiteral(e.iteration ?? null),
        sqlLiteral(e.scope_id ?? null),
        sqlLiteral(e.kind),
        sqlLiteral(JSON.stringify(e.content ?? null)),
      ].join(",")})`,
  );
  return `INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES ${values.join(",")}`;
}

/** Persist one batch of engine events (the logger's flush). */
export async function appendEvents(platform: Platform, events: KatEvent[]): Promise<void> {
  if (!events.length) return;
  const sql = insertCalls(events);
  await withLogDb(platform, async (db) => {
    await db.exec(sql);
  });
}

async function insertMarker(
  db: Db,
  runId: string,
  kind: string,
  content: unknown,
): Promise<void> {
  const stmt = await db.prepare(
    "INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, 'web', NULL, 0, NULL, ?, ?)",
  );
  await stmt.run(runId, kind, JSON.stringify(content));
}

/** Persist a finished turn; computes the event-seq bounds from the run id. */
export async function writeTurnEnd(platform: Platform, m: TurnMarker): Promise<void> {
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
    await insertMarker(db, m.key, MARKER_TURN, {
      ...m,
      fromSeq,
      toSeq,
      ts: Date.now(),
    });
  });
}

export async function writeLabel(platform: Platform, key: string, label: string): Promise<void> {
  await withLogDb(platform, (db) =>
    insertMarker(db, key, MARKER_LABEL, { key, label, ts: Date.now() }),
  );
}

export async function writeDelete(platform: Platform, key: string): Promise<void> {
  await withLogDb(platform, (db) => insertMarker(db, key, MARKER_DELETE, { key, ts: Date.now() }));
}

export async function ensureOpen(platform: Platform, key: string, label = ""): Promise<void> {
  await withLogDb(platform, async (db) => {
    const row = await (
      await db.prepare("SELECT 1 x FROM calls WHERE run_id = ? AND kind = ? LIMIT 1")
    ).get(key, MARKER_OPEN);
    if (!row) await insertMarker(db, key, MARKER_OPEN, { key, label, ts: Date.now() });
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
        status: m.status === "error" ? "error" : "done",
        error: m.error ?? null,
        output: m.output ?? null,
        emits: m.emits ?? null,
        levels: m.levels ?? null,
        emitApps: m.emitApps ?? null,
        buttons: m.buttons ?? null,
        fallback: m.fallback ?? null,
        awaiting: m.awaiting ?? null,
        events: [],
      };
      if (opts.withEvents && m.runId && m.fromSeq != null && m.toSeq != null) {
        t.events = await turnEvents(db, m.runId, m.fromSeq, m.toSeq);
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
): Promise<SanitizedEvent[]> {
  const bounds = "run_id = ? AND seq > ? AND seq <= ?";
  const trees = (await (
    await db.prepare(
      `SELECT seq, kind, content FROM calls WHERE ${bounds} AND kind IN ('tree_enter','tree_exit','tree_suspend') ORDER BY seq`,
    )
  ).all(runId, fromSeq, toSeq)) as { seq: number; kind: string; content: string }[];
  const app = appLookup(trees.map((t) => ({ seq: t.seq, kind: t.kind, content: parseJson(t.content) })));
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
  return tail.reverse().map((r) =>
    sanitizeEvent(
      {
        kind: r.kind,
        branch_path: r.branch_path ?? "",
        iteration: r.iteration ?? 0,
        scope_id: r.scope_id,
        content: (parseJson(r.content) as Record<string, unknown> | null) ?? {},
      },
      app(r.seq),
    ),
  );
}

function appLookup(treeEvents: { seq: number; kind: string; content: unknown }[]): (seq: number) => string {
  const st = newTurnApps();
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
    if (ans < 0) return "trunk";
    const r = recs[ans];
    return r.seq === seq ? r.app : r.after;
  };
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
