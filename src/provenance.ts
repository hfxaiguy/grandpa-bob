/**
 * Message provenance — "what was this reply written from?"
 *
 * A read-only walk over the grandma-kat log DB (`calls`), the same table the
 * engine and the web UI's markers live in. For one emitted message (an `emit`
 * row) it answers, from the log alone:
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
 */
import { DatabaseSync } from "node:sqlite";
import { emitValue } from "./util/emit-text.js";

/** How far "trace deeper" may walk the read-graph. */
export const MAX_PROV_DEPTH = 6;
/** Total pieces resolved in one walk (breadth cap). */
const MAX_BREADTH = 60;
/** Display cap for a writer row's value. */
const VALUE_CHARS = 4000;
/** Display cap for an inspected `ref://` target (a click wants the whole thing). */
const REF_VALUE_CHARS = 200000;
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

/** An inspected `ref://` target: the referenced row's value, in full. */
export interface RefTarget {
  seq: number;
  kind: string;
  runId: string;
  when: string;
  branchPath: string;
  child: string | null;
  op: string | null;
  /** The `/path` segment of the handle (`ref://<seq>/list` → "list"), or null. */
  path: string | null;
  /** The full value rendered for display (JSON for objects). */
  value: string;
  chars: number;
  truncated: boolean;
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

interface Row {
  seq: number;
  run_id: string;
  kind: string;
  branch_path: string | null;
  iteration: number | null;
  scope_id: number | null;
  content: unknown;
}

interface ReadRef {
  name: string;
  scope: number | null;
  seq: number | null;
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The run start time encoded in the run id (2026-10-02_19-56-16-15). */
export function when(runId: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(String(runId ?? ""));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(runId ?? "");
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

export class ProvenanceReader {
  private db: DatabaseSync;
  private budget = MAX_BREADTH;
  private truncated = false;
  private leaves: ProvWriter[] = [];
  private leafSeen = new Set<number>();

  constructor(public readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  close(): void {
    this.db.close();
  }

  /** One row by seq, content parsed. */
  private row(seq: number): Row | null {
    const r = this.db.prepare("SELECT * FROM calls WHERE seq = ?").get(seq) as
      | { seq: number; run_id: string; kind: string; branch_path: string | null; iteration: number | null; scope_id: number | null; content: string | null }
      | undefined;
    if (!r) return null;
    return { ...r, content: parseJson(r.content) };
  }

  /**
   * The turn's emitted messages, in order: every `emit` row in (fromSeq, toSeq]
   * whose chat-facing text is non-empty (the same `emitValue` the live UI
   * uses, so a bubble and its row always align). Machine narration is included
   * — it is a bubble too — and the UI decides not to offer provenance on it.
   */
  listEmits(runId: string, fromSeq: number, toSeq: number): { seq: number; text: string }[] {
    const rows = this.db
      .prepare("SELECT seq, content FROM calls WHERE run_id = ? AND kind = 'emit' AND seq > ? AND seq <= ? ORDER BY seq")
      .all(runId, fromSeq, toSeq) as { seq: number; content: string | null }[];
    const out: { seq: number; text: string }[] = [];
    for (const r of rows) {
      const c = parseJson(r.content) as { value?: unknown } | null;
      const text = emitValue(c?.value).text;
      if (text) out.push({ seq: r.seq, text });
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
  private findPrompt(emit: Row, text: string): { row: Row | null; match: Provenance["match"] } {
    if (text) {
      for (const rec of this.textRecords(emit.run_id, emit.seq, text)) {
        const call = this.callForRecord(rec, text);
        if (call) return { row: call, match: "text" };
      }
      const near = this.nearestMatchingCall(emit.run_id, emit.seq, text);
      if (near) return { row: near, match: "text" };
    }
    const any = this.nearestCall(emit.run_id, emit.seq);
    return { row: any, match: any ? "nearest" : "none" };
  }

  /** Record rows before `beforeSeq` whose scalar value is the text, nearest first. */
  private textRecords(runId: string, beforeSeq: number, text: string): Row[] {
    const exact = this.db
      .prepare(
        `SELECT * FROM calls WHERE run_id = ? AND kind = 'record' AND seq < ?
           AND json_valid(content) AND typeof(json_extract(content, '$.value')) = 'text'
           AND json_extract(content, '$.value') = ?
         ORDER BY seq DESC LIMIT ${RECORD_CANDIDATES}`,
      )
      .all(runId, beforeSeq, text) as unknown as RawRow[];
    const rows = exact.map((r) => ({ ...r, content: parseJson(r.content) }));
    if (rows.length) return rows;
    // Whitespace/trim differences: re-compare normalized over a bounded tail.
    const tail = this.db
      .prepare(
        `SELECT * FROM calls WHERE run_id = ? AND kind = 'record' AND seq < ?
           AND json_valid(content) AND typeof(json_extract(content, '$.value')) = 'text'
         ORDER BY seq DESC LIMIT ${NORM_SCAN}`,
      )
      .all(runId, beforeSeq) as unknown as RawRow[];
    const out: Row[] = [];
    for (const r of tail) {
      const c = parseJson(r.content) as { value?: unknown } | null;
      if (typeof c?.value === "string" && sameText(c.value, text)) {
        out.push({ ...r, content: c });
        if (out.length >= RECORD_CANDIDATES) break;
      }
    }
    return out;
  }

  /** The llm_call in the record's scope whose output is the text, nearest first. */
  private callForRecord(rec: Row, text: string): Row | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM calls WHERE run_id = ? AND kind = 'llm_call' AND seq <= ?
           AND ${rec.scope_id == null ? "scope_id IS NULL" : "scope_id = ?"}
         ORDER BY seq DESC LIMIT ${CALLS_PER_SCOPE}`,
      )
      .all(...(rec.scope_id == null ? [rec.run_id, rec.seq] : [rec.run_id, rec.seq, rec.scope_id])) as unknown as RawRow[];
    for (const r of rows) {
      const c = parseJson(r.content) as { content?: unknown } | null;
      if (typeof c?.content === "string" && sameText(c.content, text)) return { ...r, content: c };
    }
    return null;
  }

  private nearestMatchingCall(runId: string, beforeSeq: number, text: string): Row | null {
    const rows = this.db
      .prepare("SELECT * FROM calls WHERE run_id = ? AND kind = 'llm_call' AND seq < ? ORDER BY seq DESC LIMIT 12")
      .all(runId, beforeSeq) as unknown as RawRow[];
    for (const r of rows) {
      const c = parseJson(r.content) as { content?: unknown } | null;
      if (typeof c?.content === "string" && sameText(c.content, text)) return { ...r, content: c };
    }
    return null;
  }

  private nearestCall(runId: string, beforeSeq: number): Row | null {
    const r = this.db
      .prepare("SELECT * FROM calls WHERE run_id = ? AND kind = 'llm_call' AND seq < ? ORDER BY seq DESC LIMIT 1")
      .get(runId, beforeSeq) as RawRow | undefined;
    return r ? { ...r, content: parseJson(r.content) } : null;
  }

  private promptView(call: Row): ProvPrompt {
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
    const roundsRows = this.db
      .prepare(
        `SELECT seq, content FROM calls WHERE run_id = ? AND kind = 'llm_call' AND seq <= ?
           AND ${call.scope_id == null ? "scope_id IS NULL" : "scope_id = ?"}
         ORDER BY seq DESC LIMIT 12`,
      )
      .all(...(call.scope_id == null ? [call.run_id, call.seq] : [call.run_id, call.seq, call.scope_id])) as {
      seq: number;
      content: string | null;
    }[];
    const rounds: ProvPrompt["rounds"] = [];
    for (const r of roundsRows) {
      const rc = parseJson(r.content) as { child?: unknown; round?: unknown; model?: unknown } | null;
      if (rc?.child !== child) continue;
      rounds.push({
        seq: r.seq,
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
      scopeId: call.scope_id,
      branchPath: call.branch_path ?? "",
      when: when(call.run_id),
      rounds,
      messages: out,
      messageCount: out.length,
      messageChars,
    };
  }

  /** `ref://<name>.<seq>` handles carried by the prompt's messages. */
  private refs(call: Row): ProvRef[] {
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

  /**
   * Resolve one `ref://<seq>[/path]` handle for inspection: the referenced
   * row's value in full (a `/path` segment drills into it, e.g. `/list`),
   * plus the row's metadata so the UI can say where it came from.
   */
  refTarget(seq: number, path?: string | null): RefTarget | null {
    const row = this.row(seq);
    if (!row) return null;
    let value = rowValue(row);
    const segs = String(path ?? "").split("/").filter(Boolean);
    for (const seg of segs) {
      if (Array.isArray(value)) {
        const i = Number.parseInt(seg, 10);
        value = Number.isInteger(i) ? value[i] : undefined;
      } else if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[seg];
      } else {
        value = undefined;
      }
    }
    let text: string;
    if (typeof value === "string") text = value;
    else if (value == null) text = "";
    else {
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
    }
    const chars = text.length;
    const truncated = chars > REF_VALUE_CHARS;
    const c = row.content as Record<string, unknown> | null;
    return {
      seq,
      kind: row.kind,
      runId: row.run_id,
      when: when(row.run_id),
      branchPath: row.branch_path ?? "",
      child: rowKindChild(row),
      op: typeof c?.op === "string" ? c.op : null,
      path: segs.length ? segs.join("/") : null,
      value: truncated ? text.slice(0, REF_VALUE_CHARS) + "…" : text,
      chars,
      truncated,
    };
  }

  // ── the read-graph walk ──────────────────────────────────────────────

  private resolveRead(read: ReadRef, runId: string, anchorSeq: number, depth: number): ProvPiece {
    let writer: Row | null = null;
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
  private latestWrite(runId: string, name: string, scope: number | null, beforeSeq: number): Row | null {
    const r = this.db
      .prepare(
        `SELECT * FROM calls WHERE run_id = ? AND kind = 'record' AND seq < ?
           AND ${scope == null ? "scope_id IS NULL" : "scope_id = ?"}
           AND json_valid(content) AND json_extract(content, '$.child') = ?
           AND json_extract(content, '$.op') IN ('memory', 'memoryUpdate')
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(...(scope == null ? [runId, beforeSeq, name] : [runId, beforeSeq, scope, name])) as RawRow | undefined;
    return r ? { ...r, content: parseJson(r.content) } : null;
  }

  /**
   * The last delivered human row for a slot (human writes carry no seq link),
   * within the read's own run.
   */
  private lastHuman(runId: string, name: string, beforeSeq: number): Row | null {
    const r = this.db
      .prepare(
        `SELECT * FROM calls WHERE run_id = ? AND kind = 'human' AND seq < ?
           AND json_valid(content) AND json_extract(content, '$.child') = ?
           AND json_extract(content, '$.delivered') = 1
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(runId, beforeSeq, name) as RawRow | undefined;
    return r ? { ...r, content: parseJson(r.content) } : null;
  }

  /**
   * The tree path a scope was created at (its `scope_init` row), for display.
   * The root scope (0) has no scope_init row — it is just "the root", so it
   * gets no label; and scopes are only ever looked up within the read's own
   * run, since scope ids are reused across runs.
   */
  private scopePath(scope: number, runId: string, beforeSeq: number): string | null {
    if (scope === 0) return null;
    const r = this.db
      .prepare(
        `SELECT branch_path FROM calls WHERE run_id = ? AND kind = 'scope_init'
           AND json_valid(content) AND json_extract(content, '$.scopeId') = ? AND seq <= ?
           AND branch_path IS NOT NULL AND branch_path != ''
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(runId, scope, beforeSeq) as { branch_path: string } | undefined;
    return r?.branch_path ?? null;
  }

  private toWriter(row: Row): ProvWriter {
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

  private noteLeaf(row: Row): void {
    if (this.leafSeen.has(row.seq)) return;
    this.leafSeen.add(row.seq);
    this.leaves.push(this.toWriter(row));
  }
}

/** The display value of a row: value / result / text, in that order. */
function rowValue(row: Row): unknown {
  const c = row.content as Record<string, unknown> | null;
  if (c && typeof c === "object") {
    if ("value" in c) return c.value;
    if ("result" in c) return c.result;
    if (typeof c.text === "string") return c.text;
  }
  return row.content;
}

/** The child/tool name a row is about. */
function rowKindChild(row: Row | null): string | null {
  if (!row) return null;
  const c = row.content as Record<string, unknown> | null;
  if (c && typeof c === "object") {
    if (typeof c.child === "string") return c.child;
    if (typeof c.tool === "string") return c.tool;
  }
  return null;
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

interface RawRow {
  seq: number;
  run_id: string;
  kind: string;
  branch_path: string | null;
  iteration: number | null;
  scope_id: number | null;
  content: string | null;
}
