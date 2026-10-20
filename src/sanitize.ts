/**
 * Event sanitization for the browser — shared by the live SSE path
 * (src/admin.ts) and the read-time derivation of persisted turns
 * (src/web-log.ts), so a turn looks identical whether it is being streamed
 * or replayed from the log DB.
 */

/** Per-event string cap before the UI ever sees it. */
export const MAX_EVENT_STR = 400;

export interface SanitizedEvent {
  kind: string;
  branch_path: string;
  iteration: number;
  scope_id: number | null;
  content: Record<string, unknown> | null;
  ts: number;
  /** The run-log row this event was (kept for replay/ref navigation). */
  seq?: number;
  /** The app (outermost tree tool) this event belongs to; "trunk" at top level. */
  app?: string;
}

function truncStr(s: string): string {
  return s.length > MAX_EVENT_STR ? s.slice(0, MAX_EVENT_STR) + "…" : s;
}

/** Recursively cap string length and long arrays so events stay streamable. */
export function sanitizeValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return truncStr(v);
  if (v === null || typeof v !== "object") return v;
  if (depth > 4) return "…";
  if (Array.isArray(v)) {
    if (v.length > 6) {
      return { _summary: `${v.length} items`, last: sanitizeValue(v[v.length - 1], depth + 1) };
    }
    return v.map((x) => sanitizeValue(x, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = sanitizeValue(val, depth + 1);
  }
  return out;
}

export function sanitizeEvent(
  e: { kind?: string; branch_path?: string; iteration?: number; scope_id?: number | null; seq?: number; content?: Record<string, unknown> | null },
  app = "trunk",
): SanitizedEvent {
  const content: Record<string, unknown> = { ...(e.content ?? {}) };
  // Keep the prompt input exactly as sent: attach it raw after generic
  // sanitization, which would otherwise truncate strings and collapse the
  // message array into a summary.
  const messages = Array.isArray(content.messages) ? content.messages : null;
  delete content.messages;
  const clean = sanitizeValue(content) as Record<string, unknown>;
  // The prompt history is huge (the trunk's system prompt alone is ~10 KB) and
  // the UI only ever summarizes it — send the count and size, never the array.
  // This is what kept single llm_call events at ~130 KB.
  if (messages) {
    clean.messages = {
      count: messages.length,
      chars: messages.reduce(
        (n, m) => n + String(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")).length,
        0,
      ),
    };
  }
  return {
    kind: e.kind ?? "unknown",
    branch_path: e.branch_path ?? "",
    iteration: e.iteration ?? 0,
    scope_id: e.scope_id ?? null,
    content: clean,
    ts: Date.now(),
    ...(Number.isInteger(e.seq) ? { seq: e.seq } : {}),
    app,
  };
}
