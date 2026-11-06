/**
 * Host-level retry for a failed model call.
 *
 * grandma-kat already retries the transient failures it knows about (429, a
 * short list of 5xx, transport/truncated bodies and — once — a timeout). A
 * provider can still surface a transient failure after that budget is spent
 * (load-shedding 52x/529, a second timeout, a connection reset between
 * attempts), and the host used to turn that straight into a failed turn. This
 * wrapper gives such a call one more chance before the turn fails.
 *
 * It is deliberately narrow: a stop/cancel, a quota wall, an auth failure and
 * a malformed request are never retried. Retrying those cannot change the
 * answer and a quota wall has its own fallback path.
 */
import { callLlm } from "grandma-kat/llm";
import type { ModelEntry, ModelRegistry } from "../model-config";
import { AgentStoppedError } from "../stop-error";

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

export interface RetryModelCallOptions {
  /** Total attempts, including the first. Defaults to 2 (one retry). */
  attempts?: number;
  /** First backoff delay. Defaults to 750ms; doubles per retry. */
  baseDelayMs?: number;
  /** The turn's stop signal; a stop cancels the wait before the next attempt. */
  signal?: AbortSignal;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` once, and again after a short backoff when it fails with a
 * transient model error. The original error is thrown once the attempts run
 * out (or the failure is not retryable).
 */
export async function retryModelCall<T>(
  fn: () => Promise<T>,
  opts: RetryModelCallOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 2));
  const base = Math.max(0, opts.baseDelayMs ?? 750);
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw new AgentStoppedError();
    try {
      return await fn();
    } catch (err) {
      if (opts.signal?.aborted) throw new AgentStoppedError();
      if (attempt >= attempts || !isRetryableModelError(err)) throw err;
      await sleep(base * 2 ** (attempt - 1));
    }
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
        retryModelCall(() => callLlm(entry, messages, options), opts),
    } satisfies ModelEntry;
  }
  return out;
}
