/**
 * Main-thread client for the agent worker. Mirrors the Node target's
 * request/stream split: `run()` resolves with the final result and collects
 * streamed events and emits.
 */
import { AgentStoppedError } from "../stop-error";
import { encodeOpfsPrefix } from "../platform/opfs-root";

export interface AgentRunResult {
  result: unknown;
  events: unknown[];
  emits: unknown[];
  /** How the turn entered its tree (see the worker's RunMode). */
  mode?: "resumed" | "restored" | "fresh";
}

/** A run promise that knows its message id (the turn marker targets it). */
export interface AgentRunPromise extends Promise<AgentRunResult> {
  runId: number;
}

/** Context for session-log calls (the worker owns the platform). */
export interface AgentLogContext {
  // Kept as an object so future context fields do not change every call site.
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
  mode?: "resumed" | "restored" | "fresh";
}

export class AgentClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private logPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private opsPort: MessagePort | null = null;
  private opsHandler: ((command: string, args: string[]) => Promise<string>) | null = null;
  private opsConfig: { enabled: boolean; allow: string[] } = { enabled: false, allow: [] };
  private probePending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();

  constructor(opfsPrefix: readonly string[] = []) {
    this.worker = new Worker(new URL("./agent-worker.ts", import.meta.url), {
      type: "module",
      name: encodeOpfsPrefix(opfsPrefix),
    });
    // A dedicated port carries desktop/server ops out of the worker (the RTC
    // datachannel lives on the main thread).
    const channel = new MessageChannel();
    this.opsPort = channel.port1;
    channel.port1.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; id?: string; command?: string; args?: string[] };
      if (msg.type !== "ops-request" || !msg.id) return;
      void (async () => {
        try {
          if (!this.opsHandler) throw new Error("no desktop/server is connected");
          const output = await this.opsHandler(String(msg.command ?? ""), Array.isArray(msg.args) ? msg.args.map(String) : []);
          channel.port1.postMessage({ type: "ops-result", id: msg.id, output });
        } catch (err) {
          channel.port1.postMessage({
            type: "ops-result",
            id: msg.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    };
    this.worker.postMessage({ type: "ops-port", port: channel.port2 }, [channel.port2]);
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
        mode?: "resumed" | "restored" | "fresh";
      };
      if (msg.type === "ops-probe-result") {
        const probe = this.probePending.get(msg.id);
        if (!probe) return;
        this.probePending.delete(msg.id);
        if (typeof msg.result === "string") probe.resolve(msg.result);
        else probe.reject(new Error(String(msg.error ?? "ops probe failed")));
        return;
      }
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
        p.resolve({ result: msg.result, events: p.events, emits: p.emits, mode: msg.mode });
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

  /** Route allowlisted shell commands to the connected desktop/server. */
  setOpsHandler(handler: ((command: string, args: string[]) => Promise<string>) | null): void {
    this.opsHandler = handler;
  }

  /** Tell the worker which commands should go to the desktop. */
  setOpsConfig(config: { enabled: boolean; allow: string[] }): void {
    this.opsConfig = { enabled: !!config.enabled, allow: [...config.allow] };
    this.worker.postMessage({ type: "ops-config", ...this.opsConfig });
  }

  /** Test hook: exercise the worker's desktop-op routing directly. */
  probeOps(command: string, args: string[] = []): Promise<string> {
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.probePending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type: "ops-probe", command, args });
      setTimeout(() => {
        if (!this.probePending.delete(id)) return;
        reject(new Error("ops probe timed out"));
      }, 30_000);
    });
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
