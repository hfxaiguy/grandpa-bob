/** Compact, human-readable summaries of grandma-kat events for the logs. */
import type { SanitizedEvent, Turn } from "./types";

function s(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    const j = JSON.stringify(v);
    return j.length > 160 ? j.slice(0, 160) + "…" : j;
  } catch {
    return String(v);
  }
}

export interface EventLine {
  badge: string;
  text: string;
  cls: string;
  app: string;
  ts: number;
  emit: boolean;
  /** The raw event kind, so callers can count by category (e.g. tool_call). */
  kind: string;
  /** Token accounting the model endpoint reported for this call; absent when
   *  the endpoint (or a mock) reported none — "not reported" is not zero. */
  usage?: { input: number; output: number };
  /** Pretty-printed event payload for the expandable detail. */
  detail: string;
  /** Run-log row, used to fetch the full (untruncated) payload on demand. */
  seq?: number;
}

/**
 * One line per event object. The store pushes an event once and never mutates
 * it, so deriving a line is a pure function of that object. Caching by object
 * identity keeps those lines referentially stable across memo recomputes — the
 * `<For>` in EventLog/GlobalStream only mounts new rows, instead of tearing
 * down and remounting the whole window on every incoming event. That churn was
 * what closed an opened `<details>` row (and dropped its fetched payload) the
 * moment the next event arrived.
 */
const lineCache = new WeakMap<SanitizedEvent, EventLine>();

/** One log line for an event, plus its app attribution (stable per event). */
export function describeEvent(ev: SanitizedEvent): EventLine {
  const hit = lineCache.get(ev);
  if (hit) return hit;
  const line = describeEventUncached(ev);
  lineCache.set(ev, line);
  return line;
}

function describeEventUncached(ev: SanitizedEvent): EventLine {
  const c = ev.content || {};
  const app = ev.app ?? "trunk";
  // The raw prompt history is huge; summarize it in the detail rather than
  // dumping the whole message array.
  const { messages, ...rest } = c as Record<string, unknown>;
  // The server sends a summary ({ count, chars }), not the array — render it.
  const msgLabel =
    Array.isArray(messages)
      ? `[${messages.length} messages]`
      : messages && typeof messages === "object" && "count" in (messages as Record<string, unknown>)
        ? `[${(messages as { count: unknown }).count} messages, ${(messages as { chars?: unknown }).chars ?? "?"} chars]`
        : "[messages]";
  const detail = JSON.stringify(
    messages !== undefined ? { ...rest, messages: msgLabel } : rest,
    null,
    2,
  );
  const base = {
    app,
    ts: ev.ts,
    emit: false,
    kind: ev.kind,
    detail,
    ...(Number.isInteger(ev.seq) ? { seq: ev.seq } : {}),
  };
  switch (ev.kind) {
    case "tree_enter":
      return { ...base, badge: "▶", text: `${s(c.tool ?? c.tree)} — enter`, cls: "enter" };
    case "tree_exit":
      return { ...base, badge: "◀", text: `${s(c.tool ?? c.tree)} — exit${c.error ? " (error)" : ""}`, cls: "exit" };
    case "tree_suspend":
      return { ...base, badge: "⏸", text: `${s(c.tool ?? c.tree)} — suspended`, cls: "suspend" };
    case "llm_start": {
      const names = Array.isArray(c.tools) ? (c.tools as unknown[]).map(s) : [];
      const tools = names.length
        ? ` (${names.slice(0, 4).join(", ")}${names.length > 4 ? `, +${names.length - 4}` : ""})`
        : "";
      const round = Number(c.round) > 1 ? ` round ${s(c.round)}` : "";
      return {
        ...base,
        badge: "llm…",
        text: `${s(c.child) || "prompt"} — calling ${s(c.model) || "model"}${round}${tools}`,
        cls: "llm",
      };
    }
    case "llm_call": {
      const out = s(c.content);
      const calls = Array.isArray(c.toolCalls) ? (c.toolCalls as unknown[]).length : 0;
      const callLabel = calls ? ` (${calls} tool call${calls === 1 ? "" : "s"})` : "";
      // The engine logs the provider's normalized usage on every call; keep it
      // on the line so the event-count headers can sum tokens per app without
      // walking the raw content again.
      const u = c.usage as { input?: unknown; output?: unknown } | undefined;
      const input = Number(u?.input);
      const output = Number(u?.output);
      const usage = u && Number.isFinite(input) && Number.isFinite(output) ? { input, output } : undefined;
      return {
        ...base,
        badge: "llm",
        text: `${s(c.child) || "prompt"}${out ? ` → ${out}` : ""}${callLabel}`,
        cls: "llm",
        ...(usage ? { usage } : {}),
      };
    }
    case "llm_error":
      return { ...base, badge: "llm!", text: s(c.error ?? c.message), cls: "err" };
    case "tool_call":
      return { ...base, badge: "tool", text: `${s(c.tool)}(${s(c.args)})`, cls: "tool" };
    case "tool_result":
      return { ...base, badge: "↩", text: s(c.result), cls: "tool" };
    case "tool_error":
      return { ...base, badge: "tool!", text: s(c.error ?? c.message), cls: "err" };
    case "human":
      return { ...base, badge: "human", text: s(c.child) + (c.delivered ? " (delivered)" : ""), cls: "human" };
    case "emit": {
      const v = c.value as { text?: unknown } | string | undefined;
      const text = typeof v === "string" ? v : v && typeof v === "object" && "text" in v ? s(v.text) : s(v);
      return { ...base, badge: "emit", text, cls: "emit", emit: true };
    }
    case "gate":
      return { ...base, badge: "gate", text: `${s(c.child)} ${c.result ?? ""}`.trim(), cls: "gate" };
    case "check":
      return { ...base, badge: "check", text: `${s(c.child)} ${c.pass ? "pass" : "fail"}${c.feedback ? " · " + s(c.feedback) : ""}`, cls: c.pass ? "ok" : "err" };
    case "until":
      return { ...base, badge: "until", text: `${s(c.child)} ${c.pass ? "pass" : "fail"}`, cls: c.pass ? "ok" : "warn" };
    case "flow":
      return { ...base, badge: "flow", text: `${s(c.type)}${c.target ? " → " + s(c.target) : ""}`, cls: "flow" };
    case "return":
      return { ...base, badge: "return", text: s(c.value), cls: "return" };
    case "record":
    case "memory": {
      const op = s(c.op) || ev.kind;
      return { ...base, badge: op === "memoryUpdate" ? "mem↻" : "mem", text: `${s(c.child)} = ${s(c.value)}`, cls: "mem" };
    }
    case "scope_init":
      return { ...base, badge: "scope", text: `#${s(c.scopeId)}`, cls: "scope" };
    default:
      return { ...base, badge: ev.kind, text: s(c.child ?? c.name ?? c.value), cls: "" };
  }
}

/** The global stream: every event across the session's turns, in order. */
export function streamLines(turns: Turn[]): EventLine[] {
  const out: EventLine[] = [];
  for (const t of turns) for (const ev of t.events) out.push(describeEvent(ev));
  return out;
}
