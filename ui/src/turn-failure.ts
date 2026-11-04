/**
 * Turn-failure derivation for the global error banner.
 *
 * A failed turn is not the only failure worth surfacing: a model call can fail
 * inside a subtree (an app, the overhearer) or a tool shaper and be swallowed
 * there, while the turn itself completes. Those failures used to raise
 * "MODEL CALL FAILED" with no action, because the retry button only existed for
 * a turn whose status was `error`.
 *
 * The retry decision belongs here, next to the failure derivation: a completed
 * turn with an unhandled model failure can be re-run from its last input, just
 * like a hard-failed turn. An `llm_error` followed by an `llm_call` for the
 * same child/round is a transient failure grandma-kat already retried
 * successfully — it is not a failure the person needs to act on.
 */
import type { Turn } from "./types";

export interface TurnFailure {
  title: string;
  text: string;
  /** The banner offers ↻ retry: the failed turn has an input to resend. */
  retryable: boolean;
}

function eventKey(content: Record<string, unknown> | null | undefined): string | null {
  const child = typeof content?.child === "string" ? content.child : "";
  const round = content?.round;
  if (!child || typeof round !== "number") return null;
  return `${child}\u0000${round}`;
}

/**
 * The last model-call failure the engine did NOT recover from.
 *
 * grandma-kat logs an `llm_error` for every failed attempt, including ones the
 * transient-retry layer retries immediately; a successful attempt logs the
 * matching `llm_call` (same child + round). Only errors with no such recovery
 * remain actionable.
 */
export function unhandledLlmError(turn: Turn): string | null {
  const events = turn.events ?? [];
  const recovered = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== "llm_call") continue;
    const key = eventKey(ev.content);
    if (key) recovered.add(key);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== "llm_error") continue;
    const key = eventKey(ev.content);
    if (key && recovered.has(key)) continue;
    const message = ev.content?.error;
    return typeof message === "string" && message.trim() ? message : "a model call failed";
  }
  return null;
}

/** The banner a session's latest turn warrants, if any. */
export function lastTurnFailure(turns: Turn[]): TurnFailure | null {
  const last = turns[turns.length - 1];
  if (!last) return null;
  if (last.status === "stopped") return null;
  if (last.status === "error") {
    // A quota wall offers model fallbacks instead of a blind retry (the same
    // model would just hit the same wall).
    return {
      title: last.fallback?.length ? "MODEL OUT OF CREDIT" : "TURN FAILED",
      text: last.error || "the turn failed",
      retryable: !!last.input && !last.fallback?.length,
    };
  }
  const modelError = unhandledLlmError(last);
  if (!modelError) return null;
  return {
    title: "MODEL CALL FAILED",
    text: modelError,
    // A running turn cannot be retried yet; its banner appears without ↻.
    retryable: last.status !== "running" && !!last.input,
  };
}
