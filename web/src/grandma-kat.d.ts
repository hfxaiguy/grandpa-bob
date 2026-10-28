// grandma-kat ships no type declarations; declare the surface the browser demo uses.
declare module "grandma-kat" {
  export type KnitResult = { result: unknown; memory: Record<string, unknown> };
  export function knit(pattern: unknown, runtime: unknown): Promise<KnitResult>;
  export function resume(continuation: string, runtime: unknown): Promise<KnitResult>;
  export function Tree(...args: unknown[]): unknown;
  export function From(...args: unknown[]): unknown;
  export function name(...args: unknown[]): unknown;
  export function Model(...args: unknown[]): unknown;
  export function Tools(...args: unknown[]): unknown;
  export function Needs(...args: unknown[]): unknown;
  export function Prompt(...args: unknown[]): unknown;
  export function Memory(...args: unknown[]): unknown;
  export function Register(...args: unknown[]): unknown;
  export function Branch(...args: unknown[]): unknown;
  export function Call(...args: unknown[]): unknown;
  export function Check(...args: unknown[]): unknown;
  export function Return(...args: unknown[]): unknown;
  export interface RunLogTool {
    name: string;
    description: string;
    parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
    execute(args: Record<string, unknown>): Promise<unknown>;
  }
  export interface InspectMemoryTool {
    name: string;
    description: string;
    parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
    execute(args: Record<string, unknown>, ctx?: Record<string, unknown>): unknown;
  }
  export function inspectMemoryTool(opts?: { sample?: number; maxChars?: number }): InspectMemoryTool;
  export function runLogToolFromQuery(
    query: (sql: string, params?: unknown[]) => Promise<unknown[]> | unknown[],
    opts?: { defaultLimit?: number },
  ): RunLogTool;
  // --- portable session log store (src/logstore.mjs) --------------------
  /** The engine's calls + checkpoints DDL; drivers add their own indexes. */
  export const LOG_TABLES: string;
  export interface SessionLogRow {
    seq: number;
    run_id: string;
    definition_id?: string;
    branch_path?: string | null;
    iteration?: number | null;
    scope_id?: number | null;
    kind: string;
    content: unknown;
  }
  export interface SessionLogCheckpoint {
    id: string;
    run_id: string;
    seq: number;
    resume_positions: string;
  }
  export interface SessionLogDriver {
    appendCalls(rows: readonly SessionLogRow[]): Promise<void> | void;
    upsertCheckpoint(row: SessionLogCheckpoint): Promise<void> | void;
    deleteCheckpointRow?(id: string): Promise<void> | void;
    getCheckpoint?(id: string): Promise<SessionLogCheckpoint | null> | SessionLogCheckpoint | null;
    getEvents?(
      runId: string,
      opts?: { upToSeq?: number },
    ): Promise<readonly SessionLogRow[]> | readonly SessionLogRow[];
    headSeq?(): Promise<number> | number;
    startRun?(runId: string, sessionId?: string | null): Promise<void> | void;
  }
  export type SessionLogRestore =
    | { ok: true; checkpoint: SessionLogCheckpoint; events: number }
    | { ok: false; reason: string };
  export interface SessionLogStore {
    ready: Promise<void>;
    log(event: Omit<SessionLogRow, "seq"> & { seq?: number }): number;
    readRow(seq: number): SessionLogRow | null;
    saveCheckpoint(
      id: string,
      runId: string,
      seq: number,
      resumePositions: unknown,
    ): void;
    getCheckpoint(id: string): SessionLogCheckpoint | null;
    deleteCheckpoint(id: string): void;
    getEvents(runId: string): SessionLogRow[];
    startRun(runId: string, sessionId?: string | null): void;
    flush(): Promise<void>;
    restore(checkpoint: string | SessionLogCheckpoint): Promise<SessionLogRestore>;
    close(): void;
    readonly events: SessionLogRow[];
  }
  export function createSessionLogStore(options: {
    driver: SessionLogDriver;
    allocateSeq?: () => number;
    onEvent?: (row: SessionLogRow) => void;
    onError?: (err: unknown) => void;
    flushDelayMs?: number;
  }): SessionLogStore;
  export const grandma: { knit: typeof knit; resume: typeof resume };
  const _default: { knit: typeof knit; resume: typeof resume };
  export default _default;
}
