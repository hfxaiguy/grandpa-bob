/**
 * Type-only definitions for the web UI's session log.
 *
 * Split from `web-log.ts` so the browser target can import them without
 * pulling in that module's `node:sqlite` / `node:fs` implementation (which the
 * web tsconfig maps to browser stubs and cannot type-check).
 */
import type { SanitizedEvent } from "./sanitize.js";
import type { EmitButton } from "./util/emit-text.js";

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
  status: "done" | "error";
  error?: string | null;
  output?: string | null;
  emits?: string[] | null;
  levels?: (string | null)[] | null;
  emitApps?: (string | null)[] | null;
  buttons?: EmitButton[] | null;
  fallback?: EmitButton[] | null;
  awaiting?: string | null;
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
  status: "done" | "error";
  error: string | null;
  output: string | null;
  emits?: string[] | null;
  levels?: (string | null)[] | null;
  emitApps?: (string | null)[] | null;
  buttons?: EmitButton[] | null;
  fallback?: EmitButton[] | null;
  awaiting?: string | null;
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
