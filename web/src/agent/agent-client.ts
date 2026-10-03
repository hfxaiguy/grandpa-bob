/**
 * Main-thread client for the agent worker. Mirrors the Node target's
 * request/stream split: `run()` resolves with the final result and collects
 * streamed events and emits.
 */
export interface AgentRunResult {
  result: unknown;
  events: unknown[];
  emits: unknown[];
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

  constructor() {
    this.worker = new Worker(new URL("./agent-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as {
        id: number;
        type: string;
        result?: unknown;
        event?: unknown;
        value?: unknown;
        error?: string;
      };
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
        p.reject(new Error(msg.error ?? "agent error"));
      }
    };
    this.worker.onerror = (ev) => {
      const err = new Error(`agent worker failed: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  run(opts: AgentRunOptions = {}, hooks?: AgentRunHooks): Promise<AgentRunResult> {
    const id = this.nextId++;
    return new Promise<AgentRunResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, events: [], emits: [], hooks });
      this.worker.postMessage({ id, type: "run", ...opts });
    });
  }

  close(): void {
    this.worker.terminate();
  }
}
