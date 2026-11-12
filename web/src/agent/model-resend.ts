/**
 * Resend the model call that is in flight or parked after a failed attempt.
 *
 * The engine owns the auto tool loop, so there is no per-call handle to cancel
 * from the host. The host does control the fetch wrapper and the outer retry
 * layer, though: `retryModelCall` parks each attempt behind a controller, the
 * worker's fetch wrapper merges that controller's signal into the request, and
 * a resend aborts the request and re-issues the same call without failing the
 * turn. An exhausted retryable call stays the target for a short window, so the
 * same handshake retries that call instead of restarting the human's turn. A
 * stop and a resend therefore travel the same abort path, but only a resend is
 * retried.
 *
 * Kept free of worker globals so the retry test can exercise the handshake.
 */

export interface LiveModelCall {
  ctrl: AbortController;
  /** Set by a manual resend; consumed once by the retry loop. */
  resent: boolean;
  /** Set by a manual abandon; consumed once by the retry loop. */
  abandoned: boolean;
  /** True while the retry loop is waiting for a manual retry. */
  parked: boolean;
}

/** Attempts nest (a handler may itself call a model), so keep a stack. The
 *  newest attempt is the one a resend targets. */
const liveCalls: LiveModelCall[] = [];

/** Start one model-call attempt and make it the resend target. */
export function beginModelCall(): LiveModelCall {
  const call: LiveModelCall = { ctrl: new AbortController(), resent: false, abandoned: false, parked: false };
  liveCalls.push(call);
  return call;
}

/** The attempt ended (successfully or not); stop targeting it. */
export function endModelCall(call: LiveModelCall): void {
  const at = liveCalls.lastIndexOf(call);
  if (at >= 0) liveCalls.splice(at, 1);
}

/** The signal the worker's fetch wrapper adds to the in-flight request. */
export function liveModelCallSignal(): AbortSignal | undefined {
  return liveCalls[liveCalls.length - 1]?.ctrl.signal;
}

/**
 * Abort the newest in-flight model call and ask the retry loop to issue it
 * again. False when no call is waiting (a tool is running, or the call settled
 * between the click and the request reaching the worker).
 */
export function resendLiveModelCall(): boolean {
  const call = liveCalls[liveCalls.length - 1];
  if (!call || call.ctrl.signal.aborted) return false;
  call.resent = true;
  call.ctrl.abort();
  return true;
}

/**
 * Abort the newest parked attempt and tell the retry loop to stop waiting for
 * a manual retry. Unlike a stop, this unwinds only the failed call: the tree
 * sees the original failure and decides what to do. False when no call is
 * parked (in flight, or already settled).
 */
export function abandonLiveModelCall(): boolean {
  const call = liveCalls[liveCalls.length - 1];
  if (!call || !call.parked || call.ctrl.signal.aborted) return false;
  call.abandoned = true;
  call.ctrl.abort();
  return true;
}

/** Consume a manual-abandon marker for one attempt. */
export function takeModelAbandon(call: LiveModelCall): boolean {
  if (!call.abandoned) return false;
  call.abandoned = false;
  return true;
}

/** Consume a manual-resend marker for one attempt. */
export function takeModelResend(call: LiveModelCall): boolean {
  if (!call.resent) return false;
  call.resent = false;
  return true;
}
