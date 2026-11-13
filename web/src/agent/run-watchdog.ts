/**
 * Run watchdog for the browser host.
 *
 * grandma-kat bounds each LLM call (whole-call deadline + body idle window), so
 * a hung provider now fails the call instead of the turn. This covers the layer
 * above: a turn whose worker died, or whose run promise never settles, leaves
 * the UI in "running" forever because nothing else can flip it.
 *
 * The watchdog is deliberately dumb. Each run carries a last-activity
 * timestamp; a run that goes silent for `staleMs` is reported once through its
 * `onStale` callback, and the host decides how to stop and settle it. A run
 * parked on a failed model call is excluded entirely: waiting for a person is
 * not a wedge, and the parked time does not count toward the turn's budget.
 */

/**
 * Silence that means a run is wedged, not thinking. Above the longest per-call
 * budget (Ollama's 10-minute default) so a live model call cannot trip it.
 */
export const DEFAULT_STALE_MS = 15 * 60_000;
export const DEFAULT_CHECK_MS = 30_000;
/**
 * A hard wall-clock budget for one turn. A productive run can last a long time,
 * but a loop that keeps making new (and useless) tool calls never goes silent,
 * so the silence check alone cannot catch it. This is the backstop.
 */
export const DEFAULT_MAX_MS = 45 * 60_000;

export type WatchdogReason = "silent" | "expired";

export interface WatchdogRun {
  /** Session key the run belongs to (one in-flight run per session). */
  key: string;
  turnId: string;
  /** Called once, when the run is silent or exceeds its wall-clock budget. */
  onStale: (reason: WatchdogReason) => void;
}

interface LiveRun extends WatchdogRun {
  lastActivityAt: number;
  startedAt: number;
  /** Set while a failed model call waits for a manual retry. */
  parkedAt: number | null;
}

export interface RunWatchdog {
  start(run: WatchdogRun): void;
  /** Mark activity for a run; ignored when the turn/session is not tracked. */
  touch(key: string, turnId: string): void;
  /**
   * A model call failed and the run is waiting for the person to retry,
   * cancel, or stop. Suspend both the silence and wall-clock checks; the time
   * spent parked is excluded from the budget when the run unpauses.
   */
  park(key: string, turnId: string): void;
  /** The parked call resolved; restart the clocks. */
  unpark(key: string, turnId: string): void;
  /** Stop tracking a run that settled normally (or was already reported). */
  finish(key: string, turnId: string): void;
  /** Report stale runs now; exposed for tests and load-time sweeps. */
  check(): void;
  /** Stop the check interval (page teardown / tests). */
  stop(): void;
}

export interface RunWatchdogOptions {
  /** Silence before a run is reported stale. Default {@link DEFAULT_STALE_MS}. */
  staleMs?: number;
  /** Wall-clock budget for one run. Default {@link DEFAULT_MAX_MS}. */
  maxMs?: number;
  /** How often to sweep. Default {@link DEFAULT_CHECK_MS}. */
  checkMs?: number;
  /** Injectable clock and timers so tests are deterministic. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export function createRunWatchdog(opts: RunWatchdogOptions = {}): RunWatchdog {
  const staleOpt = opts.staleMs ?? 0;
  const maxOpt = opts.maxMs ?? 0;
  const checkOpt = opts.checkMs ?? 0;
  const staleMs = Number.isFinite(staleOpt) && staleOpt > 0 ? staleOpt : DEFAULT_STALE_MS;
  const maxMs = Number.isFinite(maxOpt) && maxOpt > 0 ? maxOpt : DEFAULT_MAX_MS;
  const checkMs = Number.isFinite(checkOpt) && checkOpt > 0 ? checkOpt : DEFAULT_CHECK_MS;
  const now = opts.now ?? (() => Date.now());
  const startTimer = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopTimer = opts.clearInterval ?? ((handle) => clearInterval(handle));
  const runs = new Map<string, LiveRun>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = (): void => {
    const at = now();
    // Snapshot so an onStale handler that starts another run cannot mutate the
    // iteration.
    for (const [key, run] of [...runs]) {
      // Waiting for a person is not a wedge: the host parked the run when the
      // call exhausted its automatic retries. Retry/cancel/stop unpark it.
      if (run.parkedAt != null) continue;
      const silent = at - run.lastActivityAt >= staleMs;
      const expired = at - run.startedAt >= maxMs;
      if (!silent && !expired) continue;
      runs.delete(key);
      try {
        run.onStale(expired ? "expired" : "silent");
      } catch (err) {
        console.warn("run watchdog: stale handler failed", err);
      }
    }
  };

  return {
    start(run) {
      runs.set(run.key, { ...run, lastActivityAt: now(), startedAt: now(), parkedAt: null });
      if (!timer) timer = startTimer(check, checkMs);
    },
    touch(key, turnId) {
      const run = runs.get(key);
      if (!run || run.turnId !== turnId) return;
      run.lastActivityAt = now();
    },
    park(key, turnId) {
      const run = runs.get(key);
      if (!run || run.turnId !== turnId || run.parkedAt != null) return;
      run.parkedAt = now();
    },
    unpark(key, turnId) {
      const run = runs.get(key);
      if (!run || run.turnId !== turnId || run.parkedAt == null) return;
      const at = now();
      // Exclude the parked period from the wall-clock budget; a person taking
      // their time is not a runaway loop.
      run.startedAt += at - run.parkedAt;
      run.lastActivityAt = at;
      run.parkedAt = null;
    },
    finish(key, turnId) {
      const run = runs.get(key);
      if (run?.turnId === turnId) runs.delete(key);
    },
    check,
    stop() {
      if (timer) stopTimer(timer);
      timer = null;
      runs.clear();
    },
  };
}
