// src/auto-sync.ts
//
// Periodic two-way git sync: pull (fetch + apply incoming DB dumps), then
// dump → commit → push local changes, under the sync lock. Shared by the Node
// server and the browser target; each supplies its own Platform and timers.
//
// Default is every 5 minutes; override with AUTO_SYNC_INTERVAL_MS (Node) or
// localStorage.autoSyncIntervalMs (browser). Min 15s.
//
// Guards:
//   - never runs while an agent turn is in flight (isBusy)
//   - never overlaps itself
//   - a failed pull (offline or diverged) skips the push that tick
//   - a failed push is reported, never forced
// The run log is not touched here (it has its own retention).

import type { Platform } from "./platform/types.js";
import { applyDatabaseDumps, flushDirtyDumps, withSyncLock } from "./db-sync.js";

export const DEFAULT_INTERVAL_MS = 5 * 60_000;
export const MIN_INTERVAL_MS = 15_000;

export interface AutoSyncResult {
  skipped?: "busy" | "in-flight" | "no-remote";
  pulled?: boolean;
  applied?: number;
  dumps?: number;
  committed?: string;
  pushed?: boolean;
  error?: string;
}

export interface AutoSyncOptions {
  platform: Platform;
  /** The git remote (url or configured name); dynamic so Settings can change it. */
  remote: () => string | undefined;
  branch?: () => string | undefined;
  intervalMs?: number;
  /** True while an agent turn is running — sync waits for a quiet moment. */
  isBusy?: () => boolean;
  log?: (message: string, result?: AutoSyncResult) => void;
}

export interface AutoSync {
  start(): void;
  stop(): void;
  /** Run one sync now (used by the timer and tests). */
  tick(): Promise<AutoSyncResult>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createAutoSync(opts: AutoSyncOptions): AutoSync {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const log = opts.log ?? (() => {});
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<AutoSyncResult> {
    const remote = opts.remote();
    if (!remote) return { skipped: "no-remote" };
    if (running) return { skipped: "in-flight" };
    if (opts.isBusy?.()) return { skipped: "busy" };
    running = true;
    try {
      const git = opts.platform.git;
      const gitPull = git.pull;
      const gitFetch = git.fetch;
      const gitPush = git.push;
      const autoCommit = git.autoCommit;
      const branch = opts.branch?.();

      // 1) pull first, so local dumps are written on top of the latest remote.
      let pulled = false;
      if (gitPull || gitFetch) {
        try {
          if (gitPull) await gitPull(remote, branch);
          else if (gitFetch) await gitFetch(remote, branch);
          pulled = true;
        } catch (err) {
          const result: AutoSyncResult = { error: `pull failed: ${message(err)}` };
          log("pull failed", result);
          return result;
        }
      }
      const applied = await applyDatabaseDumps(opts.platform).catch(() => null);

      // 2) dump + commit + push under the lock (node: real ref; browser: mutex).
      const out = await withSyncLock(opts.platform, { remote }, async () => {
        const paths = await flushDirtyDumps(opts.platform).catch(() => []);
        let committed = "no-changes";
        if (autoCommit && paths.length) {
          committed = await autoCommit(paths, "auto-sync: database dumps").catch((e) => `failed: ${message(e)}`);
        }
        if (gitPush) await gitPush(remote, branch);
        return { written: paths, committed };
      });

      const result: AutoSyncResult = {
        pulled,
        applied: applied?.applied.length ?? 0,
        dumps: out.written.length,
        committed: out.committed,
        pushed: !!gitPush,
      };
      log("synced", result);
      return result;
    } catch (err) {
      const result: AutoSyncResult = { error: message(err) };
      log("failed", result);
      return result;
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), interval);
      // Node: don't hold the process open just for the sync timer.
      const t = timer as unknown as { unref?: () => void };
      t.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
