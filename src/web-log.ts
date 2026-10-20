/**
 * web-log — the web UI's state lives in the log DB (`calls`), as marker rows.
 *
 * There is no `web-turns.json` anymore. Every piece of UI state that is not
 * derivable from the engine's own trace is written as a host-owned marker row:
 *
 *   web_turn_end       one row per completed turn, carrying the record the UI
 *                      needs (input, bubbles, status, bounds). Turns are
 *                      SEGMENTS of a run — a resumed conversation keeps the
 *                      same run id and the human pause/delivery events split
 *                      it into turns — so each row stores the real `runId`
 *                      plus (fromSeq, toSeq] to fetch that turn's event tail.
 *   web_session_label  sparse label override (latest wins; empty re-derives)
 *   web_session_delete tombstone: hidden from the picker, trace preserved
 *   web_session_open   a foreign key (telegram) adopted into the drawer
 *
 * Marker rows are stamped with `run_id = <session key>` and the real run id
 * lives in the content — that makes every per-session read a seek on
 * (run_id, kind) and cross-session scans a small host-created partial index
 * on the marker kinds. The engine never writes or reads these rows: its
 * resume path replays only real run ids and ignores unknown kinds (pinned by
 * grandma-kat's resume-foreign-events test).
 *
 * Event tails for the log window are read back from `calls` on demand and
 * sanitized with the same code the live SSE path uses (src/sanitize.ts), so a
 * replayed turn looks identical to a streamed one.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { newTurnApps, tagEventApp } from "./app-attribution.js";
import { sanitizeEvent, type SanitizedEvent } from "./sanitize.js";
import type { EmitButton } from "./util/emit-text.js";

export const MARKER_TURN = "web_turn_end";
export const MARKER_LABEL = "web_session_label";
export const MARKER_DELETE = "web_session_delete";
export const MARKER_OPEN = "web_session_open";
const MARKER_KINDS = [MARKER_TURN, MARKER_LABEL, MARKER_DELETE, MARKER_OPEN];

/** Events kept per turn in a response (matches the old in-memory cap). */
export const MAX_TURN_EVENTS = 500;
/** Turns kept per session in a response (matches MAX_TURNS_KEPT). */
export const MAX_TURNS = 20;

import type { DerivedTurn, StoredSession, TurnMarker } from "./web-log-types.js";

export type { DerivedTurn, StoredSession, TurnMarker } from "./web-log-types.js";

/**
 * Resolve the app each event belongs to when the run's stream is replayed.
 * The walk sees only tree boundary markers (a handful per run), not the full
 * event stream; `app(seq)` then answers for any row by seq.
 */
function appLookup(treeEvents: { seq: number; kind: string; content: unknown }[]): (seq: number) => string {
  const st = newTurnApps();
  const recs: { seq: number; app: string; after: string }[] = [];
  for (const ev of treeEvents) {
    const app = tagEventApp(st, ev);
    recs.push({ seq: ev.seq, app, after: st.current });
  }
  return (seq: number) => {
    let lo = 0, hi = recs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (recs[mid].seq <= seq) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return "trunk";
    const r = recs[ans];
    return r.seq === seq ? r.app : r.after;
  };
}

export class WebLog {
  private db: DatabaseSync;
  private describeKey: (key: string) => string;

  constructor(dbPath: string, describeKey: (key: string) => string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    // The host may boot before the engine ever ran (a fresh workspace), so it
    // ensures the table it writes into exists. Same shape as the engine's
    // logger schema; CREATE IF NOT EXISTS keeps them compatible whichever
    // side initializes first.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        run_id TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_path TEXT,
        iteration INTEGER,
        scope_id INTEGER,
        kind TEXT NOT NULL,
        content TEXT
      )`);
    // Host-owned partial index over its marker kinds: small, and only touches
    // rows this module writes. (kind IN (...) queries match the index's WHERE
    // exactly, so the planner uses it; per-key reads use idx_calls_run_kind.)
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_calls_web_markers ON calls(kind, run_id)
       WHERE kind IN ('${MARKER_KINDS.join("','")}')`,
    );
    this.describeKey = describeKey;
  }

  close(): void {
    this.db.close();
  }

  /** Current high-water mark — a turn's events start after this seq. */
  nextSeq(): number {
    return Number((this.db.prepare("SELECT MAX(seq) m FROM calls").get() as { m: number | null }).m ?? 0);
  }

  private insertMarker(runId: string, kind: string, content: unknown): void {
    this.db
      .prepare("INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, 'web', NULL, 0, NULL, ?, ?)")
      .run(runId, kind, JSON.stringify(content));
  }

  // ── writes ────────────────────────────────────────────────────────────

  writeTurnEnd(m: Omit<TurnMarker, "ts">): void {
    this.insertMarker(m.key, MARKER_TURN, { ...m, ts: Date.now() });
  }

  /** Pin a label override; an empty string means "re-derive from the input". */
  writeLabel(key: string, label: string): void {
    this.insertMarker(key, MARKER_LABEL, { key, label, ts: Date.now() });
  }

  writeDelete(key: string): void {
    this.insertMarker(key, MARKER_DELETE, { key, ts: Date.now() });
  }

  /** Adopt a session (telegram key) into the drawer; idempotent. */
  ensureOpen(key: string, label?: string): void {
    const row = this.db.prepare("SELECT 1 FROM calls WHERE run_id = ? AND kind = ? LIMIT 1").get(key, MARKER_OPEN);
    if (row) return;
    this.insertMarker(key, MARKER_OPEN, { key, label: label ?? "", ts: Date.now() });
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /** True when the key has any marker — a session the UI has ever shown. */
  hasSession(key: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM calls WHERE run_id = ? AND kind IN (${MARKER_KINDS.map(() => "?").join(",")}) LIMIT 1`)
      .get(key, ...MARKER_KINDS);
    return !!row;
  }

  isDeleted(key: string): boolean {
    const row = this.latestMarker(key, MARKER_DELETE);
    return !!row;
  }

  turnCount(key: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM calls WHERE run_id = ? AND kind = ?").get(key, MARKER_TURN) as { n: number }).n);
  }

  labelOf(key: string): string {
    const pinned = this.latestMarker(key, MARKER_LABEL);
    if (pinned && typeof pinned.label === "string" && pinned.label.trim()) return pinned.label;
    const turns = this.turnMarkers(key);
    const first = turns.find((t) => (t.input ?? "").trim());
    if (first) return String(first.input).slice(0, 80);
    const open = this.latestMarker(key, MARKER_OPEN);
    if (open && typeof open.label === "string" && open.label.trim()) return open.label;
    // A key with no markers at all is a freshly minted chat: it has no label
    // yet (the first message's text becomes one), not a foreign-key blurb.
    if (!pinned && !turns.length && !open) return "";
    return this.describeKey(key);
  }

  /** True when a non-empty label override exists (a user rename). */
  hasLabelPin(key: string): boolean {
    const pinned = this.latestMarker(key, MARKER_LABEL);
    return !!(pinned && typeof pinned.label === "string" && pinned.label.trim());
  }

  /** The current label pin (empty string when none). */
  labelPin(key: string): string {
    const pinned = this.latestMarker(key, MARKER_LABEL);
    return pinned && typeof pinned.label === "string" ? pinned.label : "";
  }

  lastAwaiting(key: string): string | null {
    const turns = this.turnMarkers(key);
    const last = turns.at(-1);
    return (last?.awaiting as string | null) ?? null;
  }

  /** Turn markers for a key, oldest first (latest MAX_TURNS). */
  private turnMarkers(key: string): TurnMarker[] {
    const rows = this.db
      .prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq")
      .all(key, MARKER_TURN) as { content: string }[];
    const out: TurnMarker[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.content) as TurnMarker);
      } catch {
        // a corrupt marker must not take the UI down
      }
    }
    return out.slice(-MAX_TURNS);
  }

  private latestMarker(key: string, kind: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT content FROM calls WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      .get(key, kind) as { content: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** One turn marker by its turnId (the provenance endpoint's turn lookup). */
  findTurn(turnId: string): TurnMarker | null {
    if (!turnId) return null;
    const row = this.db
      .prepare("SELECT content FROM calls WHERE kind = ? AND json_extract(content, '$.turnId') = ? ORDER BY seq DESC LIMIT 1")
      .get(MARKER_TURN, turnId) as { content: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.content) as TurnMarker;
    } catch {
      return null;
    }
  }

  /** The picker: every key the drawer has ever shown, minus deletions. */
  listSessions(): StoredSession[] {
    const rows = this.db
      .prepare(`SELECT run_id, kind, content, seq FROM calls WHERE kind IN (${MARKER_KINDS.map(() => "?").join(",")}) ORDER BY seq`)
      .all(...MARKER_KINDS) as { run_id: string; kind: string; content: string; seq: number }[];
    const byKey = new Map<string, {
      label?: string; labelTs: number; open?: string; openTs: number; deleted: boolean;
      turns: number; updatedAt: number; awaiting: string | null; firstInput: string;
    }>();
    for (const r of rows) {
      let c: Record<string, unknown>;
      try {
        c = JSON.parse(r.content) as Record<string, unknown>;
      } catch {
        continue;
      }
      const key = r.run_id;
      let e = byKey.get(key);
      if (!e) {
        e = { labelTs: 0, openTs: 0, deleted: false, turns: 0, updatedAt: 0, awaiting: null, firstInput: "" };
        byKey.set(key, e);
      }
      const ts = Number(c.ts) || 0;
      if (r.kind === MARKER_TURN) {
        e.turns++;
        const ended = Number(c.endedAt) || 0;
        e.updatedAt = Math.max(e.updatedAt, ended || ts);
        if (typeof c.awaiting === "string") e.awaiting = c.awaiting;
        if (!e.firstInput && typeof c.input === "string" && c.input.trim()) e.firstInput = c.input;
      } else if (r.kind === MARKER_LABEL) {
        e.label = typeof c.label === "string" ? c.label : "";
        e.labelTs = ts;
        e.updatedAt = Math.max(e.updatedAt, ts);
      } else if (r.kind === MARKER_OPEN) {
        e.open = typeof c.label === "string" ? c.label : "";
        e.openTs = ts;
        e.updatedAt = Math.max(e.updatedAt, ts);
      } else if (r.kind === MARKER_DELETE) {
        e.deleted = true;
      }
    }
    const out: StoredSession[] = [];
    for (const [key, e] of byKey) {
      if (e.deleted) continue;
      // A web session with neither turns nor an open marker is an empty shell
      // (minted, never used) — not persisted, matching the old store.
      const isWeb = key.startsWith("web:");
      if (!e.turns && e.open === undefined && !(isWeb && e.labelTs)) continue;
      const label = (e.label && e.label.trim())
        ? e.label
        : e.firstInput
          ? e.firstInput.slice(0, 80)
          : (e.open && e.open.trim()) ? e.open : this.describeKey(key);
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
  }

  /**
   * A session's turns, newest last, with each turn's event tail fetched from
   * the trace when the turn has run bounds (turns from before host markers
   * migrated without bounds replay without their log window).
   */
  getTurns(key: string, opts: { withEvents?: boolean } = {}): DerivedTurn[] {
    const markers = this.turnMarkers(key);
    return markers.map((m) => {
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
        t.events = this.turnEvents(m.runId, m.fromSeq, m.toSeq);
      }
      return t;
    });
  }

  /** The (fromSeq, toSeq] event tail of one turn, app-tagged and sanitized. */
  private turnEvents(runId: string, fromSeq: number, toSeq: number): SanitizedEvent[] {
    const bounds = "run_id = ? AND seq > ? AND seq <= ?";
    const trees = this.db
      .prepare(`SELECT seq, kind, content FROM calls WHERE ${bounds} AND kind IN ('tree_enter','tree_exit','tree_suspend') ORDER BY seq`)
      .all(runId, fromSeq, toSeq) as { seq: number; kind: string; content: string }[];
    const app = appLookup(trees.map((t) => ({ seq: t.seq, kind: t.kind, content: parseJson(t.content) })));
    const tail = this.db
      .prepare(`SELECT * FROM calls WHERE ${bounds} ORDER BY seq DESC LIMIT ${MAX_TURN_EVENTS}`)
      .all(runId, fromSeq, toSeq) as { seq: number; kind: string; branch_path: string | null; iteration: number | null; scope_id: number | null; content: string | null }[];
    return tail.reverse().map((r) => sanitizeEvent({
      kind: r.kind,
      branch_path: r.branch_path ?? "",
      iteration: r.iteration ?? 0,
      scope_id: r.scope_id,
      seq: r.seq,
      content: parseJson(r.content) as Record<string, unknown> | null ?? {},
    }, app(r.seq)));
  }

  // ── migration ─────────────────────────────────────────────────────────

  /**
   * Import a legacy `web-turns.json` once: labels become override markers,
   * non-web keys become open markers, and every completed turn becomes a
   * turn marker. Turns are matched to the key's known run (the sessions.json
   * continuation) by input equality with delivered human events, so the
   * matched ones keep their event tails; the rest replay from the marker
   * alone. The caller renames the file away afterwards.
   */
  migrateLegacy(file: string, continuations: Map<string, string>): { sessions: number; turns: number; matched: number } {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const entries: [string, { label?: unknown; turns?: unknown }][] = Array.isArray(raw)
      ? [["web:chat", { turns: raw }]]
      : Object.entries(raw as Record<string, { label?: unknown; turns?: unknown }>);
    let sessions = 0, turns = 0, matched = 0;
    for (const [key, v] of entries) {
      const list = Array.isArray(v?.turns) ? v.turns as Record<string, unknown>[] : [];
      const done = list.filter((t) => t && t.status !== "running");
      const label = typeof v?.label === "string" ? v.label : "";
      if (!done.length && !label.trim()) continue;
      sessions++;
      if (label.trim()) this.writeLabel(key, label.trim().slice(0, 80));
      if (!key.startsWith("web:")) this.ensureOpen(key, label);
      // Known run + its delivered inputs, for bounds matching.
      const runId = continuations.get(key) ?? null;
      const delivered: { seq: number; value: string }[] = [];
      if (runId) {
        const rows = this.db
          .prepare("SELECT seq, content FROM calls WHERE run_id = ? AND kind = 'human' ORDER BY seq")
          .all(runId) as { seq: number; content: string }[];
        for (const r of rows) {
          const c = parseJson(r.content) as { delivered?: unknown; value?: unknown } | null;
          if (c?.delivered === true && typeof c.value === "string") delivered.push({ seq: r.seq, value: c.value });
        }
      }
      // Match delivered inputs to turns from the end backwards (each row used
      // once); a matched turn gets the real bounds so its log window replays.
      let di = delivered.length - 1;
      let prevSeq: number | null = di >= 0 ? delivered[di].seq : null;
      const boundsByTurn = new Map<number, { fromSeq: number; toSeq: number }>();
      for (let i = done.length - 1; i >= 0 && di >= 0; i--) {
        const input = typeof done[i].input === "string" ? done[i].input : "";
        if (input && input === delivered[di].value) {
          const fromSeq = di > 0 ? delivered[di - 1].seq : null;
          // The run's first events bound the chain's first matched turn.
          const lo = fromSeq ?? Number((this.db.prepare("SELECT MIN(seq) m FROM calls WHERE run_id = ?").get(runId!) as { m: number | null }).m ?? 0);
          boundsByTurn.set(i, { fromSeq: fromSeq ?? lo - 1, toSeq: prevSeq ?? delivered[di].seq });
          di--;
          prevSeq = delivered[di]?.seq ?? null;
        }
      }
      for (let i = 0; i < done.length; i++) {
        const t = done[i];
        const b = boundsByTurn.get(i);
        if (b) matched++;
        turns++;
        this.writeTurnEnd({
          key,
          turnId: String(t.turnId ?? `${key}:${i}`),
          runId: b && runId ? runId : null,
          fromSeq: b?.fromSeq ?? null,
          toSeq: b?.toSeq ?? null,
          input: typeof t.input === "string" ? t.input : "",
          inputApp: typeof t.inputApp === "string" ? t.inputApp : null,
          status: t.status === "error" ? "error" : "done",
          error: typeof t.error === "string" ? t.error : null,
          output: typeof t.output === "string" ? t.output : null,
          emits: Array.isArray(t.emits) ? t.emits as string[] : null,
          levels: Array.isArray(t.levels) ? t.levels as (string | null)[] : null,
          emitApps: Array.isArray(t.emitApps) ? t.emitApps as (string | null)[] : null,
          buttons: Array.isArray(t.buttons) ? t.buttons as EmitButton[] : null,
          fallback: Array.isArray(t.fallback) ? t.fallback as EmitButton[] : null,
          awaiting: typeof t.awaiting === "string" ? t.awaiting : null,
          startedAt: Number(t.startedAt) || 0,
          endedAt: Number(t.endedAt) || null,
        });
      }
    }
    return { sessions, turns, matched };
  }
}

function parseJson(s: string | null): unknown {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
