/**
 * Keep a stopped turn's committed state in the session checkpoint.
 *
 * A resume rebuilds memory from the run log only up to the checkpoint's pause
 * row. A stop unwinds the tree without pausing, so the session keeps its
 * PREVIOUS checkpoint and everything the stopped turn committed after it — the
 * user's message folded into `conversation`, an app's partial slot writes —
 * disappears on the next resume. That is what made the last message read as
 * "dropped from the conversation slot" after Stop.
 *
 * Freeze the stop point instead. Log a synthetic pause at the run's newest row,
 * reusing the old pause's human slot and resume positions, then make that the
 * session continuation. The next resume replays everything the stopped turn
 * logged (exactly as it replays a normal pause) and delivers the new message to
 * the SAME slot. No slot names or tree shapes are assumed.
 *
 * A stop that landed before the run committed anything after the pause (it was
 * still setting up, or the delivery had not happened yet) leaves the old
 * checkpoint alone: there is no state to preserve, and a second pause row would
 * only complicate the continuation.
 */

export interface StoppedCheckpointLogger {
  getCheckpoint(id: string): unknown;
  getEvents(runId: string): readonly StopCheckpointEvent[];
  log(event: StopCheckpointEvent): number;
  saveCheckpoint(id: string, runId: string, seq: number, resumePositions: unknown): void;
  deleteCheckpoint(id: string): void;
  flush(): Promise<void>;
}

export interface StopCheckpointEvent {
  run_id?: string;
  definition_id?: string;
  branch_path?: string | null;
  iteration?: number;
  scope_id?: number | null;
  kind: string;
  content?: unknown;
  seq?: number;
}

interface CheckpointRow {
  id: string;
  run_id: string;
  seq: number;
  resume_positions: unknown;
}

interface HumanContent {
  child?: unknown;
}

/**
 * Replace `continuation` with a checkpoint at the newest logged row.
 *
 * Returns the new checkpoint id, or null when the turn committed nothing after
 * the pause (nothing was lost) or the old pause can no longer be read. Call
 * only after the run has unwound: the synthetic pause is logged directly, past
 * the stop-signalled engine logger.
 */
export function freezeStoppedCheckpoint(
  logger: StoppedCheckpointLogger,
  continuation: string | null | undefined,
): string | null {
  if (!continuation) return null;
  const cp = logger.getCheckpoint(continuation) as CheckpointRow | null;
  if (!cp || typeof cp.run_id !== "string" || !Number.isFinite(Number(cp.seq))) return null;

  const events = logger.getEvents(cp.run_id);
  const pause = events.find((ev) => ev.seq === cp.seq && ev.kind === "human");
  if (!pause) return null;

  const lastSeq = events.reduce((max, ev) => Math.max(max, Number(ev.seq) || 0), 0);
  if (lastSeq <= cp.seq) return null; // the stop landed before anything was committed

  const content = (pause.content ?? {}) as HumanContent;
  const seq = logger.log({
    run_id: cp.run_id,
    definition_id: pause.definition_id ?? "web",
    branch_path: pause.branch_path ?? null,
    iteration: pause.iteration ?? 0,
    scope_id: pause.scope_id ?? null,
    kind: "human",
    content: {
      child: typeof content.child === "string" ? content.child : "main_input",
      // The old pause's buttons are spent; the next reply is a fresh message,
      // not a press on a button that belonged to the stopped turn.
      context: {},
      buttons: [],
    },
  });

  const frozen = `${cp.run_id}:${seq}:stopped`;
  logger.saveCheckpoint(frozen, cp.run_id, seq, cp.resume_positions);
  // The old pause is superseded; leaving it behind would let a later restore
  // resurrect the pre-stop state (the run's checkpoints are not single-use in
  // the DB until the engine consumes them).
  logger.deleteCheckpoint(cp.id);
  void logger.flush();
  return frozen;
}
