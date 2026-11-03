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
 * `onStale` callback, and the host decides how to stop and settle it.
 */

/**
 * Silence that means a run is wedged, not thinking. Above the longest per-call
 * budget (Ollama's 10-minute default) so a live model call cannot trip it.
 */
export const DEFAULT_STALE_MS = 15 * 60_000;
export const DEFAULT_CHECK_MS = 30_000;

export interface WatchdogRun {
  /** Session key the run belongs to (one in-flight run per session). */
  key: string;
  turnId: string;
  /** Called once, when the run has shown no activity for `staleMs`. */
  onStale: () => void;
}

interface LiveRun extends WatchdogRun {
  lastActivityAt: number;
}

export interface RunWatchdog {
  start(run: WatchdogRun): void;
  /** Mark activity for a run; ignored when the turn/session is not tracked. */
  touch(key: string, turnId: string): void;
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
  /** How often to sweep. Default {@link DEFAULT_CHECK_MS}. */
  checkMs?: number;
  /** Injectable clock and timers so tests are deterministic. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export function createRunWatchdog(opts: RunWatchdogOptions = {}): RunWatchdog {
  const staleOpt = opts.staleMs ?? 0;
  const checkOpt = opts.checkMs ?? 0;
  const staleMs = Number.isFinite(staleOpt) && staleOpt > 0 ? staleOpt : DEFAULT_STALE_MS;
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
      if (at - run.lastActivityAt < staleMs) continue;
      runs.delete(key);
      try {
        run.onStale();
      } catch (err) {
        console.warn("run watchdog: stale handler failed", err);
      }
    }
  };

  return {
    start(run) {
      runs.set(run.key, { ...run, lastActivityAt: now() });
      if (!timer) timer = startTimer(check, checkMs);
    },
    touch(key, turnId) {
      const run = runs.get(key);
      if (!run || run.turnId !== turnId) return;
      run.lastActivityAt = now();
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
