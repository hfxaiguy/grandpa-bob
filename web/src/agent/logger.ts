/**
 * In-memory grandma-kat logger.
 *
 * Implements the contract knit() needs: { log, saveCheckpoint, getCheckpoint,
 * deleteCheckpoint, getEvents, close }. Events and checkpoints live in memory;
 * this runs inside the agent worker. (Durable log/checkpoint storage via the
 * browser SQLite engine is a follow-up.) `onEvent` lets the worker stream each
 * event to the UI.
 */
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
