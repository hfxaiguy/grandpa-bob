/**
 * Host-level retry for a failed model call.
 *
 * grandma-kat already retries the transient failures it knows about (429, a
 * short list of 5xx, transport/truncated bodies and — once — a timeout). A
 * provider can still surface a transient failure after that budget is spent
 * (load-shedding 52x/529, a second timeout, a connection reset between
 * attempts), and the host used to turn that straight into a failed turn. This
 * wrapper gives such a call one more chance before failing; the browser host
 * also leaves an exhausted call parked until the person acts, so ↻ can
 * re-issue that request instead of resending the human message.
 *
 * It is deliberately narrow: a stop/cancel, a quota wall, an auth failure and
 * a malformed request are never retried. Retrying those cannot change the
 * answer and a quota wall has its own fallback path.
 */
import { callLlm } from "grandma-kat/llm";
import type { ModelEntry, ModelRegistry } from "../model-config";
import { AgentStoppedError } from "../stop-error";
import {
  beginModelCall,
  endModelCall,
  takeModelAbandon,
  takeModelResend,
  type LiveModelCall,
} from "./model-resend";

/** Statuses where another attempt can plausibly succeed. */
function retryableStatus(status: number): boolean {
  // 408 request timeout, 409 conflict, 425 too early, 429 rate limit, and the
  // whole 5xx family (including provider-specific 520/522/524/529 shedding).
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** A failure from a caller stop or the engine's stop sentinel. */
function isStop(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown; stopped?: unknown };
  return e.stopped === true || e.name === "AbortError" || e.name === "AgentStoppedError" || e.code === "ABORT_ERR";
}

/** True when a model-call error is worth another attempt. */
export function isRetryableModelError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isStop(err)) return false;
  const e = err as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : String(err);
  // A quota wall is a decision, not a transient failure — even when the
  // provider spells it as a 429. Fallback choices handle it.
  if (/quota|billing|insufficient (?:credit|funds)|out of credit|credit balance/i.test(message)) return false;
  const status = Number(e.status);
  if (Number.isFinite(status) && status > 0) return retryableStatus(status);
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "llm_timeout" || code === "llm_bad_body") return true;
  const name = typeof e.name === "string" ? e.name : "";
  if (name === "LlmTimeoutError" || name === "LlmBodyError" || name === "TimeoutError") return true;
  if (name === "TypeError") return true; // fetch/network failure
  // A wrapper may surface the provider status only in the message; classify it
  // the same way instead of treating every "LLM request failed" as transient.
  const embedded = /(?:LLM|Ollama) request failed \((\d{3})\)|\bHTTP (\d{3})\b/.exec(message);
  if (embedded) return retryableStatus(Number(embedded[1] ?? embedded[2]));
  return /timed out|stalled|fetch failed|Failed to fetch|NetworkError|Load failed|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|UND_ERR|truncated body|content-length/i.test(
    message,
  );
}

/** A failed call that is waiting for the person to press retry. */
export interface ModelRetryWait {
  /** The failure the automatic attempts ended on. */
  error: unknown;
  /** Which automatic attempt failed (1-based). */
  attempt: number;
  /** The model slot the call was resolved to (`strong`, `cheap`, …). */
  slot?: string;
}

export interface RetryModelCallOptions {
  /** Total attempts, including the first. Defaults to 2 (one retry). */
  attempts?: number;
  /** First backoff delay. Defaults to 750ms; doubles per retry. */
  baseDelayMs?: number;
  /** The turn's stop signal; a stop cancels the wait before the next attempt. */
  signal?: AbortSignal;
  /**
   * How long a failed final attempt stays open for a manual retry. The live
   * call remains the resend target, so the chat's ↻ retry can re-issue exactly
   * this request without re-running the turn. 0 (the default) fails at once;
   * `Infinity` keeps it parked until the person retries, cancels, or stops.
   */
  manualRetryMs?: number;
  /** Called once when the automatic attempts are spent and the manual wait starts. */
  onWaiting?: (wait: ModelRetryWait) => void;
  /**
   * Called when the manual wait ends — retry, cancel, timeout, or stop. The
   * host uses it to resume its run watchdog before the next request starts.
   */
  onResumed?: () => void;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait on a failed call without releasing it as the resend target. A manual
 * resend aborts the live call's controller; a stop aborts the turn's signal.
 */
type WaitOutcome = "resend" | "abandon" | "timeout" | "stop";

function waitForManualRetry(
  call: LiveModelCall,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      call.ctrl.signal.removeEventListener("abort", onCallAbort);
      signal?.removeEventListener("abort", onStop);
      resolve(outcome);
    };
    const onCallAbort = (): void =>
      finish(call.abandoned ? "abandon" : call.resent ? "resend" : "stop");
    const onStop = (): void => finish("stop");
    call.ctrl.signal.addEventListener("abort", onCallAbort, { once: true });
    signal?.addEventListener("abort", onStop, { once: true });
    // A finite window falls back to the original failure; Infinity waits for
    // a person (the host parks the run watchdog so it is not called stuck).
    if (Number.isFinite(ms)) timer = setTimeout(() => finish("timeout"), ms);
    // A resend/abandon/stop can land between the failure and this wait; the
    // event listener alone would miss it and hold the turn until the timeout.
    if (call.ctrl.signal.aborted) {
      finish(call.abandoned ? "abandon" : call.resent ? "resend" : "stop");
    } else if (signal?.aborted) {
      finish("stop");
    }
  });
}

/**
 * Run `fn` once, and again after a short backoff when it fails with a
 * transient model error. The original error is thrown once the attempts run
 * out (or the failure is not retryable).
 *
 * A manual resend aborts the current attempt (through `model-resend`) and
 * re-issues it immediately. It does not consume the automatic retry budget:
 * the person asked for this attempt, so a manual retry starts with a fresh
 * transient budget.
 *
 * With `manualRetryMs`, an exhausted retryable call is not thrown at once: it
 * stays the resend target for that window (or indefinitely when the value is
 * `Infinity`), so the person can retry the call itself instead of restarting
 * the turn from its last human message.
 */
export async function retryModelCall<T>(
  fn: () => Promise<T>,
  opts: RetryModelCallOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 2));
  const base = Math.max(0, opts.baseDelayMs ?? 750);
  const manualRetryMs = Math.max(0, Math.floor(opts.manualRetryMs ?? 0));
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 1;
  for (;;) {
    if (opts.signal?.aborted) throw new AgentStoppedError();
    const call = beginModelCall();
    let failure: unknown;
    try {
      const value = await fn();
      endModelCall(call);
      return value;
    } catch (err) {
      failure = err;
    }
    if (takeModelAbandon(call)) {
      endModelCall(call);
      throw failure;
    }
    const resent = takeModelResend(call);
    if (resent) {
      endModelCall(call);
      if (opts.signal?.aborted) throw new AgentStoppedError();
      attempt = 1;
      continue;
    }
    if (opts.signal?.aborted) {
      endModelCall(call);
      throw new AgentStoppedError();
    }
    if (!isRetryableModelError(failure)) {
      endModelCall(call);
      throw failure;
    }
    if (attempt < attempts) {
      endModelCall(call);
      await sleep(base * 2 ** (attempt - 1));
      attempt += 1;
      continue;
    }
    if (manualRetryMs > 0) {
      try {
        opts.onWaiting?.({ error: failure, attempt });
      } catch {
        /* a host observer must not kill the call */
      }
      call.parked = true;
      let outcome: WaitOutcome;
      try {
        outcome = await waitForManualRetry(call, opts.signal, manualRetryMs);
      } finally {
        call.parked = false;
        try {
          opts.onResumed?.();
        } catch {
          /* a host observer must not kill the call */
        }
      }
      if (outcome === "resend") {
        takeModelResend(call);
        endModelCall(call);
        attempt = 1;
        continue;
      }
      endModelCall(call);
      if (takeModelAbandon(call)) throw failure;
      if (outcome === "stop" || opts.signal?.aborted) throw new AgentStoppedError();
    } else {
      endModelCall(call);
    }
    throw failure;
  }
}

/**
 * Wrap every model entry so every call goes through `retryModelCall`. The
 * entry's own `handler` (a mock) and grandma-kat's protocol/transform handling
 * still run inside `callLlm`; only the outermost attempt is retried.
 */
export function withModelRetry(
  registry: ModelRegistry,
  opts: RetryModelCallOptions = {},
): ModelRegistry {
  const out: ModelRegistry = {};
  for (const [name, entry] of Object.entries(registry)) {
    out[name] = {
      ...entry,
      handler: (messages, options) =>
        retryModelCall(() => callLlm(entry, messages, options), {
          ...opts,
          // The engine knows the prompt, not the model slot; the registry
          // wrapper does, so a manual retry can say which role failed.
          onWaiting: opts.onWaiting
            ? (wait) => opts.onWaiting!({ ...wait, slot: name })
            : undefined,
        }),
    } satisfies ModelEntry;
  }
  return out;
}
