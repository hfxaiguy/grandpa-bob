/** Shapes mirrored from src/admin.ts (the /api/* payloads). */

export interface AppInfo {
  name: string;
  description: string;
  group?: string;
  guide?: string;
}

export interface SanitizedEvent {
  kind: string;
  branch_path: string;
  iteration: number;
  scope_id: number | null;
  content: Record<string, unknown> | null;
  ts: number;
  app?: string;
}

export interface EmitButton {
  label: string;
  value: string;
}

export interface Turn {
  turnId: string;
  input: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "done" | "error";
  error: string | null;
  output: string | null;
  emits?: string[] | null;
  levels?: (string | null)[] | null;
  emitApps?: (string | null)[] | null;
  awaiting?: string | null;
  buttons?: EmitButton[] | null;
  events: SanitizedEvent[];
}

export interface SessionInfo {
  key: string;
  label: string;
  pattern: string;
  updatedAt: number;
  turns: number;
  remote: boolean;
  ref?: string;
  awaiting?: string | null;
}

export interface Slot {
  name: string;
  model: string;
  baseURL: string;
}

export interface PatternInfo {
  name: string;
  description: string;
  guide?: string;
  group?: string;
}

/** A row in the global event stream (derived from turns + emits). */
export interface StreamLine {
  ts: number;
  app: string;
  kind: string;
  text: string;
  /** Chat emit vs engine step — styled differently. */
  emit: boolean;
}
