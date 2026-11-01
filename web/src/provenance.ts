/**
 * Message provenance — "what was this reply written from?" (browser host)
 *
 * Revived from the Node admin's `src/provenance.ts` (deleted when the host
 * moved into the tab): the same read-only walk, over the run log the browser
 * owns (`logs/grandma-kat.db`, the `calls` table). For one emitted message (an
 * `emit` row) it answers, from the log alone:
 *
 *   1. which prompt produced the text — the `llm_call` whose output matches
 *      the message, found through the `record` rows that carry that text
 *      (a prompt's own result, a Memory() capture, an Emit's slot), so the
 *      walk follows the real causal chain, not just "the nearest call";
 *   2. the memory slots and other pieces that prompt READ — the `reads` array
 *      the engine attaches to every `llm_call` and memory write
 *      (`{ name, scope, seq }`, seq = the log row that last wrote the slot);
 *   3. the writer of each piece (tool result, your message, an earlier
 *      prompt's output, a host seed), walked deeper on request (depth);
 *   4. `ref://<name>.<seq>` handles inside the prompt's messages, resolved to the
 *      full tool-result row they point at.
 *
 * Nothing here writes to the log; the engine never reads the rows this module
 * derives.
 *
 * Storage: one run's rows are loaded once (`loadRunEvents`) and the whole walk
 * runs in memory over them — the browser's SQLite lives behind an async worker
 * proxy, so per-row queries would make the recursive walk a round-trip storm.
 * The row set is exactly what the old reader's `WHERE run_id = ?` queries saw.
 */
import type { Platform } from "./platform/types";
import { emitValue } from "./util/emit-text";
import { refTargetFromRow, rowKindChild, rowValue, when, type RefTarget } from "./ref-target";
import { loadRunEvents, readRow, withLogDb, MARKER_TURN, type LogRow } from "./agent/log-store";

export { refTargetFromRow, when } from "./ref-target";
export type { RefSourceRow, RefTarget } from "./ref-target";

/** How far "trace deeper" may walk the read-graph. */
export const MAX_PROV_DEPTH = 6;
/** Total pieces resolved in one walk (breadth cap). */
const MAX_BREADTH = 60;
/** Display cap for a writer row's value. */
const VALUE_CHARS = 4000;
/** Display cap per prompt message. */
const PROMPT_MSG_CHARS = 8000;
/** How many text-matching record rows to consider as emit sources. */
const RECORD_CANDIDATES = 30;
/** How many llm_calls to consider per scope when linking a record to its prompt. */
const CALLS_PER_SCOPE = 8;
/** Seeds for the ref:// scan. */
const MAX_REFS = 20;
const MAX_LEAVES = 40;
/** Normalized-match fallback scan bound (records before the emit). */
const NORM_SCAN = 300;

export interface ProvEmit {
  seq: number;
  runId: string;
  when: string;
  child: string | null;
  branchPath: string;
  text: string;
}

export interface ProvWriter {
  seq: number;
  kind: string;
  runId: string;
  when: string;
  branchPath: string;
  child: string | null;
  op: string | null;
  text: string;
  chars: number;
  truncated: boolean;
}

export interface ProvPiece {
  name: string;
  scope: number | null;
  scopePath: string | null;
  /** How the writer was found: the read's own seq link, a latest-write lookup
   *  (the read's seq was not recorded), a delivered human row, or nothing. */
  resolved: "read-link" | "latest-write" | "human" | "host-seed";
  writer: ProvWriter | null;
  /** The writer's own reads — present from depth 2 ("trace deeper"). */
  reads?: ProvPiece[];
}

export interface ProvPromptMessage {
  role: string;
  chars: number;
  truncated: boolean;
  content: string;
}

export interface ProvPrompt {
  seq: number;
  child: string;
  model: string | null;
  round: number | null;
  scopeId: number | null;
  branchPath: string;
  when: string;
  /** The prompt's rounds (one llm_call row each), newest first. */
  rounds: { seq: number; round: number | null; model: string | null }[];
  messages: ProvPromptMessage[];
  messageCount: number;
  messageChars: number;
}

export interface ProvRef {
  seq: number;
  kind: string;
  child: string | null;
  text: string;
}

export interface Provenance {
  emit: ProvEmit;
  /** "text": the prompt's output matched the message; "nearest": no match was
   *  found and the closest preceding prompt is shown; "none": no prompt. */
  match: "text" | "nearest" | "none";
  prompt: ProvPrompt | null;
  pieces: ProvPiece[];
  /** Rows reached by the walk that read nothing further — the ground facts. */
  leaves: ProvWriter[];
  refs: ProvRef[];
  depth: number;
  maxDepth: number;
  /** True when a cap (breadth) cut the walk short. */
  truncated: boolean;
}

interface ReadRef {
  name: string;
  scope: number | null;
  seq: number | null;
}

/** The marker row a finished turn persists (`writeTurnEnd`), as read here. */
interface TurnMarkerRow {
  key?: string;
  turnId?: string;
  runId?: string | null;
  fromSeq?: number | null;
  toSeq?: number | null;
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A row's value rendered for display, with its truncation facts. */
function valueDisplay(v: unknown, cap = VALUE_CHARS): { text: string; chars: number; truncated: boolean } {
  let text: string;
  if (typeof v === "string") text = v;
  else if (v == null) text = "";
  else {
    try {
      text = JSON.stringify(v);
    } catch {
      text = String(v);
    }
  }
  const chars = text.length;
  return { text: chars > cap ? text.slice(0, cap) + "…" : text, chars, truncated: chars > cap };
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

function sameText(a: string | null | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  return a.trim() === b.trim() || norm(a) === norm(b);
}

/**
 * Pick which logged emit a bubble is anchored on. The bubble's own text wins
 * (a rewound/re-run turn can log several passes; the last match is the one
 * that survived), falling back to its index in the turn's emit list, then to
 * the last emit when the index is out of range (-1 from the UI).
 */
export function pickEmitAnchor(emits: { seq: number; text: string }[], bubble: number, text: string): number {
  if (!emits.length) return -1;
  if (text) {
    for (let i = emits.length - 1; i >= 0; i--) {
      if (emits[i].text.trim() === text.trim()) return i;
    }
  }
  return Number.isInteger(bubble) && bubble >= 0 && bubble < emits.length ? bubble : emits.length - 1;
}

/**
 * The read-graph walk over one run's rows (oldest first). A single instance
 * answers one request: `provenance()` resets the breadth budget and leaves.
 */
export class ProvenanceReader {
  private readonly rows: LogRow[];
  private readonly bySeq = new Map<number, LogRow>();
  private budget = MAX_BREADTH;
  private truncated = false;
  private leaves: ProvWriter[] = [];
  private leafSeen = new Set<number>();

  constructor(rows: LogRow[]) {
    this.rows = rows;
    for (const row of rows) this.bySeq.set(row.seq, row);
  }

  /** One row by seq from this run's window. */
  private row(seq: number): LogRow | null {
    return this.bySeq.get(seq) ?? null;
  }

  /**
   * The turn's emitted messages, in order: every `emit` row in (fromSeq, toSeq]
   * whose chat-facing text is non-empty (the same `emitValue` the live UI
   * uses, so a bubble and its row always align). Machine narration is included
   * — it is a bubble too — and the UI decides not to offer provenance on it.
   */
  listEmits(fromSeq: number | null, toSeq: number | null): { seq: number; text: string }[] {
    const out: { seq: number; text: string }[] = [];
    for (const row of this.rows) {
      if (row.kind !== "emit") continue;
      if (fromSeq != null && row.seq <= fromSeq) continue;
      if (toSeq != null && row.seq > toSeq) continue;
      const c = row.content as { value?: unknown } | null;
      const text = emitValue(c?.value).text;
      if (text) out.push({ seq: row.seq, text });
    }
    return out;
  }

  /**
   * The provenance of one `emit` row. `depth` is 1 (direct pieces + their
   * writers) up to MAX_PROV_DEPTH (each memory write's own reads walked
   * another level).
   */
  provenance(emitSeq: number, depth = 1): Provenance {
    const d = Math.min(Math.max(Number.isInteger(depth) && depth > 0 ? depth : 1, 1), MAX_PROV_DEPTH);
    const emit = this.row(emitSeq);
    if (!emit || emit.kind !== "emit") throw new Error(`no emit row at seq ${emitSeq}`);
    const emitContent = emit.content as { child?: unknown; value?: unknown } | null;
    const text = emitValue(emitContent?.value).text;

    this.budget = MAX_BREADTH;
    this.truncated = false;
    this.leaves = [];
    this.leafSeen = new Set();

    const found = this.findPrompt(emit, text);
    const prompt = found.row ? this.promptView(found.row) : null;
    const pieces: ProvPiece[] = [];
    if (found.row) {
      const reads = parseReads(found.row.content);
      for (const read of reads) {
        if (this.budget <= 0) {
          this.truncated = true;
          break;
        }
        this.budget--;
        pieces.push(this.resolveRead(read, emit.run_id, found.row.seq, d));
      }
    }

    return {
      emit: {
        seq: emit.seq,
        runId: emit.run_id,
        when: when(emit.run_id),
        child: typeof emitContent?.child === "string" ? emitContent.child : null,
        branchPath: emit.branch_path ?? "",
        text,
      },
      match: found.match,
      prompt,
      pieces,
      leaves: this.leaves.slice(0, MAX_LEAVES),
      refs: found.row ? this.refs(found.row) : [],
      depth: d,
      maxDepth: MAX_PROV_DEPTH,
      truncated: this.truncated,
    };
  }

  // ── prompt discovery ─────────────────────────────────────────────────

  /**
   * Find the llm_call that produced the message. The message text was carried
   * by `record` rows (a prompt's own result, a Memory() capture); each such
   * record names the scope it ran in, and the prompt is the last llm_call in
   * that scope whose output is the same text. When no record carries the text
   * (post-processing, wrapping), the nearest matching call, then the nearest
   * call at all, is used — flagged so the UI can say the match is unsure.
   */
  private findPrompt(emit: LogRow, text: string): { row: LogRow | null; match: Provenance["match"] } {
    if (text) {
      for (const rec of this.textRecords(emit.seq, text)) {
        const call = this.callForRecord(rec, text);
        if (call) return { row: call, match: "text" };
      }
      const near = this.nearestMatchingCall(emit.seq, text);
      if (near) return { row: near, match: "text" };
    }
    const any = this.nearestCall(emit.seq);
    return { row: any, match: any ? "nearest" : "none" };
  }

  /** Record rows before `beforeSeq` whose scalar value is the text, nearest first. */
  private textRecords(beforeSeq: number, text: string): LogRow[] {
    const values = (row: LogRow): unknown => (row.content as { value?: unknown } | null)?.value;
    const records = this.rows.filter(
      (row) => row.kind === "record" && row.seq < beforeSeq && typeof values(row) === "string",
    );
    const exact: LogRow[] = [];
    for (let i = records.length - 1; i >= 0 && exact.length < RECORD_CANDIDATES; i--) {
      if (values(records[i]) === text) exact.push(records[i]);
    }
    if (exact.length) return exact;
    // Whitespace/trim differences: re-compare normalized over a bounded tail.
    const out: LogRow[] = [];
    const tail = records.slice(-NORM_SCAN);
    for (let i = tail.length - 1; i >= 0; i--) {
      const value = values(tail[i]);
      if (typeof value === "string" && sameText(value, text)) {
        out.push(tail[i]);
        if (out.length >= RECORD_CANDIDATES) break;
      }
    }
    return out;
  }

  /** The llm_call in the record's scope whose output is the text, nearest first. */
  private callForRecord(rec: LogRow, text: string): LogRow | null {
    const calls = this.rows.filter(
      (row) =>
        row.kind === "llm_call" &&
        row.seq <= rec.seq &&
        (rec.scope_id == null ? row.scope_id == null : row.scope_id === rec.scope_id),
    );
    const tail = calls.slice(-CALLS_PER_SCOPE);
    for (let i = tail.length - 1; i >= 0; i--) {
      const c = tail[i].content as { content?: unknown } | null;
      if (typeof c?.content === "string" && sameText(c.content, text)) return tail[i];
    }
    return null;
  }

  private nearestMatchingCall(beforeSeq: number, text: string): LogRow | null {
    const calls = this.rows.filter((row) => row.kind === "llm_call" && row.seq < beforeSeq).slice(-12);
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i].content as { content?: unknown } | null;
      if (typeof c?.content === "string" && sameText(c.content, text)) return calls[i];
    }
    return null;
  }

  private nearestCall(beforeSeq: number): LogRow | null {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (row.kind === "llm_call" && row.seq < beforeSeq) return row;
    }
    return null;
  }

  private promptView(call: LogRow): ProvPrompt {
    const c = call.content as { child?: unknown; model?: unknown; round?: unknown; messages?: unknown } | null;
    const messages = Array.isArray(c?.messages) ? c.messages : [];
    let messageChars = 0;
    const out: ProvPromptMessage[] = [];
    for (const m of messages) {
      const mm = (m ?? {}) as { role?: unknown; content?: unknown };
      const raw = typeof mm.content === "string" ? mm.content : JSON.stringify(mm.content ?? "");
      const chars = raw.length;
      messageChars += chars;
      out.push({
        role: typeof mm.role === "string" ? mm.role : "?",
        chars,
        truncated: chars > PROMPT_MSG_CHARS,
        content: chars > PROMPT_MSG_CHARS ? raw.slice(0, PROMPT_MSG_CHARS) + "…" : raw,
      });
    }
    // The prompt's rounds: llm_call rows for the same child+scope at or before
    // this one (a tool loop logs one row per round; the chosen row is the last).
    const child = typeof c?.child === "string" ? c.child : "";
    const sameScope = this.rows
      .filter(
        (row) =>
          row.kind === "llm_call" &&
          row.seq <= call.seq &&
          (call.scope_id == null ? row.scope_id == null : row.scope_id === call.scope_id),
      )
      .slice(-12);
    const rounds: ProvPrompt["rounds"] = [];
    for (let i = sameScope.length - 1; i >= 0; i--) {
      const rc = sameScope[i].content as { child?: unknown; round?: unknown; model?: unknown } | null;
      if (rc?.child !== child) continue;
      rounds.push({
        seq: sameScope[i].seq,
        round: typeof rc.round === "number" ? rc.round : null,
        model: typeof rc.model === "string" ? rc.model : null,
      });
      if (rounds.length >= 8) break;
    }
    return {
      seq: call.seq,
      child,
      model: typeof c?.model === "string" ? c.model : null,
      round: typeof c?.round === "number" ? c.round : null,
      scopeId: call.scope_id ?? null,
      branchPath: call.branch_path ?? "",
      when: when(call.run_id),
      rounds,
      messages: out,
      messageCount: out.length,
      messageChars,
    };
  }

  /** `ref://<name>.<seq>` handles carried by the prompt's messages. */
  private refs(call: LogRow): ProvRef[] {
    const c = call.content as { messages?: unknown } | null;
    if (!Array.isArray(c?.messages)) return [];
    const seen = new Set<number>();
    const out: ProvRef[] = [];
    const scan = (v: unknown) => {
      if (out.length >= MAX_REFS) return;
      if (typeof v === "string") {
        for (const m of v.matchAll(/ref:\/\/(?:[a-z][\w-]*\.)?(\d+)/g)) {
          const seq = Number(m[1]);
          if (seen.has(seq)) continue;
          seen.add(seq);
          const row = this.row(seq);
          out.push({
            seq,
            kind: row?.kind ?? "missing",
            child: rowKindChild(row),
            text: row ? valueDisplay(rowValue(row)).text : "(row missing)",
          });
          if (out.length >= MAX_REFS) return;
        }
        return;
      }
      if (Array.isArray(v)) {
        for (const item of v) scan(item);
        return;
      }
      if (v && typeof v === "object") scan((v as { text?: unknown }).text);
    };
    for (const m of c.messages) scan(((m ?? {}) as { content?: unknown }).content);
    return out;
  }

  // ── the read-graph walk ──────────────────────────────────────────────

  private resolveRead(read: ReadRef, runId: string, anchorSeq: number, depth: number): ProvPiece {
    let writer: LogRow | null = null;
    let resolved: ProvPiece["resolved"] = "host-seed";
    if (Number.isInteger(read.seq)) {
      writer = this.row(read.seq as number);
      if (writer) resolved = "read-link";
    }
    if (!writer) {
      writer = this.latestWrite(runId, read.name, read.scope, anchorSeq);
      if (writer) resolved = "latest-write";
    }
    if (!writer) {
      writer = this.lastHuman(runId, read.name, anchorSeq);
      if (writer) resolved = "human";
    }
    const piece: ProvPiece = {
      name: read.name,
      scope: read.scope ?? null,
      scopePath: read.scope == null ? null : this.scopePath(read.scope, runId, anchorSeq),
      resolved,
      writer: writer ? this.toWriter(writer) : null,
    };
    if (!writer) return piece;
    const sub = parseReads(writer.content);
    if (!sub.length) {
      this.noteLeaf(writer);
      return piece;
    }
    if (depth > 1) {
      piece.reads = [];
      for (const s of sub) {
        if (this.budget <= 0) {
          this.truncated = true;
          break;
        }
        this.budget--;
        piece.reads.push(this.resolveRead(s, runId, writer.seq, depth - 1));
      }
    }
    return piece;
  }

  /**
   * The latest memory write for a slot whose read carried no seq. Scoped to
   * the same run: a resumed conversation keeps its run id (so slots written
   * before the pause are found), while another conversation's identically
   * named slot never leaks in. `scope` pins the owning scope — the write row
   * is logged in the slot's scope.
   */
  private latestWrite(runId: string, name: string, scope: number | null, beforeSeq: number): LogRow | null {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (row.kind !== "record" || row.seq >= beforeSeq) continue;
      if (row.run_id !== runId) continue;
      if (scope == null ? row.scope_id != null : row.scope_id !== scope) continue;
      const c = row.content as { child?: unknown; op?: unknown } | null;
      if (c?.child !== name) continue;
      if (c.op !== "memory" && c.op !== "memoryUpdate") continue;
      return row;
    }
    return null;
  }

  /**
   * The last delivered human row for a slot (human writes carry no seq link),
   * within the read's own run.
   */
  private lastHuman(runId: string, name: string, beforeSeq: number): LogRow | null {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (row.kind !== "human" || row.seq >= beforeSeq) continue;
      if (row.run_id !== runId) continue;
      const c = row.content as { child?: unknown; delivered?: unknown } | null;
      if (c?.child === name && c.delivered === 1) return row;
    }
    return null;
  }

  /**
   * The tree path a scope was created at (its `scope_init` row), for display.
   * The root scope (0) has no scope_init row — it is just "the root", so it
   * gets no label; and scopes are only ever looked up within the read's own
   * run, since scope ids are reused across runs.
   */
  private scopePath(scope: number, runId: string, beforeSeq: number): string | null {
    if (scope === 0) return null;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (row.kind !== "scope_init" || row.seq > beforeSeq) continue;
      if (row.run_id !== runId) continue;
      const c = row.content as { scopeId?: unknown } | null;
      if (c?.scopeId !== scope) continue;
      if (!row.branch_path) continue;
      return row.branch_path;
    }
    return null;
  }

  private toWriter(row: LogRow): ProvWriter {
    const c = row.content as Record<string, unknown> | null;
    const value = valueDisplay(rowValue(row));
    return {
      seq: row.seq,
      kind: row.kind,
      runId: row.run_id,
      when: when(row.run_id),
      branchPath: row.branch_path ?? "",
      child: rowKindChild(row),
      op: typeof c?.op === "string" ? c.op : null,
      text: value.text,
      chars: value.chars,
      truncated: value.truncated,
    };
  }

  private noteLeaf(row: LogRow): void {
    if (this.leafSeen.has(row.seq)) return;
    this.leafSeen.add(row.seq);
    this.leaves.push(this.toWriter(row));
  }
}

function parseReads(content: unknown): ReadRef[] {
  const c = content as { reads?: unknown } | null;
  if (!c || !Array.isArray(c.reads)) return [];
  const out: ReadRef[] = [];
  for (const r of c.reads) {
    const rr = (r ?? {}) as { name?: unknown; scope?: unknown; seq?: unknown };
    if (typeof rr.name !== "string" || !rr.name) continue;
    out.push({
      name: rr.name,
      scope: typeof rr.scope === "number" ? rr.scope : null,
      seq: typeof rr.seq === "number" ? rr.seq : null,
    });
  }
  return out;
}

// ── turn resolution ──────────────────────────────────────────────────────

/** The persisted marker of one turn (`web_turn_end`), or null. */
export async function findTurnMarker(platform: Platform, turnId: string): Promise<TurnMarkerRow | null> {
  if (!turnId) return null;
  return withLogDb(platform, async (db) => {
    const rows = (await (
      await db.prepare("SELECT content FROM calls WHERE kind = ? ORDER BY seq DESC")
    ).all(MARKER_TURN)) as { content: string | null }[];
    for (const row of rows) {
      const marker = parseJson(row.content) as TurnMarkerRow | null;
      if (marker && marker.turnId === turnId) return marker;
    }
    return null;
  });
}

export interface ProvenanceRequest {
  turnId: string;
  /** The turn-level emit index; -1 = last emit. */
  bubble?: number;
  /** The bubble's chat-facing text — the preferred anchor. */
  text?: string;
  /** 1 (direct pieces) .. MAX_PROV_DEPTH (walk the writers' own reads). */
  depth?: number;
  /**
   * Rows of a turn that is still running (the worker has not flushed them yet):
   * merged over the persisted run rows by seq, so a mid-turn ⓘ works.
   */
  live?: { runId: string; rows: LogRow[] };
}

/**
 * Provenance for one bubble of one turn. Null when the turn has no engine run
 * (a marker-less/old turn) or no emit to anchor on.
 */
export async function provenanceFor(
  platform: Platform,
  req: ProvenanceRequest,
): Promise<(Provenance & { turnId: string; bubble: number; emitCount: number }) | null> {
  const marker = req.live ? null : await findTurnMarker(platform, req.turnId);
  const runId = req.live?.runId ?? marker?.runId ?? null;
  if (!runId) return null;

  const rowsById = new Map<number, LogRow>();
  for (const row of await loadRunEvents(platform, runId)) rowsById.set(row.seq, row);
  for (const row of req.live?.rows ?? []) rowsById.set(row.seq, row);
  const rows = [...rowsById.values()].sort((a, b) => a.seq - b.seq);

  const fromSeq = req.live ? null : (marker?.fromSeq ?? null);
  const maxSeq = rows.length ? rows[rows.length - 1].seq : null;
  const toSeq = req.live ? maxSeq : (marker?.toSeq ?? maxSeq);

  const reader = new ProvenanceReader(rows);
  const emits = reader.listEmits(fromSeq, toSeq);
  if (!emits.length) return null;
  const anchor = pickEmitAnchor(emits, Number.isInteger(req.bubble) ? (req.bubble as number) : -1, req.text ?? "");
  if (anchor < 0) return null;
  const data = reader.provenance(emits[anchor].seq, req.depth ?? 1);
  // A ref may point at a row outside this run's window (an older run kept in
  // the same log): fill those from the row store, exactly like the old reader.
  for (const ref of data.refs) {
    if (ref.kind !== "missing") continue;
    const row = await readRow(platform, ref.seq).catch(() => null);
    if (!row) continue;
    ref.kind = row.kind;
    ref.child = rowKindChild(row);
    ref.text = valueDisplay(rowValue(row)).text;
  }
  return { ...data, turnId: req.turnId, bubble: anchor, emitCount: emits.length };
}
