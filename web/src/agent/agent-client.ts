/**
 * Main-thread client for the agent worker. Mirrors the Node target's
 * request/stream split: `run()` resolves with the final result and collects
 * streamed events and emits.
 */
import { AgentStoppedError } from "../../../src/stop-error";
import { encodeOpfsPrefix } from "../platform/opfs-root";

export interface AgentRunResult {
  result: unknown;
  events: unknown[];
  emits: unknown[];
}

/** A run promise that knows its message id (the turn marker targets it). */
export interface AgentRunPromise extends Promise<AgentRunResult> {
  runId: number;
}

/** Context for session-log calls (which storage backend the platform needs). */
export interface AgentLogContext {
  storage?: "browser" | "desktop";
  server?: string;
}

/** Live hooks so a backend can re-emit events as they arrive (SSE). */
export interface AgentRunHooks {
  onEvent?: (event: unknown) => void;
  onEmit?: (value: unknown) => void;
}

export interface AgentRunOptions {
  task?: string;
  env?: Record<string, string>;
  pattern?: string;
  remote?: string;
  storage?: "browser" | "desktop";
  server?: string;
  /** The chat session this run belongs to (per-session continuation state). */
  chatKey?: string;
  /** Model registry JSON from browser settings (takes precedence over models.json). */
  modelsJson?: string;
  /**
   * Served by grandpa-bob's admin: use its models.json and route model calls
   * through /api/llm/<slot>, so the browser uses the same registry as Telegram.
   */
  serverModels?: boolean;
  /** Per-conversation role→slot overrides from the chat model picker. */
  modelOverrides?: Record<string, string>;
  /** Browser-level CDP socket passed by `npm run chrome` (?cdp=…). */
  cdp?: string;
}

interface Pending {
  resolve: (value: AgentRunResult) => void;
  reject: (error: Error) => void;
  events: unknown[];
  emits: unknown[];
  hooks?: AgentRunHooks;
}

export class AgentClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private logPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(opfsPrefix: readonly string[] = []) {
    this.worker = new Worker(new URL("./agent-worker.ts", import.meta.url), {
      type: "module",
      name: encodeOpfsPrefix(opfsPrefix),
    });
    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as {
        id: number;
        type: string;
        result?: unknown;
        event?: unknown;
        value?: unknown;
        error?: string;
        ok?: boolean;
        stopped?: boolean;
      };
      if (msg.type === "log-result") {
        const lp = this.logPending.get(msg.id);
        if (!lp) return;
        this.logPending.delete(msg.id);
        if (msg.ok) lp.resolve(msg.result);
        else lp.reject(new Error(msg.error ?? "session log error"));
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === "event") {
        p.events.push(msg.event);
        p.hooks?.onEvent?.(msg.event);
      } else if (msg.type === "emit") {
        p.emits.push(msg.value);
        p.hooks?.onEmit?.(msg.value);
      } else if (msg.type === "result") {
        this.pending.delete(msg.id);
        p.resolve({ result: msg.result, events: p.events, emits: p.emits });
      } else if (msg.type === "error") {
        this.pending.delete(msg.id);
        p.reject(
          msg.stopped
            ? new AgentStoppedError(msg.error)
            : new Error(msg.error ?? "agent error"),
        );
      }
    };
    this.worker.onerror = (ev) => {
      const err = new Error(`agent worker failed: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  run(opts: AgentRunOptions = {}, hooks?: AgentRunHooks): AgentRunPromise {
    const id = this.nextId++;
    const promise = new Promise<AgentRunResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, events: [], emits: [], hooks });
      this.worker.postMessage({ id, type: "run", ...opts });
    }) as AgentRunPromise;
    promise.runId = id;
    return promise;
  }

  /**
   * Session-log RPC. The worker owns the platform (and thus the run log), so
   * reads and marker writes share the engine logger's queue and connection.
   */
  log<T = unknown>(
    op: string,
    payload: Record<string, unknown> = {},
    ctx: AgentLogContext = {},
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.logPending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.worker.postMessage({ id, type: "log", op, payload, ...ctx });
    });
  }

  /**
   * Stop the in-flight run. The worker aborts model/tool work and unwinds the
   * tree; the previous checkpoint stays available for the next message.
   */
  stop(runId?: number): void {
    this.worker.postMessage({ type: "stop", id: runId });
  }

  close(): void {
    this.worker.terminate();
  }
}
