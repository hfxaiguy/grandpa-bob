/**
 * Inspecting one `ref://<seq>[/path]` handle.
 *
 * Kept apart from `provenance.ts` because the in-browser backend resolves refs
 * from the run-log rows the worker streams to the page. Importing the Node
 * reader there would drag `node:sqlite` (a throwing browser stub) into the
 * bundle; this module is pure and shared by both hosts.
 */

/** Display cap for an inspected `ref://` target (a click wants the whole thing). */
export const REF_VALUE_CHARS = 200000;

/** The log-row fields a ref target needs (the browser keeps these in memory). */
export interface RefSourceRow {
  seq: number;
  run_id: string;
  kind: string;
  branch_path?: string | null;
  content: unknown;
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

/** The run start time encoded in the run id (2026-10-02_19-56-16-15). */
export function when(runId: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(String(runId ?? ""));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(runId ?? "");
}

/** The display value of a row: value / result / text, in that order. */
export function rowValue(row: { content: unknown }): unknown {
  const c = row.content as Record<string, unknown> | null;
  if (c && typeof c === "object") {
    if ("value" in c) return c.value;
    if ("result" in c) return c.result;
    if (typeof c.text === "string") return c.text;
  }
  return row.content;
}

/** The child/tool name a row is about. */
export function rowKindChild(row: { content: unknown } | null): string | null {
  if (!row) return null;
  const c = row.content as Record<string, unknown> | null;
  if (c && typeof c === "object") {
    if (typeof c.child === "string") return c.child;
    if (typeof c.tool === "string") return c.tool;
  }
  return null;
}

/**
 * A ref target from one log row. Shared by the Node reader (rows from the
 * `calls` table) and the in-browser backend (rows streamed to the page), so a
 * ref clicked in either host inspects identically.
 */
export function refTargetFromRow(row: RefSourceRow, path?: string | null): RefTarget {
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
    seq: row.seq,
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
