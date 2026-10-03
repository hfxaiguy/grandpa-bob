/**
 * In-browser implementation of the admin UI's /api surface.
 *
 * The shared UI (src/ui/pages.ts) was written against admin.ts's HTTP API. In
 * the browser target there is no server, so this maps those same requests onto
 * the AgentClient + Platform. Run it behind the fetch/EventSource shim
 * (./shim) so the exact Node UI runs unchanged.
 *
 * Endpoints with no browser equivalent (restart-bot, telegram, transcribe,
 * sync, log, env) return a 501 with a clear message; the UI degrades.
 */
import type { AgentClient } from "../agent/agent-client";
import type { Platform } from "../../../src/platform/types";
import { listTreeSources } from "../../../src/tree-sources";

export interface BackendResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

export interface BackendOptions {
  agent: AgentClient;
  platform: Platform;
  storage: "browser" | "desktop";
  server: string;
  env: Record<string, string>;
  remote: string;
  initialPattern: string;
}

interface TurnRecord {
  turnId: string;
  input: string;
  events: unknown[];
  status: string;
  error: string | null;
  output: string;
  buttons: unknown[];
  emits: unknown[];
}

type EventMessage = Record<string, unknown>;

export interface LocalBackend {
  ready: Promise<void>;
  request(method: string, pathname: string, search: URLSearchParams, body: string | null): Promise<BackendResponse>;
  subscribe(cb: (msg: EventMessage) => void): () => void;
}

const UNAVAILABLE = (what: string): BackendResponse => ({
  status: 501,
  body: { error: `${what} is not available in browser mode` },
});

export function createLocalBackend(opts: BackendOptions): LocalBackend {
  const { agent, platform } = opts;
  const sessionKey = "web:local";
  const turns: TurnRecord[] = [];
  const subscribers = new Set<(msg: EventMessage) => void>();
  let activePattern = opts.initialPattern || "trunk";
  let updatedAt = Date.now();

  const broadcast = (msg: EventMessage): void => {
    for (const cb of subscribers) {
      try {
        cb(msg);
      } catch {
        /* subscriber gone */
      }
    }
  };

  async function runTurn(turnId: string, text: string): Promise<void> {
    const record: TurnRecord = {
      turnId,
      input: text,
      events: [],
      status: "running",
      error: null,
      output: "",
      buttons: [],
      emits: [],
    };
    turns.push(record);
    if (turns.length > 20) turns.shift();
    updatedAt = Date.now();
    broadcast({ type: "turn_start", turnId, input: text });
    try {
      const { result, emits } = await agent.run(
        {
          task: text,
          env: opts.env,
          pattern: activePattern,
          remote: opts.remote,
          storage: opts.storage,
          server: opts.server,
        },
        {
          onEvent: (event) => {
            record.events.push(event);
            broadcast({ type: "event", turnId, event });
          },
          onEmit: (value) => {
            record.emits.push(value);
            broadcast({ type: "emit", turnId, text: typeof value === "string" ? value : JSON.stringify(value), buttons: [] });
          },
        },
      );
      record.status = "done";
      const last = emits.length ? emits[emits.length - 1] : result;
      record.output = typeof last === "string" ? last : JSON.stringify(last);
      broadcast({ type: "turn_end", turnId, status: "done", error: null, output: record.output, buttons: [], emits });
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      broadcast({ type: "turn_end", turnId, status: "error", error: record.error, output: "", buttons: [], emits: [] });
    }
  }

  async function patternCatalog(): Promise<BackendResponse> {
    try {
      const sources = await listTreeSources(platform.workspaceRoot);
      const patterns = sources.map((s) => ({ name: s.name, group: s.group, description: s.description, draft: s.draft }));
      const names = patterns.map((p) => p.name);
      const current = names.includes(activePattern) ? activePattern : names[0] ?? activePattern;
      activePattern = current;
      return { status: 200, body: { current, pattern: current, patterns, ref: "prod", refs: ["prod", "draft"] } };
    } catch {
      return { status: 200, body: { current: activePattern, pattern: activePattern, patterns: [], ref: "prod", refs: [] } };
    }
  }

  async function request(
    method: string,
    pathname: string,
    search: URLSearchParams,
    body: string | null,
  ): Promise<BackendResponse> {
    // ── chat ──────────────────────────────────────────────────────────────
    if (pathname === "/api/session" && method === "GET") {
      return {
        status: 200,
        body: { sessions: [{ key: sessionKey, updatedAt, active: true }], active: sessionKey, follow: false },
      };
    }
    if (pathname === "/api/session" && method === "POST") {
      return { status: 200, body: { ok: true, active: sessionKey } };
    }
    if (pathname === "/api/turns" && method === "GET") {
      return { status: 200, body: { turns } };
    }
    if (pathname === "/api/chat" && method === "POST") {
      const text = (JSON.parse(body || "{}") as { text?: string }).text ?? "";
      const turnId = crypto.randomUUID();
      void runTurn(turnId, text);
      return { status: 200, body: { turnId, queued: false } };
    }
    if (pathname === "/api/clear" && method === "POST") {
      turns.length = 0;
      broadcast({ type: "cleared" });
      return { status: 200, body: { ok: true } };
    }
    if (pathname === "/api/status" && method === "GET") {
      return {
        status: 200,
        body: {
          telegram: "n/a",
          voice: "not configured",
          llm: "n/a",
          uptime: Math.round(performance.now() / 1000),
          pid: null,
          workspace: platform.workspaceRoot,
          storage: opts.storage,
        },
      };
    }
    // ── pattern / tree ────────────────────────────────────────────────────
    if (pathname === "/api/pattern" && method === "GET") return patternCatalog();
    if (pathname === "/api/pattern" && method === "POST") {
      const want = (JSON.parse(body || "{}") as { name?: string }).name;
      if (want) activePattern = want;
      return { status: 200, body: { pattern: activePattern } };
    }
    if (pathname === "/api/tree/memory") return { status: 200, body: { values: {} } };
    if (pathname === "/api/patterns" && method === "GET") {
      const cat = await patternCatalog();
      return { status: 200, body: (cat.body as { patterns?: unknown }).patterns ?? [] };
    }
    // ── settings pages: safe empty defaults ───────────────────────────────
    if (pathname === "/api/files" && method === "GET") return { status: 200, body: { entries: [] } };
    if (pathname === "/api/secrets" && method === "GET") return { status: 200, body: { secrets: [] } };
    if (pathname.startsWith("/api/")) return UNAVAILABLE(pathname);
    return { status: 404, body: { error: "not found" } };
  }

  const ready = Promise.resolve();

  return {
    ready,
    request,
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
  };
}
