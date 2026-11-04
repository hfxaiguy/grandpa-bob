/**
 * Turn-failure derivation — what the global banner shows and when it offers ↻.
 *
 * The bug this pins: an app subtree (or another swallowed model call) timed out,
 * the turn completed, and the banner said MODEL CALL FAILED with no retry —
 * even though the same input could be resent from the session's checkpoint. A
 * transient failure that grandma-kat retried successfully must NOT raise the
 * banner.
 *
 * Pure: no DOM, no browser. Run: npm run test:turn-failure
 */
import assert from "node:assert/strict";
import { lastTurnFailure, unhandledLlmError } from "../ui/src/turn-failure.ts";
import type { SanitizedEvent, Turn } from "../ui/src/types.ts";

let seq = 0;
function ev(kind: string, content: Record<string, unknown> = {}): SanitizedEvent {
  return { kind, branch_path: "", iteration: 0, scope_id: null, content, ts: ++seq };
}

function turn(patch: Partial<Turn> = {}): Turn {
  return {
    turnId: "t1",
    input: "ping",
    inputApp: "trunk",
    startedAt: 1,
    endedAt: 2,
    status: "done",
    error: null,
    output: "ok",
    events: [],
    ...patch,
  };
}

// No turn ⇒ nothing to show.
assert.equal(lastTurnFailure([]), null);

// A hard-failed turn keeps its retry, as before.
const failed = lastTurnFailure([turn({ status: "error", error: "boom" })]);
assert.deepEqual(failed, { title: "TURN FAILED", text: "boom", retryable: true });

// A quota wall's fallback buttons replace the blind retry.
const quota = lastTurnFailure([
  turn({ status: "error", error: "402", fallback: [{ label: "v4", value: "v4" }] }),
]);
assert.equal(quota?.title, "MODEL OUT OF CREDIT");
assert.equal(quota?.retryable, false);

// A user stop is not a failure.
assert.equal(lastTurnFailure([turn({ status: "stopped" })]), null);

// A completed turn whose app call timed out: the call is visible, and the input
// that produced it can be sent again.
const appTimeout = lastTurnFailure([
  turn({
    status: "done",
    events: [
      ev("llm_start", { child: "select", round: 1 }),
      ev("llm_error", { child: "select", round: 1, error: "LLM request timed out after 0.8s" }),
      ev("llm_call", { child: "response", round: 1 }),
    ],
  }),
]);
assert.deepEqual(appTimeout, {
  title: "MODEL CALL FAILED",
  text: "LLM request timed out after 0.8s",
  retryable: true,
});

// The transient-retry layer logs the failure and then the successful attempt
// with the same child + round: that is not a failure the person must act on.
const recovered = turn({
  events: [
    ev("llm_error", { child: "response", round: 1, error: "LLM request timed out after 120s" }),
    ev("llm_call", { child: "response", round: 1 }),
  ],
});
assert.equal(unhandledLlmError(recovered), null);
assert.equal(lastTurnFailure([recovered]), null);

// Same round, different child is a different call (the failed one stands).
assert.equal(
  unhandledLlmError(
    turn({
      events: [
        ev("llm_error", { child: "select", round: 1, error: "timed out" }),
        ev("llm_call", { child: "summarize", round: 1 }),
      ],
    }),
  ),
  "timed out",
);

// A still-running turn shows the banner but cannot retry yet.
const running = lastTurnFailure([
  turn({ status: "running", events: [ev("llm_error", { child: "response", round: 1, error: "timed out" })] }),
]);
assert.equal(running?.retryable, false, "a running turn has nothing to resend yet");

// A failed turn with no input (a synthetic turn) is not retryable.
assert.equal(lastTurnFailure([turn({ status: "error", error: "boom", input: "" })])?.retryable, false);

// Missing child/round metadata is still surfaced (cannot prove recovery).
assert.equal(
  unhandledLlmError(turn({ events: [ev("llm_error", { error: "opaque failure" })] })),
  "opaque failure",
);

console.log("turn-failure: banner derivation and retryability OK");
