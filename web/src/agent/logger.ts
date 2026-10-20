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
import { appendEvents, ensureLogCursor, nextLogSeq } from "./log-store";

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
  /**
   * One row by seq — the store `ref://` handles resolve against. Its presence
   * is what makes knit mint and resolve refs (see refs.mjs `refsResolvable`).
   */
  readRow(seq: number): KatEvent | null;
  saveCheckpoint(id: string, runId: string, seq: number, resumePositions: unknown): void;
  getCheckpoint(id: string): unknown;
  deleteCheckpoint(id: string): void;
  getEvents(runId: string): KatEvent[];
  close(): void;
  readonly events: KatEvent[];
}

export interface WorkspaceLogger extends MemoryLogger {
  /** Resolves once the DB seq cursor is seeded (await before the first log). */
  readonly ready: Promise<void>;
  /** Persist buffered events to logs/grandma-kat.db now. */
  flush(): Promise<void>;
}

export function createMemoryLogger(
  onEvent?: (event: KatEvent) => void,
  allocSeq?: () => number,
): MemoryLogger {
  let seq = 0;
  const events: KatEvent[] = [];
  const checkpoints = new Map<string, unknown>();

  return {
    log(event) {
      const row = { ...event, seq: allocSeq ? allocSeq() : ++seq };
      events.push(row);
      onEvent?.(row);
      return row.seq ?? 0;
    },
    readRow(at) {
      return events.find((e) => e.seq === at) ?? null;
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
  // The seq the engine logs must be the row's seq on disk: refs are addresses.
  // A failed seed falls back to 0; the flush re-keys from the DB's MAX(seq).
  const ready = ensureLogCursor(platform).catch(() => {});
  const mem = createMemoryLogger(onEvent, () => nextLogSeq(platform));
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
    ready,
    get events() {
      return mem.events;
    },
    log(event) {
      const seq = mem.log(event);
      // Queue the row (with its seq), not the raw event: the flush writes the
      // exact seq the engine just consumed.
      const row = mem.events[mem.events.length - 1];
      if (row) pending.push(row);
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
