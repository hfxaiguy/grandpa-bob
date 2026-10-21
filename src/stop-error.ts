/**
 * Shared stop primitives — browser-safe.
 *
 * A stop is not a model/tool failure: it is raised through the same async
 * stack as an abort, and the host records the turn as "stopped" rather than
 * surfacing an error. The engine has no cancellation parameter, so the host
 * enforces it at the three points every tree step passes through:
 *
 *   1. `fetch` (in-flight model/tool HTTP is aborted);
 *   2. tool `execute` (a long tool rejects immediately); and
 *   3. the run logger (every engine event passes through it, so the next
 *      step throws before it can run).
 *
 * The engine catches tool errors and feeds them to the model, so the logger
 * check is what makes a stopped run unwind instead of continuing with an
 * `error: stopped` tool result.
 */

/** Abort-shaped so the model layer's timeout path does not retry it. */
export class AgentStoppedError extends Error {
  readonly stopped = true;
  readonly code = "ABORT_ERR";

  constructor(message = "stopped by user") {
    super(message);
    this.name = "AbortError";
  }
}

/** True for the sentinel above (or an object carrying its marker). */
export function isAgentStopped(err: unknown): boolean {
  return (
    err instanceof AgentStoppedError ||
    (!!err && typeof err === "object" && (err as { stopped?: unknown }).stopped === true)
  );
}

export function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentStoppedError();
}

/**
 * Combine the signal a caller already had (a timeout, for example) with the
 * turn's stop signal. `AbortSignal.any` is available in Node 22 and current
 * browsers; the listener fallback keeps older engines working.
 */
export function mergeSignals(
  ...signals: (AbortSignal | null | undefined)[]
): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (!live.length) return undefined;
  if (live.length === 1) return live[0];
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, live);
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  for (const s of live) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener("abort", abort, { once: true });
  }
  return ctrl.signal;
}

/**
 * Race a promise against the stop signal. The underlying work is not
 * cancellable in JS; it is left to settle (with its rejection handled) while
 * the tree unwinds immediately. For tools that means the side effect may
 * finish, but BOB stops waiting for it and will not advance the tree.
 */
export function raceWithStop<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AgentStoppedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new AgentStoppedError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}
