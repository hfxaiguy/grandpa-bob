/**
 * Node-side stop plumbing: an AsyncLocalStorage carries the running turn's
 * abort signal into `fetch`, so one session's stop cannot abort another
 * session's model call.
 *
 * This module is Node-only (the browser worker has its own one-run-at-a-time
 * signal). Importing it installs the fetch wrapper once for the process.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  AgentStoppedError,
  mergeSignals,
  throwIfStopped,
} from "./stop-error.js";

const stopScope = new AsyncLocalStorage<AbortSignal>();

/** Run `fn` with `signal` visible to the stop-aware fetch wrapper. */
export function runWithStop<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (!signal) return fn();
  throwIfStopped(signal);
  return stopScope.run(signal, fn);
}

const PATCHED = Symbol.for("grandpa-bob.stop-fetch");

/** Install the one process-wide fetch wrapper (idempotent across imports). */
export function installStopAwareFetch(): void {
  const current = globalThis.fetch as typeof fetch & { [PATCHED]?: boolean };
  if (current?.[PATCHED]) return;
  const nativeFetch = globalThis.fetch.bind(globalThis);

  const wrapped = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const stop = stopScope.getStore();
    if (!stop) return nativeFetch(input, init);
    if (stop.aborted) return Promise.reject(new AgentStoppedError());
    const requestSignal =
      typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined;
    const signal = mergeSignals(requestSignal, init?.signal, stop);
    return nativeFetch(input, { ...(init ?? {}), signal });
  }) as typeof fetch & { [PATCHED]?: boolean };

  wrapped[PATCHED] = true;
  globalThis.fetch = wrapped;
}

installStopAwareFetch();
