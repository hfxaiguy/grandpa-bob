/**
 * Main-thread client for the agent worker. Mirrors the Node target's
 * request/stream split: `run()` resolves with the final result and collects the
 * streamed events.
 */
export interface AgentRunResult {
  result: unknown;
  events: unknown[];
}

interface Pending {
  resolve: (value: AgentRunResult) => void;
  reject: (error: Error) => void;
  events: unknown[];
}

export class AgentClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("./agent-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { id: number; type: string; result?: unknown; event?: unknown; error?: string };
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === "event") p.events.push(msg.event);
      else if (msg.type === "result") {
        this.pending.delete(msg.id);
        p.resolve({ result: msg.result, events: p.events });
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

  run(task = "", env: Record<string, string> = {}): Promise<AgentRunResult> {
    const id = this.nextId++;
    return new Promise<AgentRunResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, events: [] });
      this.worker.postMessage({ id, type: "run", task, env });
    });
  }

  close(): void {
    this.worker.terminate();
  }
}
