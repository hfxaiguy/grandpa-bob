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
  /** Run-log row, used to fetch the raw event on demand. */
  seq?: number;
  app?: string;
}

export interface EmitButton {
  label: string;
  value: string;
}

export interface Turn {
  turnId: string;
  input: string;
  /** The app the input was replying to (paused app), so the user's bubble
   *  lands on the right tile. */
  inputApp?: string | null;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "done" | "error" | "stopped";
  error: string | null;
  output: string | null;
  /** The engine run this turn belongs to; null/absent when the turn never ran
   *  (or predates run attribution). */
  runId?: string | null;
  emits?: string[] | null;
  levels?: (string | null)[] | null;
  emitApps?: (string | null)[] | null;
  awaiting?: string | null;
  buttons?: EmitButton[] | null;
  /** Model slots offered after a quota wall (402); a tap retargets the failed
   *  role and re-runs the turn (POST /api/fallback). */
  fallback?: EmitButton[] | null;
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

/** An inspected `ref://` target (mirrors src/provenance.ts RefTarget). */
export interface RefTarget {
  seq: number;
  kind: string;
  runId: string;
  when: string;
  branchPath: string;
  child: string | null;
  op: string | null;
  path: string | null;
  value: string;
  chars: number;
  truncated: boolean;
}

// ── message provenance ("what was this written from") ───────────────────
// Mirrors src/provenance.ts (the /api/provenance payload).

export interface ProvWriter {
  seq: number;
  kind: string;
  runId: string;
  when: string;
  branchPath: string;
  child: string | null;
  op: string | null;
  text: string;
  chars: number;
  truncated: boolean;
}

export interface ProvPiece {
  name: string;
  scope: number | null;
  scopePath: string | null;
  resolved: "read-link" | "latest-write" | "human" | "host-seed";
  writer: ProvWriter | null;
  /** The writer's own reads — present once the walk is deeper (trace deeper). */
  reads?: ProvPiece[];
}

export interface ProvPromptMessage {
  role: string;
  chars: number;
  truncated: boolean;
  content: string;
}

export interface ProvPrompt {
  seq: number;
  child: string;
  model: string | null;
  round: number | null;
  scopeId: number | null;
  branchPath: string;
  when: string;
  rounds: { seq: number; round: number | null; model: string | null }[];
  messages: ProvPromptMessage[];
  messageCount: number;
  messageChars: number;
}

export interface ProvRef {
  seq: number;
  kind: string;
  child: string | null;
  text: string;
}

export interface Provenance {
  emit: {
    seq: number;
    runId: string;
    when: string;
    child: string | null;
    branchPath: string;
    text: string;
  };
  match: "text" | "nearest" | "none";
  prompt: ProvPrompt | null;
  pieces: ProvPiece[];
  leaves: ProvWriter[];
  refs: ProvRef[];
  depth: number;
  maxDepth: number;
  truncated: boolean;
  /** Echoed turn/bubble the walk was anchored on. */
  turnId: string;
  bubble: number;
  emitCount: number;
}
