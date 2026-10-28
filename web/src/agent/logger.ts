/**
 * Browser grandma-kat loggers — a thin adapter over the engine's portable log
 * store (`createSessionLogStore` in grandma-kat).
 *
 * The engine logs and reads rows synchronously (refs are row addresses; a
 * resume replays the run's events in the same tick), while the browser's
 * SQLite handle is an async worker proxy. The store therefore keeps the rows
 * in an in-memory replica — complete by construction: `log()` appends before
 * it returns a seq, and checkpoints are shadowed only after the call rows they
 * depend on — and flushes the shadow in batches through log-store's serial
 * queue. After a reload a fresh worker calls `restore()` to hydrate the
 * replica from the same run log before deciding knit-vs-resume.
 */
import type { Platform } from "../platform/types";
import {
  createSessionLogStore,
  type SessionLogCheckpoint,
  type SessionLogStore,
} from "grandma-kat";
import {
  appendEvents,
  deleteCheckpointRow,
  ensureLogCursor,
  loadCheckpointRow,
  loadRunEvents,
  nextLogSeq,
  saveCheckpointRow,
} from "./log-store";

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
  /** Persist buffered events and checkpoint shadows now. */
  flush(): Promise<void>;
  /**
   * Rebuild the in-memory replica from the run log (a cold worker after a
   * reload): loads the paused run's rows and the checkpoint, validates that
   * the pause row is present, then leaves the engine's `resume()` synchronous.
   */
  restore(
    checkpoint: string | SessionLogCheckpoint,
  ): Promise<{ ok: true; events: number } | { ok: false; reason: string }>;
}

/** What the engine logs (plus the seq the store assigns) in the store's terms. */
type EngineLogEvent = Parameters<SessionLogStore["log"]>[0];

/** An in-memory logger for tests and throwaway runs (nothing is persisted). */
export function createMemoryLogger(
  onEvent?: (event: KatEvent) => void,
  allocSeq?: () => number,
): MemoryLogger {
  const store = createSessionLogStore({
    driver: {
      appendCalls() {},
      upsertCheckpoint() {},
      deleteCheckpointRow() {},
    },
    allocateSeq: allocSeq,
    onEvent: (row) => onEvent?.(row as unknown as KatEvent),
    onError: () => {},
    flushDelayMs: 0,
  });
  return {
    log: (event) => store.log(event as EngineLogEvent),
    readRow: (seq) => store.readRow(seq) as KatEvent | null,
    saveCheckpoint: (id, runId, seq, resumePositions) =>
      store.saveCheckpoint(id, runId, seq, resumePositions),
    getCheckpoint: (id) => store.getCheckpoint(id),
    deleteCheckpoint: (id) => store.deleteCheckpoint(id),
    getEvents: (runId) => store.getEvents(runId) as KatEvent[],
    close: () => store.close(),
    get events() {
      return store.events as KatEvent[];
    },
  };
}

/**
 * The workspace logger: the engine contract over the OPFS run log. Call
 * `await logger.ready` before the first `log()` (the seq cursor must be seeded
 * from the database so refs address the rows on disk).
 */
export function createWorkspaceLogger(
  platform: Platform,
  onEvent?: (event: KatEvent) => void,
): WorkspaceLogger {
  const ready = ensureLogCursor(platform).catch(() => {});
  const store = createSessionLogStore({
    driver: {
      appendCalls: (rows) => appendEvents(platform, rows as unknown as KatEvent[]),
      upsertCheckpoint: (row) => saveCheckpointRow(platform, row),
      deleteCheckpointRow: (id) => deleteCheckpointRow(platform, id),
      getCheckpoint: (id) => loadCheckpointRow(platform, id),
      getEvents: (runId, opts) => loadRunEvents(platform, runId, opts?.upToSeq),
    },
    allocateSeq: () => nextLogSeq(platform),
    onEvent: (row) => onEvent?.(row as unknown as KatEvent),
    onError: (err) =>
      console.warn(`[runlog] write failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  return {
    ready,
    log: (event) => store.log(event as EngineLogEvent),
    readRow: (seq) => store.readRow(seq) as KatEvent | null,
    saveCheckpoint: (id, runId, seq, resumePositions) =>
      store.saveCheckpoint(id, runId, seq, resumePositions),
    getCheckpoint: (id) => store.getCheckpoint(id),
    deleteCheckpoint: (id) => store.deleteCheckpoint(id),
    getEvents: (runId) => store.getEvents(runId) as KatEvent[],
    flush: () => store.flush(),
    restore: async (checkpoint) => {
      const result = await store.restore(checkpoint);
      return result.ok
        ? { ok: true as const, events: result.events }
        : { ok: false as const, reason: result.reason };
    },
    close: () => store.close(),
    get events() {
      return store.events as KatEvent[];
    },
  };
}
