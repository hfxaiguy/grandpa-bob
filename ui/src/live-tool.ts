/**
 * Live tool activity for the tiled chat.
 *
 * A running turn streams its engine events into `turn.events` as they happen;
 * this module folds that list into the one thing the chat should show under
 * the last message: the tool executing right now (announced by `tool_start`)
 * and the tool that finished most recently (`tool_result`/`tool_call`).
 *
 * Kept free of Solid and DOM so the fold can be exercised from a script test.
 */
import { newTurnApps, tagEventApp } from "../../src/app-attribution";
import type { SanitizedEvent, Turn } from "./types";

export interface LiveToolCall {
  tool: string;
  /** Compact, single-line rendering of the call arguments. */
  args: string;
  ts: number;
}

export interface LiveDone extends LiveToolCall {
  isError: boolean;
}

export interface LiveActivity {
  /** The tool running right now; null between calls (the model is thinking). */
  current: LiveToolCall | null;
  /** The most recently finished call for this app. */
  lastDone: LiveDone | null;
}

const MAX_ARG_CHARS = 120;

/** One-line JSON-ish rendering of tool arguments, capped for the chat row. */
export function argText(v: unknown): string {
  let text: string;
  if (v == null) return "";
  if (typeof v === "string") text = v;
  else {
    try {
      text = JSON.stringify(v);
    } catch {
      text = String(v);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_ARG_CHARS ? text.slice(0, MAX_ARG_CHARS) + "\u2026" : text;
}

/** `tool(args)` (or just `tool` when the call carries no arguments). */
export function toolLabel(tool: unknown, args: unknown): string {
  const name = typeof tool === "string" && tool ? tool : "tool";
  const a = argText(args);
  return a ? `${name}(${a})` : name;
}

function callOf(e: SanitizedEvent, c: Record<string, unknown>): LiveToolCall {
  return {
    tool: typeof c.tool === "string" ? c.tool : "tool",
    args: argText(c.args),
    ts: e.ts,
  };
}

/**
 * Fold a running turn's events into the activity of one app tile. App
 * attribution walks the same boundary stack the server uses, so a nested app
 * run lands on its own tile and never leaks onto the caller's.
 */
export function liveActivity(
  turn: Turn | null | undefined,
  app: string,
  appNames?: Iterable<string>,
): LiveActivity {
  const out: LiveActivity = { current: null, lastDone: null };
  if (!turn || turn.status !== "running") return out;
  const st = newTurnApps(appNames ? [...appNames] : undefined);
  for (const e of turn.events) {
    const evApp = tagEventApp(st, e);
    if (evApp !== app) continue;
    const c = (e.content ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case "tool_start":
        out.current = callOf(e, c);
        break;
      case "tool_result":
      case "tool_call":
      case "tool_error": {
        out.lastDone = { ...callOf(e, c), isError: c.isError === true || e.kind === "tool_error" };
        out.current = null;
        break;
      }
    }
  }
  return out;
}
