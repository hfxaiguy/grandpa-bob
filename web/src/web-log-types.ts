/**
 * Type-only definitions for the web UI's session log.
 *
 * Split from `web-log.ts` so the browser target can import them without
 * pulling in that module's `node:sqlite` / `node:fs` implementation (which the
 * web tsconfig maps to browser stubs and cannot type-check).
 */
import type { SanitizedEvent } from "./sanitize.js";
import type { EmitButton } from "./util/emit-text.js";

/** Per-turn model token accounting, summed over the turn's `llm_call` events. */
export interface TurnTokens {
  /** Prompt tokens (the full prompt is billed on every round). */
  input: number;
  /** Completion tokens. */
  output: number;
  /** How many model calls contributed (one per prompt round). */
  calls: number;
}

export interface TurnMarker {
  key: string;
  turnId: string;
  /** The engine run this turn belongs to; null when the engine never ran. */
  runId: string | null;
  /** Event seq bounds: the turn's events are (fromSeq, toSeq]. */
  fromSeq: number | null;
  toSeq: number | null;
  input: string;
  inputApp?: string | null;
  status: "done" | "error" | "stopped";
  error?: string | null;
  output?: string | null;
  emits?: string[] | null;
  levels?: (string | null)[] | null;
  emitApps?: (string | null)[] | null;
  buttons?: EmitButton[] | null;
  fallback?: EmitButton[] | null;
  awaiting?: string | null;
  /** How the turn entered its tree: continued the in-memory checkpoint,
   *  restored a paused run from the run log after a reload, or knitted fresh.
   *  Absent on turns from before the field. */
  runMode?: "resumed" | "restored" | "fresh";
  /** A fresh run although the previous turn paused (its context was lost —
   *  the reload case). Absent when the question does not apply. */
  contextLost?: boolean;
  /** Model tokens the turn used; absent on turns from before metering, or
   *  when the endpoint reported no usage. */
  tokens?: TurnTokens | null;
  startedAt: number;
  endedAt: number | null;
  ts: number;
}

export interface DerivedTurn {
  turnId: string;
  runId: string | null;
  input: string;
  inputApp?: string | null;
  startedAt: number;
  endedAt: number | null;
  status: "done" | "error" | "stopped";
  error: string | null;
  output: string | null;
  emits?: string[] | null;
  levels?: (string | null)[] | null;
  emitApps?: (string | null)[] | null;
  buttons?: EmitButton[] | null;
  fallback?: EmitButton[] | null;
  awaiting?: string | null;
  runMode?: "resumed" | "restored" | "fresh";
  contextLost?: boolean;
  tokens?: TurnTokens | null;
  events: SanitizedEvent[];
}

export interface StoredSession {
  key: string;
  label: string;
  pattern: string;
  updatedAt: number;
  turns: number;
  remote: false;
  awaiting?: string | null;
}

/** Conversation state that is not derivable from the engine's own trace
 *  (resume hash, model overrides, edit-detection signatures).
 *  Written as a host marker row into the log DB, latest per key wins;
 *  `clearedAt` tombstones everything before it. Defined here so the Node
 *  agent/log and any future browser writer cannot drift on the string. */
export const MARKER_SESSION_META = "web_session_meta";

export interface SessionMeta {
  /** The conversation key — any transport. */
  key: string;
  ts: number;
  /** The root pattern's resume hash at the pause; null clears it. */
  pattern?: string | null;
  /** Per-role model overrides ({ strong: "slot" }). Present replaces the map;
   *  absent or empty clears it. */
  models?: Record<string, string>;
  /** The paused stack's branch_path + subtree signature; null clears. */
  treePath?: string | null;
  subtreeHash?: string | null;
  /** Written by an explicit clear(): restore must not resurrect state, or a
   *  continuation from a run, that predates it. */
  clearedAt?: number;
}

/** Conversation-bound session state restored at boot. Continuations derive
 *  from the engine's own `runs` + `checkpoints` rows; the rest from
 *  `MARKER_SESSION_META` markers. */
export interface SessionState {
  continuations: Map<string, string>;
  patterns: Map<string, string>;
  times: Map<string, number>;
  treePaths: Map<string, string>;
  subtreeHashes: Map<string, string>;
  models: Map<string, Record<string, string>>;
}

/** The store the Node agent restores/persists its conversation state through
 *  (`WebLog` implements it over the log DB). */
export interface SessionStateStore {
  restoreSessions(): SessionState;
  writeSessionMeta(meta: SessionMeta): void;
}
