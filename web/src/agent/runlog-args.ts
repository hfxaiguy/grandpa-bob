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
