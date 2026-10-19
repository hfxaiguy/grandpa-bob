/**
 * Browser grandma-kat loggers.
 *
 * `createMemoryLogger` is the synchronous contract knit() needs: { log,
 * saveCheckpoint, getCheckpoint, deleteCheckpoint, getEvents, close }. Events
 * and checkpoints live in memory; `onEvent` lets the worker stream each event
 * to the UI.
 *
 * `createWorkspaceLogger` wraps it and also persists events to the workspace
 * run log (logs/grandma-kat.db) so `read_runs` / `logs_review` can recall past
 * turns in the browser. Writes are buffered and flushed as one batched INSERT,
 * because the browser SQLite engine exports the whole DB on every mutation.
 * The batched write shares log-store's serial queue and open connection with
 * the session markers, so the two never lose each other's rows.
 */
import type { Platform } from "../../../src/platform/types";
import { appendEvents } from "./log-store";

export interface KatEvent {
  run_id?: string;
  definition_id?: string;
  branch_path?: string | null;
  iteration?: number;
  scope_id?: number | null;
  kind: string;
  content?: unknown;
  seq?: number;
}

export interface MemoryLogger {
  log(event: KatEvent): number;
  saveCheckpoint(id: string, runId: string, seq: number, resumePositions: unknown): void;
  getCheckpoint(id: string): unknown;
  deleteCheckpoint(id: string): void;
  getEvents(runId: string): KatEvent[];
  close(): void;
  readonly events: KatEvent[];
}

export interface WorkspaceLogger extends MemoryLogger {
  /** Persist buffered events to logs/grandma-kat.db now. */
  flush(): Promise<void>;
}

export function createMemoryLogger(onEvent?: (event: KatEvent) => void): MemoryLogger {
  let seq = 0;
  const events: KatEvent[] = [];
  const checkpoints = new Map<string, unknown>();

  return {
    log(event) {
      const row = { ...event, seq: ++seq };
      events.push(row);
      onEvent?.(row);
      return seq;
    },
    saveCheckpoint(id, runId, atSeq, resumePositions) {
      checkpoints.set(id, {
        id,
        run_id: runId,
        seq: atSeq,
        resume_positions: JSON.stringify(resumePositions),
      });
    },
    getCheckpoint(id) {
      return checkpoints.get(id) ?? null;
    },
    deleteCheckpoint(id) {
      checkpoints.delete(id);
    },
    getEvents(runId) {
      return events.filter((e) => e.run_id === runId);
    },
    close() {},
    get events() {
      return events;
    },
  };
}

// Mirrors grandma-kat's SqliteLogger schema (src/logger.mjs CREATE_TABLES).
// log-store owns the DDL now; the logger and the session markers share it.

/**
 * In-memory + persistent logger for the browser agent worker. The in-memory
 * half stays synchronous (knit needs it); the DB half buffers events and
 * flushes them in one batched INSERT, so a long run costs one DB export per
 * flush rather than one per event.
 */
export function createWorkspaceLogger(
  platform: Platform,
  onEvent?: (event: KatEvent) => void,
): WorkspaceLogger {
  const mem = createMemoryLogger(onEvent);
  let pending: KatEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const write = (batch: KatEvent[]): void => {
    if (!batch.length) return;
    chain = chain
      .then(() => appendEvents(platform, batch))
      .catch(() => {
        /* best-effort: a failed log write must never break a run */
      });
  };

  return {
    ...mem,
    get events() {
      return mem.events;
    },
    log(event) {
      const seq = mem.log(event);
      pending.push(event);
      if (!timer) timer = setTimeout(() => void flush(), 150);
      return seq;
    },
    flush,
  };

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = pending;
    pending = [];
    write(batch);
    await chain;
  }
}
