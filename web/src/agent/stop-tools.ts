/**
 * Tool wrappers shared by the browser agent host.
 *
 * Kept apart from agent-worker.ts so the error/stop contracts can be tested
 * without booting a worker (OPFS, sqlite-wasm, `self`, …).
 */
import { isAgentStopped, raceWithStop, throwIfStopped } from "../stop-error";

/** Pause/goto are control flow for the engine, not tool failures. */
export function isControlFlowSignal(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const signal = err as Record<string, unknown>;
  return typeof signal.checkpointId === "string" || (typeof signal.target === "string" && "value" in signal);
}

/**
 * Reject a tool call as soon as the turn is stopped, even if its work continues.
 *
 * Also turn a thrown tool error into the engine's error-result shape. The
 * engine's explicit-loop path (`Call` under `disableAuto`) rethrows a host
 * tool's exception, which kills the whole tree and returns the raw error to
 * the caller — one rejected `csv_query` on an mbox was enough to discard a
 * whole read. Returning `{ error }` instead lets the app fold it into the
 * thread and recover, exactly as the auto-loop path already does.
 */
export function withStopTools(tools: Record<string, unknown>, signal: AbortSignal): Record<string, unknown> {
  const wrapped = new Map<string, unknown>();
  return new Proxy(tools, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop !== "string" ||
        !value ||
        typeof value !== "object" ||
        typeof (value as { execute?: unknown }).execute !== "function"
      ) {
        return value;
      }
      const hit = wrapped.get(prop);
      if (hit) return hit;
      const tool = value as { execute: (...args: unknown[]) => unknown };
      const execute = tool.execute.bind(tool);
      const out = {
        ...tool,
        execute: async (...args: unknown[]) => {
          throwIfStopped(signal);
          try {
            return await raceWithStop(Promise.resolve(execute(...args)), signal);
          } catch (err) {
            if (isAgentStopped(err) || isControlFlowSignal(err)) throw err;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
      };
      wrapped.set(prop, out);
      return out;
    },
  });
}
