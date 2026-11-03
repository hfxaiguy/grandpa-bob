/**
 * read_runs argument and result shim.
 *
 * Models routinely send `type` as a JSON-encoded string ("[\"tool_call\",…]")
 * instead of an array, or quote a single kind ("\"human\""). read_runs treats
 * that string as one literal kind, so the query matches nothing — and the
 * caller then reads the empty result as "the log has no such rows".
 *
 * Normalize the filter here, and annotate condensed results with the log's
 * current max seq, so a caller cannot mistake an unqueried id for the end of
 * the log. Both are additive: a well-formed call and its rows are unchanged.
 *
 * Also restore the input side of a tool row. The engine logs a tool event as
 * `{ child, tool, args, result }`, but its readable line (runlog.mjs
 * `eventText`) renders `result`, so `args` — what the tool was called with —
 * never reaches a read_runs caller. The UI already shows it (`tool(args)`);
 * attach it (and the tool name) to the same row here.
 */

export type ReadRunsArgs = Record<string, unknown>;

export interface NormalizedReadRuns {
  args: ReadRunsArgs;
  warnings: string[];
}

/** Integer filters a model may send as numeric strings. */
const NUMERIC_FILTERS = ["id", "limit", "before", "after", "seq", "window", "depth"] as const;

function pushKind(out: string[], value: unknown): void {
  const s = String(value ?? "").trim();
  if (s) out.push(s);
}

/**
 * One `type` entry. A string that JSON-parses as a list or a quoted string is
 * treated as the kinds it encodes; anything else is one literal kind. Returns
 * true when the entry was JSON-encoded (so the caller can be told).
 */
function parseKindItem(item: unknown, out: string[]): boolean {
  if (typeof item !== "string") {
    pushKind(out, item);
    return false;
  }
  const s = item.trim();
  if (!s) return false;
  const looksEncoded =
    (s.startsWith("[") && s.endsWith("]")) || (s.startsWith('"') && s.endsWith('"'));
  if (looksEncoded) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) {
        for (const p of parsed) pushKind(out, p);
        return true;
      }
      if (typeof parsed === "string") {
        pushKind(out, parsed);
        return true;
      }
    } catch {
      // Not JSON after all — keep it as a literal kind, as read_runs would.
    }
  }
  out.push(s);
  return false;
}

function kindsFrom(value: unknown): { types: string[]; encoded: boolean } {
  const out: string[] = [];
  let encoded = false;
  for (const item of Array.isArray(value) ? value : [value]) {
    encoded = parseKindItem(item, out) || encoded;
  }
  return { types: [...new Set(out)], encoded };
}

/**
 * Normalize a read_runs argument object in place on a copy.
 * - `type` becomes a real string array (models send JSON strings).
 * - integer filters sent as numeric strings become numbers.
 */
export function normalizeReadRunsArgs(raw: unknown): NormalizedReadRuns {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ReadRunsArgs) : {};
  const args: ReadRunsArgs = { ...input };
  const warnings: string[] = [];

  if (Object.prototype.hasOwnProperty.call(args, "type")) {
    const before = args.type;
    const { types, encoded } = kindsFrom(before);
    args.type = types;
    if (encoded && types.length) {
      warnings.push(
        `type arrived as a JSON string; interpreted it as ${JSON.stringify(types)}.`,
      );
    }
  }

  for (const key of NUMERIC_FILTERS) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const value = args[key];
    if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) continue;
    const n = Number(value);
    if (Number.isSafeInteger(n)) args[key] = n;
  }

  return { args, warnings };
}

/**
 * Add `meta.max_seq` to condensed rows, and a `note` when a filtered read
 * matched nothing (or when its filter had to be normalized). Expanded/deps/
 * readers results are returned untouched.
 */
export function annotateReadRunsResult(
  result: unknown,
  args: ReadRunsArgs,
  maxSeq: number | null,
  warnings: readonly string[] = [],
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const out = { ...(result as Record<string, unknown>) };
  if (!Array.isArray(out.rows)) return result; // expanded/deps/readers shape

  const hasMax = maxSeq != null && Number.isFinite(maxSeq);
  if (hasMax) {
    const meta =
      out.meta && typeof out.meta === "object" && !Array.isArray(out.meta)
        ? (out.meta as Record<string, unknown>)
        : {};
    out.meta = { ...meta, max_seq: maxSeq };
  }

  const notes = [...warnings];
  const types = Array.isArray(args.type) ? args.type.map(String) : [];
  if (out.rows.length === 0 && types.length) {
    notes.push(
      `0 rows matched type ${JSON.stringify(types)} — the filter is a result, not proof ` +
        `the log lacks those rows. Retry with another kind or no type` +
        (hasMax ? `; the log's newest row is seq ${maxSeq}` : "") +
        ".",
    );
  }
  if (notes.length) {
    const existing = typeof out.note === "string" && out.note.trim() ? `${out.note.trim()} ` : "";
    out.note = `${existing}${notes.join(" ")}`;
  }
  return out;
}

// ── tool inputs: restore the args the readable line drops ───────────────

/** A row's raw engine content, as the log stores it (JSON text or parsed). */
export interface RowContent {
  seq: number;
  content: unknown;
}

/** Same bound as the engine's readable line (runlog.mjs `SNIPPET`). */
const MAX_ARGS = 500;

const truncate = (s: string, n = MAX_ARGS): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function parseContent(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Kinds whose content carries a tool input (`args`). */
export const TOOL_KINDS: ReadonlySet<string> = new Set([
  "tool_start",
  "tool_call",
  "tool_result",
  "tool_error",
]);

/** Every shaped row/event seq in a read_runs result (condensed, readers, expanded). */
export function resultSeqs(result: unknown, kinds?: ReadonlySet<string>): number[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const r = result as Record<string, unknown>;
  const seqs = new Set<number>();
  const add = (row: unknown): void => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    if (kinds && !kinds.has(String((row as { kind?: unknown }).kind))) return;
    const seq = Number((row as { seq?: unknown }).seq);
    if (Number.isInteger(seq)) seqs.add(seq);
  };
  if (Array.isArray(r.rows)) r.rows.forEach(add);
  if (Array.isArray(r.events)) r.events.forEach(add);
  add(r.emit);
  return [...seqs];
}

/**
 * The input a row recorded: the engine's `args` (a model's raw argument string
 * or the parsed object) and the `tool` name it belongs to. Null when the row
 * carries neither (an emit, a record, a human turn).
 */
export function toolInputFromContent(
  content: unknown,
): { tool?: string; args?: string } | null {
  const c = parseContent(content);
  if (!c) return null;
  const tool = typeof c.tool === "string" && c.tool ? c.tool : undefined;
  let args: string | undefined;
  if (c.args !== undefined && c.args !== null) {
    const raw = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
    args = truncate(raw ?? String(c.args));
  }
  if (tool === undefined && args === undefined) return null;
  return { ...(tool !== undefined ? { tool } : {}), ...(args !== undefined ? { args } : {}) };
}

/**
 * Add `tool`/`args` to the rows and events of a read_runs result from their
 * raw contents. Additive: `text` still reads as the result (or whatever
 * `eventText` chose), so nothing that reads the current shape changes.
 */
export function attachToolInputs(
  result: unknown,
  contents: readonly RowContent[],
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  if (!contents.length) return result;

  const bySeq = new Map<number, { tool?: string; args?: string }>();
  for (const row of contents) {
    const seq = Number(row?.seq);
    if (!Number.isInteger(seq)) continue;
    const input = toolInputFromContent(row.content);
    if (input) bySeq.set(seq, input);
  }
  if (!bySeq.size) return result;

  const out = { ...(result as Record<string, unknown>) };
  const enrich = (row: unknown): unknown => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const seq = Number((row as { seq?: unknown }).seq);
    const input = bySeq.get(seq);
    return input ? { ...(row as Record<string, unknown>), ...input } : row;
  };
  if (Array.isArray(out.rows)) out.rows = out.rows.map(enrich);
  if (Array.isArray(out.events)) out.events = out.events.map(enrich);
  if (out.emit && typeof out.emit === "object" && !Array.isArray(out.emit)) {
    out.emit = enrich(out.emit);
  }
  return out;
}
