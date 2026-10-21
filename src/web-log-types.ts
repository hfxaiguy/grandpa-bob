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
