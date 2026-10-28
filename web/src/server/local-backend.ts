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
import { listAppTrees, listPatterns, listTreeSources } from "../../../src/tree-sources";
import { resolveTreeEntry } from "../../../src/tree-files";
import { serializeTree } from "../../../src/tree-serialize";
import { newTurnApps, tagEventApp, type TurnApps } from "../../../src/app-attribution";
import { createMemoryTracker, type MemoryWrite } from "../../../src/memory-track";
import { emitValue } from "../../../src/util/emit-text";
import type { TurnTokens } from "../../../src/web-log-types";
import { createModuleLoader } from "../agent/module-loader";
import { patternLabel } from "../agent/pattern-path";
import { loadEnv, saveEnv, saveModelsJson } from "../settings";
import { parseModels, type ModelRegistry } from "../../../src/model-config";
import { refTargetFromRow } from "../../../src/ref-target";
import { applyDatabaseDumps, withSyncLock, writeDatabaseDumps } from "../../../src/db-sync";
import { AgentStoppedError, isAgentStopped } from "../../../src/stop-error";
import type { SessionSummary } from "../agent/log-store";

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
  /** Model registry JSON from browser settings (overrides the workspace models.json). */
  modelsJson?: string;
  /**
   * Served by grandpa-bob's admin: the server's models.json is authoritative,
   * so the models endpoints fall through to it and the chat proxy is used.
   */
  serverModels?: boolean;
  /** Browser-level CDP socket for the browser_* tools (?cdp=…). */
  cdp?: string;
}

interface TurnRecord {
  turnId: string;
  input: string;
  inputApp?: string | null;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "done" | "error" | "stopped";
  error: string | null;
  output: string | null;
  emits: string[];
  levels: (string | null)[];
  emitApps: string[];
  awaiting: string | null;
  buttons: unknown[];
  /** How the turn entered its tree: continued the in-memory checkpoint,
   *  restored a paused run from the log after a reload, or knitted fresh. */
  runMode?: "resumed" | "restored" | "fresh";
  /** A fresh tree although the previous turn paused — the context a reload
   *  should have restored was not available. */
  contextLost?: boolean;
  /** Summed `llm_call` usage for the turn; absent when the endpoint (or a
   *  mock) reported none. */
  tokens?: TurnTokens | null;
  events: { seq?: number; run_id?: string; branch_path?: string | null; kind?: string; app?: string; content?: Record<string, unknown> }[];
}

/** Fold a `llm_call` event's usage into the turn's totals before the event
 *  list is capped (long turns would otherwise lose their early rounds). */
function addTurnTokens(t: TurnRecord, event: { kind?: string; content?: Record<string, unknown> }): void {
  if (event.kind !== "llm_call") return;
  const u = (event.content as { usage?: { input?: unknown; output?: unknown } } | undefined)?.usage;
  if (!u) return;
  const input = Number(u.input);
  const output = Number(u.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return;
  const acc = (t.tokens ??= { input: 0, output: 0, calls: 0 });
  acc.input += input;
  acc.output += output;
  acc.calls += 1;
}

type EventMessage = Record<string, unknown>;

export interface LocalBackend {
  ready: Promise<void>;
  request(method: string, pathname: string, search: URLSearchParams, body: string | FormData | null): Promise<BackendResponse>;
  subscribe(cb: (msg: EventMessage) => void): () => void;
}

const UNAVAILABLE = (what: string): BackendResponse => ({
  status: 501,
  body: { error: `${what} is not available in browser mode` },
});

export function createLocalBackend(opts: BackendOptions): LocalBackend {
  const { agent, platform } = opts;
  /** The active chat session key (`web:<id>`); persisted across reloads. */
  let activeSession: string | null = null;
  let sessionsLoaded = false;
  let sessionsLoad: Promise<void> | null = null;
  /**
   * Turns that ran in this page and whose marker is not on disk yet. Once the
   * marker lands the persisted copy is the source of truth.
   */
  const liveTurns = new Map<string, TurnRecord[]>();
  /** The run currently executing in the worker, by session key. */
  const activeRuns = new Map<string, { turnId: string; runId: number }>();
  /** Resolvers waiting for the active run on a session to finish. */
  const idleWaiters = new Map<string, Array<() => void>>();
  const subscribers = new Set<(msg: EventMessage) => void>();
  let activePattern = opts.initialPattern || "trunk";
  let modelsJson = opts.modelsJson ?? "";
  /** Per-conversation role→slot overrides (the chat model picker). */
  const sessionModels = new Map<string, Record<string, string>>();
  /**
   * Current memory values, per conversation and grouped by the writing app —
   * the same tracker the Node admin uses. It lives in this page, so a reload
   * wipes it; `ensureMemory` rebuilds it from the persisted run log below.
   */
  const memory = createMemoryTracker();

  /**
   * GET a JSON object from the admin, when this page is served by it. XHR is
   * used deliberately: the fetch shim routes `/api/*` back into this backend.
   */
  function adminGet(path: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", path);
        xhr.setRequestHeader("accept", "application/json");
        xhr.onload = () => {
          try {
            const data = JSON.parse(xhr.responseText) as unknown;
            resolve(data && typeof data === "object" ? (data as Record<string, unknown>) : null);
          } catch {
            resolve(null);
          }
        };
        xhr.onerror = () => resolve(null);
        xhr.send();
      } catch {
        resolve(null);
      }
    });
  }

  /** POST JSON to the admin — same XHR bypass of the fetch shim as adminGet. */
  function adminPost(
    path: string,
    body: unknown,
  ): Promise<{ status: number; data: Record<string, unknown> | null }> {
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", path);
        xhr.setRequestHeader("content-type", "application/json");
        xhr.setRequestHeader("accept", "application/json");
        xhr.onload = () => {
          let data: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(xhr.responseText) as unknown;
            if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
          } catch {
            /* non-JSON error body */
          }
          resolve({ status: xhr.status, data });
        };
        xhr.onerror = () => resolve({ status: 0, data: null });
        xhr.send(JSON.stringify(body));
      } catch {
        resolve({ status: 0, data: null });
      }
    });
  }

  /**
   * The registry JSON the browser should use: the Settings JSON when set (it
   * overrides the workspace file), else the workspace's `models.json` for the
   * active storage mode. Without the fallback the chat model picker only ever
   * saw "default" in the browser.
   */
  async function effectiveModelJson(): Promise<string> {
    // Served by the admin: its models.json is authoritative (the settings page
    // is the server's too, via the shim's 501 fallthrough). XHR bypasses the
    // fetch shim, which would otherwise route this back into this backend.
    if (opts.serverModels) {
      const data = await adminGet("/api/models");
      if (typeof data?.json === "string") return data.json;
      // The admin went away after this page loaded. Fall through to the same
      // browser-local registry the agent worker falls back to, rather than
      // reporting "no models" for a tab that can still run.
    }
    if (modelsJson.trim()) return modelsJson;
    try {
      return await platform.fs.readFile(
        platform.path.join(platform.workspaceRoot, "models.json"),
        "utf8",
      );
    } catch {
      return "";
    }
  }

  /** The parsed effective registry, with alias slots resolved. */
  async function effectiveModelRegistry(): Promise<ModelRegistry> {
    const raw = await effectiveModelJson();
    if (!raw.trim()) return {};
    try {
      return parseModels(raw, opts.env);
    } catch {
      return {};
    }
  }

  /**
   * Probe one (possibly unsaved) model entry from the page: reachability plus
   * the ids the endpoint advertises. Mirrors the admin's `/api/models/test`
   * (`checkLlmEntry` + `listEndpointModels`) but runs in the tab, so a
   * standalone page can test a slot without any server.
   */
  async function probeModelEntry(
    raw: unknown,
  ): Promise<{ ok: boolean; models: string[]; error?: string }> {
    let entry;
    try {
      entry = parseModels(JSON.stringify({ test: raw }), opts.env).test;
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
    }
    const base = entry.baseURL.replace(/\/$/, "");
    const endpoint = entry.protocol === "ollama" ? "/api/tags" : "/models";
    const headers: Record<string, string> = { accept: "application/json" };
    if (entry.apiKey && entry.apiKey !== "no-key") headers.authorization = `Bearer ${entry.apiKey}`;
    try {
      const res = await fetch(`${base}${endpoint}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
      const data = (await res.json().catch(() => null)) as
        | { data?: { id?: unknown }[]; models?: { name?: unknown; id?: unknown }[] }
        | null;
      const rows = (data?.data ?? data?.models ?? []) as { id?: unknown; name?: unknown }[];
      const models = rows
        .map((m) => (typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : ""))
        .filter((id): id is string => !!id)
        .sort();
      return { ok: true, models };
    } catch (err) {
      // A browser CORS rejection surfaces here as a bare TypeError; name the
      // likely cause so a standalone user is not left guessing.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        models: [],
        error: `${message} (unreachable, or the endpoint does not allow browser CORS)`,
      };
    }
  }

  /** The old auto-generated mock registry (mock-llm on :8787). */
  const isMockSlot = (s: { model: string; baseURL: string }): boolean =>
    s.model === "mock-model" || /\/\/(127\.0\.0\.1|localhost):8787(?:\/|$)/.test(s.baseURL);

  // ── sessions (KAT log marker rows) ────────────────────────────────────
  // The worker owns the platform and the run log; these calls share its
  // serialized DB connection, so a turn marker never races the event flush.

  const ACTIVE_KEY = "bob:web:active-session";

  const logCtx = () => ({
    storage: opts.storage,
    server: opts.server,
  });

  const readActive = (): string | null => {
    try {
      return localStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  };
  const saveActive = (): void => {
    try {
      if (activeSession) localStorage.setItem(ACTIVE_KEY, activeSession);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* quota/private mode */
    }
  };
  const mintKey = (): string => `web:${crypto.randomUUID().slice(0, 8)}`;

  async function logSessions(): Promise<SessionSummary[]> {
    try {
      const list = await agent.log<SessionSummary[]>("listSessions", {}, logCtx());
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** Pick the saved session, else the most recent one, else a fresh chat. */
  async function loadSessionState(): Promise<void> {
    if (sessionsLoaded) return;
    if (sessionsLoad) return sessionsLoad;
    sessionsLoad = (async () => {
      const list = await logSessions();
      const saved = readActive();
      activeSession = saved || list[0]?.key || mintKey();
      saveActive();
      sessionsLoaded = true;
    })().finally(() => {
      sessionsLoad = null;
    });
    return sessionsLoad;
  }

  async function ensureSession(): Promise<string> {
    if (!activeSession) await loadSessionState();
    if (!activeSession) {
      activeSession = mintKey();
      saveActive();
    }
    return activeSession;
  }

  async function persistedTurns(key: string): Promise<TurnRecord[]> {
    try {
      const list = await agent.log<TurnRecord[]>("turns", { key, withEvents: true }, logCtx());
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /**
   * Rebuild this session's memory panel from the persisted run log, once per
   * page. A failed read does not seal the session — the next request retries —
   * while live writes keep filling the map in the meantime.
   */
  async function ensureMemory(key: string): Promise<void> {
    if (!memory.needsRebuild(key)) return;
    let writes: MemoryWrite[] = [];
    try {
      const rows = await agent.log<MemoryWrite[]>("memoryWrites", { key }, logCtx());
      if (Array.isArray(rows)) writes = rows;
    } catch {
      return;
    }
    memory.rebuild(key, writes);
  }

  /** Persisted turns plus this page's not-yet-logged ones. */
  async function turnsFor(key: string): Promise<TurnRecord[]> {
    // Loading a session also restores its memory panel (once per page).
    await ensureMemory(key);
    const persisted = await persistedTurns(key);
    const live = liveTurns.get(key) ?? [];
    if (!live.length) return persisted;
    const seen = new Set(persisted.map((t) => t.turnId));
    return [...persisted, ...live.filter((t) => !seen.has(t.turnId))];
  }

  async function awaitingFor(key: string): Promise<string | null> {
    const live = liveTurns.get(key);
    if (live?.length) return live[live.length - 1].awaiting;
    try {
      return (await agent.log<string | null>("lastAwaiting", { key }, logCtx())) ?? null;
    } catch {
      return null;
    }
  }

  async function labelFor(key: string): Promise<string> {
    try {
      return (await agent.log<string>("labelOf", { key }, logCtx())) ?? "";
    } catch {
      return "";
    }
  }

  /** The drawer's list, with this page's active shell added when it is new. */
  async function sessionList(): Promise<SessionSummary[]> {
    const list = await logSessions();
    const key = activeSession;
    if (!key) return list;
    const live = liveTurns.get(key) ?? [];
    const i = list.findIndex((s) => s.key === key);
    if (i < 0) {
      list.unshift({
        key,
        label: await labelFor(key),
        pattern: activePattern,
        updatedAt: live[live.length - 1]?.startedAt ?? Date.now(),
        turns: live.length,
        remote: false,
        awaiting: live[live.length - 1]?.awaiting ?? null,
      });
    } else if (live.length) {
      const last = live[live.length - 1];
      list[i] = {
        ...list[i],
        updatedAt: Math.max(list[i].updatedAt, last.endedAt ?? last.startedAt),
        turns: list[i].turns + live.filter((t) => t.status !== "running").length,
        awaiting: last.awaiting,
      };
    }
    return list;
  }

  /** Persist a finished turn as a `web_turn_end` marker row. */
  async function persistTurn(key: string, record: TurnRecord, run: number): Promise<void> {
    const events = record.events;
    let runId: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const id = events[i].run_id;
      if (typeof id === "string" && id) {
        runId = id;
        break;
      }
    }
    try {
      await agent.log(
        "turnEnd",
        {
          run,
          marker: {
            key,
            turnId: record.turnId,
            runId,
            input: record.input,
            inputApp: record.inputApp ?? "trunk",
            status: record.status === "error" ? "error" : record.status === "stopped" ? "stopped" : "done",
            error: record.error,
            output: record.output,
            emits: record.emits,
            levels: record.levels,
            emitApps: record.emitApps,
            buttons: record.buttons,
            awaiting: record.awaiting,
            runMode: record.runMode,
            contextLost: record.contextLost,
            tokens: record.tokens ?? null,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
          },
        },
        logCtx(),
      );
    } catch (err) {
      console.warn("session log: could not persist turn", err);
      return;
    }
    // The marker is the source of truth from now on; drop the live copy.
    const list = liveTurns.get(key);
    if (!list) return;
    const at = list.findIndex((t) => t.turnId === record.turnId);
    if (at >= 0) list.splice(at, 1);
    if (!list.length) liveTurns.delete(key);
  }

  const parseBody = <T>(b: string | FormData | null): T => {
    try {
      return JSON.parse(typeof b === "string" ? b : "{}") as T;
    } catch {
      return {} as T;
    }
  };

  // Browser secret store (localStorage; the Node target uses logs/secrets.db).
  const SECRETS_KEY = "bob:secrets";
  interface StoredSecret {
    contentType: string | null;
    base64: string;
    updatedAt: string;
  }
  const readSecrets = (): Record<string, StoredSecret> => {
    try {
      return JSON.parse(localStorage.getItem(SECRETS_KEY) || "{}") as Record<string, StoredSecret>;
    } catch {
      return {};
    }
  };
  const writeSecrets = (map: Record<string, StoredSecret>): void => {
    try {
      localStorage.setItem(SECRETS_KEY, JSON.stringify(map));
    } catch {
      /* quota/private mode */
    }
  };
  const base64Of = (bytes: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };

  const broadcast = (msg: EventMessage): void => {
    for (const cb of subscribers) {
      try {
        cb(msg);
      } catch {
        /* subscriber gone */
      }
    }
  };

  async function runTurn(turnId: string, text: string, keyOverride?: string): Promise<TurnRecord> {
    const key = keyOverride ?? (await ensureSession());
    // The slot the user is replying to (the previous turn's pause). Its
    // presence is also how a fresh run after a reload is recognised as a
    // context loss rather than a new conversation.
    const awaitingBefore = await awaitingFor(key);
    const record: TurnRecord = {
      turnId,
      input: text,
      inputApp: awaitingBefore ?? "trunk",
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      error: null,
      output: null,
      emits: [],
      levels: [],
      emitApps: [],
      awaiting: null,
      buttons: [],
      events: [],
    };
    const list = liveTurns.get(key) ?? [];
    list.push(record);
    if (list.length > 20) list.shift();
    liveTurns.set(key, list);
    // The workspace's app trees are the tile boundaries (a nested app call,
    // e.g. enrich-profile → contacts, lands on its own tile). Refreshed per
    // turn so a newly knitted app is a boundary without a reload.
    const appNames = (await listAppTrees(platform.workspaceRoot).catch(() => [])).map((a) => a.name);
    const apps = newTurnApps(appNames);
    const running = agent.run(
      {
        task: text,
        env: opts.env,
        pattern: activePattern,
        remote: opts.remote,
        storage: opts.storage,
        server: opts.server,
        chatKey: key,
        modelsJson,
        serverModels: opts.serverModels,
        modelOverrides: sessionModels.get(key),
        cdp: opts.cdp,
      },
      {
        onEvent: (event) => {
          const ev = event as { kind?: string; content?: Record<string, unknown>; scope_id?: number | null; branch_path?: string };
          addTurnTokens(record, ev);
          const app = tagEventApp(apps, ev);
          // Stream the push the tracker returns (the node paths a write landed
          // on) the same way the admin does: the panel merges it mid-turn,
          // naming the session so the UI can drop another conversation's.
          const push = memory.track(key, ev, app);
          if (push) {
            broadcast({ type: "memory", session: push.session, app: push.app, values: push.values });
          }
          const tagged = { ...ev, app };
          record.events.push(tagged);
          broadcast({ type: "event", turnId, event: tagged });
        },
        onEmit: (value) => {
          const { text: t, buttons, level } = emitValue(value);
          const app = apps.current;
          if (t) {
            record.emits.push(t);
            record.levels.push(level ?? null);
            record.emitApps.push(app);
            record.output = record.output ? record.output + "\n\n" + t : t;
          }
          if (buttons?.length) record.buttons = buttons;
          broadcast({ type: "emit", turnId, text: t, buttons, level, app });
        },
      },
    );
    activeRuns.set(key, { turnId, runId: running.runId });
    broadcast({ type: "turn_start", turnId, session: key, input: text, inputApp: record.inputApp ?? "trunk", ts: record.startedAt, awaiting: null });
    try {
      const { result, emits, mode } = await running;
      record.status = "done";
      record.runMode = mode;
      record.contextLost = mode === "fresh" && awaitingBefore != null;
      const last = emits.length ? emits[emits.length - 1] : result;
      const lastText = emitValue(last).text;
      if (!record.output && lastText) record.output = lastText;
      // The browser agent does not report pause state, so assume the tree
      // paused (the norm): the suspended app, else trunk. Keeps the input box
      // available on the next turn.
      record.awaiting = apps.suspended ?? "trunk";
      record.endedAt = Date.now();
      // Persist before announcing the end: a refresh (or a reload right after
      // the reply appears) then always finds the marker.
      await persistTurn(key, record, running.runId);
      broadcast({
        type: "turn_end", turnId, status: "done", error: null, output: record.output,
        buttons: record.buttons, emits: record.emits, levels: record.levels, emitApps: record.emitApps,
        awaiting: record.awaiting, runMode: record.runMode, contextLost: record.contextLost,
        tokens: record.tokens ?? null, ts: record.endedAt,
      });
    } catch (err) {
      if (err instanceof AgentStoppedError || isAgentStopped(err)) {
        record.status = "stopped";
        record.error = null;
        // The previous checkpoint is still the resume point; keep the input
        // box on the app the message was headed for.
        record.awaiting = record.inputApp ?? "trunk";
        record.endedAt = Date.now();
        await persistTurn(key, record, running.runId);
        broadcast({
          type: "turn_end", turnId, status: "stopped", error: null, output: record.output,
          buttons: record.buttons, emits: record.emits, levels: record.levels, emitApps: record.emitApps,
          awaiting: record.awaiting, tokens: record.tokens ?? null, ts: record.endedAt,
        });
      } else {
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.endedAt = Date.now();
        await persistTurn(key, record, running.runId);
        broadcast({ type: "turn_end", turnId, status: "error", error: record.error, output: "", buttons: [], emits: [], awaiting: null, tokens: record.tokens ?? null, ts: record.endedAt });
      }
    } finally {
      if (activeRuns.get(key)?.turnId === turnId) activeRuns.delete(key);
      const waiters = idleWaiters.get(key);
      if (waiters?.length) {
        idleWaiters.delete(key);
        for (const wake of waiters) wake();
      }
    }
    return record;
  }

  /** Resolve once the session has no running turn. */
  function whenIdle(key: string): Promise<void> {
    if (!activeRuns.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = idleWaiters.get(key) ?? [];
      list.push(resolve);
      idleWaiters.set(key, list);
    });
  }

  /** The streamed run-log row for a ref seq (newest turn wins on a rewind). */
  function findLoggedRow(seq: number): {
    seq: number;
    run_id: string;
    kind: string;
    branch_path: string | null;
    content: unknown;
  } | null {
    // Refs point into THIS page's in-memory logger (its seqs are per worker
    // session, not the DB's AUTOINCREMENT): only turns that ran here resolve.
    for (const list of liveTurns.values()) {
      for (let t = list.length - 1; t >= 0; t--) {
        const events = list[t].events;
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i];
          if (ev.seq !== seq) continue;
          return {
            seq,
            run_id: ev.run_id ?? "",
            kind: ev.kind ?? "record",
            branch_path: ev.branch_path ?? null,
            content: ev.content ?? null,
          };
        }
      }
    }
    return null;
  }

  async function patternCatalog(): Promise<BackendResponse> {
    try {
      const sources = await listTreeSources(platform.workspaceRoot);
      const patterns = sources.map((s) => ({ name: s.name, group: s.group, description: s.description }));
      const names = patterns.map((p) => p.name);
      // `activePattern` may arrive as a path from boot detection; compare by
      // logical name so a tree path is not replaced by names[0].
      const wanted = patternLabel(activePattern);
      const current = names.includes(wanted) ? wanted : names[0] ?? activePattern;
      activePattern = current;
      return { status: 200, body: { current, pattern: current, patterns } };
    } catch {
      return { status: 200, body: { current: activePattern, pattern: activePattern, patterns: [] } };
    }
  }

  async function request(
    method: string,
    pathname: string,
    search: URLSearchParams,
    body: string | FormData | null,
  ): Promise<BackendResponse> {
    // Served by the admin: its models.json is authoritative, so model settings
    // and tests are the server's (the shim forwards this 501). Slots are
    // handled locally so the chat picker can merge this session's overrides.
    if (
      opts.serverModels &&
      pathname.startsWith("/api/models") &&
      pathname !== "/api/models/slots"
    ) {
      return UNAVAILABLE("models");
    }

    // ── chat ──────────────────────────────────────────────────────────────
    if (pathname === "/api/session" && method === "GET") {
      const key = await ensureSession();
      return {
        status: 200,
        body: {
          active: key,
          label: await labelFor(key),
          follow: false,
          models: sessionModels.get(key) ?? {},
          awaiting: await awaitingFor(key),
          sessions: await sessionList(),
          turns: await turnsFor(key),
        },
      };
    }
    if (pathname === "/api/session" && method === "POST") {
      const sel = parseBody<{
        key?: unknown;
        new?: unknown;
        delete?: unknown;
        follow?: unknown;
        label?: unknown;
      }>(body);

      if (typeof sel.follow === "boolean") {
        return {
          status: 200,
          body: { ok: true, active: await ensureSession(), follow: false, sessions: await sessionList() },
        };
      }

      // Rename: `key` defaults to the active session; empty re-derives the
      // label from the first message (matching the admin's `/api/session`).
      if (typeof sel.label === "string") {
        const target = typeof sel.key === "string" && sel.key ? sel.key : await ensureSession();
        const known =
          target === activeSession ||
          (await agent.log<boolean>("hasSession", { key: target }, logCtx()).catch(() => false));
        if (!known) return { status: 404, body: { error: "no such session" } };
        await agent.log("label", { key: target, label: sel.label.trim().slice(0, 80) }, logCtx());
        activeSession = target;
        saveActive();
        const list = await sessionList();
        broadcast({ type: "sessions", sessions: list });
        return {
          status: 200,
          body: { ok: true, key: target, label: await labelFor(target), sessions: list },
        };
      }

      // Mint-or-reuse: repeated "new chat" clicks must not pile up empty
      // shells (same rule as the admin's reuseOrMintActive).
      if (sel.new === true) {
        const key = await ensureSession();
        const count = await agent
          .log<number>("turnCount", { key }, logCtx())
          .catch(() => 0);
        const pinned = await agent
          .log<boolean>("hasLabelPin", { key }, logCtx())
          .catch(() => false);
        if (!(key.startsWith("web:") && count === 0 && !pinned)) {
          activeSession = mintKey();
          saveActive();
        }
        const list = await sessionList();
        broadcast({ type: "sessions", sessions: list });
        return { status: 200, body: { ok: true, active: activeSession, follow: false, turns: [] } };
      }

      if (typeof sel.delete === "string") {
        const known = await agent
          .log<boolean>("hasSession", { key: sel.delete }, logCtx())
          .catch(() => false);
        // The active chat can be a freshly minted shell with no markers yet;
        // clearing it is still valid (it simply disappears).
        if (!known && sel.delete !== activeSession) {
          return { status: 404, body: { error: "no such session" } };
        }
        if (known) {
          // A tombstone, not a purge: the trace stays in the log.
          await agent.log("delete", { key: sel.delete }, logCtx());
        }
        liveTurns.delete(sel.delete);
        sessionModels.delete(sel.delete);
        memory.clear(sel.delete);
        // Deleting the bridged chat ends the bridge: the phone would
        // otherwise keep writing into a conversation that no longer exists.
        if (lstore.read(BRIDGE_SESSION_KEY) === sel.delete) {
          lstore.write(BRIDGE_KEY, null);
          lstore.write(BRIDGE_SESSION_KEY, null);
        }
        if (activeSession === sel.delete) {
          activeSession = null;
          saveActive();
          broadcast({ type: "cleared" });
        }
        return { status: 200, body: { ok: true, active: activeSession, sessions: await sessionList() } };
      }

      if (typeof sel.key === "string") {
        const known = await agent
          .log<boolean>("hasSession", { key: sel.key }, logCtx())
          .catch(() => false);
        if (!known && sel.key !== activeSession) {
          return { status: 404, body: { error: "no such session" } };
        }
        activeSession = sel.key;
        saveActive();
        return {
          status: 200,
          body: { ok: true, active: sel.key, follow: false, turns: await turnsFor(sel.key) },
        };
      }

      return { status: 400, body: { error: "key, new, or delete required" } };
    }
    if (pathname === "/api/turns" && method === "GET") {
      const key = await ensureSession();
      return { status: 200, body: { turns: await turnsFor(key), session: key, awaiting: await awaitingFor(key) } };
    }
    if (pathname === "/api/ref" && method === "GET") {
      // Refs are `ref://<seq>` addresses into the run log of the SELECTED
      // storage (OPFS, or the real workspace through the bridge). Ask the
      // worker — it owns that log and its serialized connection — so the row
      // inspected is the one on disk. Only a row logged inside the last flush
      // window is still memory-only; fall back to the streamed event for that.
      const seq = Number(search.get("seq"));
      if (!Number.isInteger(seq)) return { status: 400, body: { error: "seq is required" } };
      const stored = await agent
        .log<{ seq: number; run_id: string; kind: string; branch_path: string | null; content: unknown } | null>(
          "readRow",
          { seq },
          logCtx(),
        )
        .catch(() => null);
      const row = stored ?? findLoggedRow(seq);
      if (!row) return { status: 404, body: { error: `no run-log row ${seq} in this workspace log` } };
      return { status: 200, body: refTargetFromRow(row, search.get("path")) };
    }
    if (pathname === "/api/apps" && method === "GET") {
      const appTrees = await listAppTrees(platform.workspaceRoot).catch(() => []);
      return {
        status: 200,
        body: {
          apps: [
            { name: "trunk", description: "The main conversation tree.", group: "trunk" },
            ...appTrees.map((a) => ({ name: a.name, description: a.description, guide: a.guide, group: "app", parent: a.parent ?? null })),
          ],
        },
      };
    }
    if (pathname === "/api/chat/stop" && method === "POST") {
      const key = await ensureSession();
      const active = activeRuns.get(key);
      if (active) agent.stop(active.runId);
      return { status: 200, body: { ok: true, stopped: Boolean(active) } };
    }
    if (pathname === "/api/chat" && method === "POST") {
      const text = (parseBody(body) as { text?: string }).text ?? "";
      const turnId = crypto.randomUUID();
      void runTurn(turnId, text);
      return { status: 200, body: { turnId, queued: false } };
    }
    if (pathname === "/api/chat/upload" && method === "POST") {
      if (!(body instanceof FormData)) return { status: 400, body: { error: "multipart required" } };
      const file = body.get("file");
      if (!(file instanceof File)) return { status: 400, body: { error: "no file" } };
      const caption = String(body.get("caption") ?? "");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const safe = (file.name || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "upload";
      const rel = `assets/inbox/${crypto.randomUUID()}-${safe}`;
      const abs = platform.path.join(platform.workspaceRoot, rel);
      await platform.fs.mkdir(platform.path.dirname(abs), { recursive: true });
      await platform.fs.writeFile(abs, bytes);
      const text =
        `[Attached file: ${rel} (${file.type || "application/octet-stream"}, ${bytes.length} bytes)]` +
        (caption ? `\n\n${caption}` : "");
      const turnId = crypto.randomUUID();
      void runTurn(turnId, text);
      return { status: 200, body: { ok: true, turnId } };
    }
    if (pathname === "/api/clear" && method === "POST") {
      // Same rule as "new chat": reuse an unused private chat, otherwise mint.
      const key = await ensureSession();
      const count = await agent.log<number>("turnCount", { key }, logCtx()).catch(() => 0);
      const pinned = await agent.log<boolean>("hasLabelPin", { key }, logCtx()).catch(() => false);
      if (!(key.startsWith("web:") && count === 0 && !pinned)) {
        activeSession = mintKey();
        saveActive();
      }
      broadcast({ type: "cleared" });
      return { status: 200, body: { ok: true, active: activeSession } };
    }
    // Capability probe shared with the admin's settings page. `serverModels`
    // is true exactly when this tab was served by the admin server (it is what
    // servedByAdmin() found at boot), so the page can tell "admin behind me"
    // from "nothing but a file server" even though both use this backend.
    if (pathname === "/api/capabilities" && method === "GET") {
      return { status: 200, body: { admin: !!opts.serverModels, mode: "browser" } };
    }
    if (pathname === "/api/status" && method === "GET") {
      return {
        status: 200,
        body: {
          telegram: "n/a",
          voice: "browser whisper (local)",
          llm: "n/a",
          uptime: Math.round(performance.now() / 1000),
          pid: null,
          workspace: platform.workspaceRoot,
          storage: opts.storage,
          // Same shape as the admin's status: the Settings page populates the
          // credentials shortcuts and the all-keys editor from this.
          env: loadEnv(),
        },
      };
    }
    // ── pattern / tree ────────────────────────────────────────────────────
    if (pathname === "/api/pattern" && method === "GET") return patternCatalog();
    if (pathname === "/api/pattern" && method === "POST") {
      const want = (parseBody(body) as { name?: string }).name;
      if (want) {
        const next = patternLabel(want) || want;
        // Pause state is pattern-specific: a different tree has different
        // slots, so the tracked memory is dropped (as the admin does). The
        // transcripts stay in the log, and each panel rebuilds from it on
        // its next view — a switch is not a deletion, so the sessions are
        // reset unsealed rather than sealed empty.
        if (next !== activePattern) memory.reset();
        activePattern = next;
        // The toolbar above the app shows the active pattern; let it follow
        // switches without polling.
        window.dispatchEvent(
          new CustomEvent("bob:pattern", { detail: { pattern: activePattern } }),
        );
      }
      return { status: 200, body: { pattern: activePattern } };
    }
    if (pathname === "/api/tree/memory") {
      // `?session=` names the panel's conversation (the drawer may have just
      // switched); the active one otherwise. Same contract as the admin.
      const key = search.get("session") || (await ensureSession());
      await ensureMemory(key);
      return { status: 200, body: memory.payload(key) };
    }
    if (pathname === "/api/models/slots" && method === "GET") {
      // Served by the admin: list ITS slots (the real registry), but keep this
      // session's own role→slot overrides. Falling through to the admin's
      // /api/models/slots would return the admin session's overrides instead,
      // resetting the browser picker to "default" after every choice.
      let slots: { name: string; model: string; baseURL: string }[] = [];
      const localSlots = async () => {
        const reg = await effectiveModelRegistry();
        return Object.entries(reg).map(([name, m]) => ({
          name,
          model: m.model,
          baseURL: m.baseURL,
        }));
      };
      if (opts.serverModels) {
        const data = await adminGet("/api/models/slots");
        if (Array.isArray(data?.slots)) {
          slots = (data.slots as { name?: unknown; model?: unknown; baseURL?: unknown }[])
            .filter((s) => typeof s?.name === "string")
            .map((s) => ({
              name: String(s.name),
              model: typeof s.model === "string" ? s.model : "",
              baseURL: typeof s.baseURL === "string" ? s.baseURL : "",
            }));
        } else {
          // The admin stopped after this page loaded: show what a run would
          // fall back to, instead of an empty picker.
          slots = await localSlots();
        }
      } else {
        slots = await localSlots();
      }
      return {
        status: 200,
        body: {
          slots,
          active: await ensureSession(),
          models: sessionModels.get(await ensureSession()) ?? {},
          // Lets the picker say "mock only" instead of pretending the old
          // auto-generated :8787 entries are real models.
          mockOnly: slots.length > 0 && slots.every(isMockSlot),
        },
      };
    }
    if (pathname === "/api/chat/model" && method === "POST") {
      const { role = "", slot = "" } = parseBody<{ role?: string; slot?: string }>(body);
      if (!role) return { status: 400, body: { error: "role is required" } };
      const key = await ensureSession();
      const rec = { ...(sessionModels.get(key) ?? {}) };
      if (slot) {
        let known: Set<string>;
        if (opts.serverModels) {
          const data = await adminGet("/api/models/slots");
          known = new Set(
            (Array.isArray(data?.slots) ? (data.slots as { name?: unknown }[]) : [])
              .map((s) => s?.name)
              .filter((n): n is string => typeof n === "string"),
          );
        } else {
          known = new Set(Object.keys(await effectiveModelRegistry()));
        }
        // A failed admin read (known.size === 0) must not block the picker.
        if (known.size > 0 && !known.has(slot)) {
          return { status: 400, body: { error: `unknown model slot "${slot}"` } };
        }
        rec[role] = slot;
      } else {
        delete rec[role];
      }
      if (Object.keys(rec).length) sessionModels.set(key, rec);
      else sessionModels.delete(key);
      return { status: 200, body: { ok: true, models: rec } };
    }
    if (pathname === "/api/tree" && method === "GET") {
      const logical = search.get("pattern") ?? "";
      const entry = await resolveTreeEntry(platform.workspaceRoot, logical);
      if (!entry) return { status: 404, body: { error: `tree not found: ${logical}` } };
      try {
        const mod = await createModuleLoader(platform).load(entry.file);
        const def = (mod as { default?: unknown }).default ?? mod;
        return { status: 200, body: { pattern: entry.logical, tree: serializeTree(def) } };
      } catch (err) {
        return { status: 500, body: { error: `could not load tree: ${err instanceof Error ? err.message : String(err)}` } };
      }
    }
    // ── files ─────────────────────────────────────────────────────────────
    if (pathname === "/api/files" && method === "GET") {
      const rel = search.get("path") ?? ".";
      try {
        const dirAbs = platform.path.resolve(platform.workspaceRoot, rel);
        const entries = await platform.fs.readdir(dirAbs, { withFileTypes: true });
        const files = entries
          .map((e) => ({ name: e.name, isDir: e.isDirectory(), size: 0, mtime: null as number | null }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        return { status: 200, body: { dir: rel === "." ? "" : rel, files } };
      } catch {
        return { status: 200, body: { dir: rel, files: [] } };
      }
    }
    if (pathname === "/api/files" && method === "DELETE") {
      const rel = search.get("path") ?? "";
      try {
        await platform.fs.rm(platform.path.resolve(platform.workspaceRoot, rel));
        return { status: 200, body: { ok: true } };
      } catch (err) {
        return { status: 400, body: { error: String(err) } };
      }
    }
    if (pathname === "/api/files/download") {
      const rel = search.get("path") ?? "";
      try {
        const content = await platform.fs.readFile(platform.path.resolve(platform.workspaceRoot, rel), "utf8");
        return { status: 200, contentType: "text/plain; charset=utf-8", body: content };
      } catch (err) {
        return { status: 404, body: { error: String(err) } };
      }
    }

    // ── voice: transcription is Telegram-only; no in-browser STT model ────
    // (falls through to the /api/ 501 below, so the UI degrades cleanly)

    if (pathname === "/api/files/upload" && method === "POST") {
      if (!(body instanceof FormData)) return { status: 400, body: { error: "multipart required" } };
      const dir = String(body.get("path") ?? "");
      const file = body.get("file");
      if (!(file instanceof File)) return { status: 400, body: { error: "no file" } };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const target = platform.path.join(platform.workspaceRoot, dir, file.name);
      await platform.fs.mkdir(platform.path.dirname(target), { recursive: true });
      await platform.fs.writeFile(target, bytes);
      return { status: 200, body: { ok: true, name: file.name } };
    }

    // ── patterns ──────────────────────────────────────────────────────────
    if (pathname === "/api/patterns" && method === "GET") {
      const patterns = await listPatterns(platform.workspaceRoot).catch(() => []);
      return { status: 200, body: { patterns } };
    }
    if (pathname.startsWith("/api/patterns/") && method === "GET") {
      const name = decodeURIComponent(pathname.slice("/api/patterns/".length));
      try {
        const content = await platform.fs.readFile(platform.path.join(platform.workspaceRoot, "patterns", `${name}.mjs`), "utf8");
        return { status: 200, body: { name, content } };
      } catch {
        return { status: 404, body: { error: "not found" } };
      }
    }
    if (pathname === "/api/patterns" && method === "POST") {
      const parsed = parseBody(body) as { name?: string; content?: string };
      if (!parsed.name || typeof parsed.content !== "string") {
        return { status: 400, body: { error: "name and content required" } };
      }
      const file = platform.path.join(platform.workspaceRoot, "patterns", `${parsed.name.replace(/\.mjs$/, "")}.mjs`);
      await platform.fs.mkdir(platform.path.dirname(file), { recursive: true });
      await platform.fs.writeFile(file, parsed.content);
      return { status: 200, body: { ok: true, name: parsed.name } };
    }
    if (pathname.startsWith("/api/patterns/") && method === "DELETE") {
      const name = decodeURIComponent(pathname.slice("/api/patterns/".length));
      try {
        await platform.fs.rm(platform.path.join(platform.workspaceRoot, "patterns", `${name}.mjs`));
        return { status: 200, body: { ok: true } };
      } catch (err) {
        return { status: 404, body: { error: String(err) } };
      }
    }

    // ── models (browser settings; keys never touch the workspace) ─────────
    if (pathname === "/api/models" && method === "GET") {
      // Show the effective config: the Settings override, else the workspace
      // models.json. An empty editor here is why aliases could not be added.
      return { status: 200, body: { json: await effectiveModelJson() } };
    }
    if (pathname === "/api/models/test" && method === "POST") {
      // Standalone: probe the endpoint from the tab. Served by the admin, the
      // gate above forwards this to the admin's own implementation.
      return { status: 200, body: await probeModelEntry(parseBody<unknown>(body)) };
    }
    if (pathname === "/api/models" && method === "POST") {
      const json = parseBody<{ json?: string }>(body).json ?? "";
      modelsJson = json;
      saveModelsJson(json);
      return { status: 200, body: { ok: true } };
    }

    // ── env (browser settings) ────────────────────────────────────────────
    if (pathname === "/api/env" && method === "POST") {
      // Same shape as the admin: a value sets the key, `null` removes it.
      // Mirror updates into opts.env so runs/probes see them without a reload
      // (the Node target needs a restart; the tab does not).
      const vars = parseBody(body) as Record<string, string | null>;
      const env = loadEnv();
      for (const [k, v] of Object.entries(vars)) {
        if (v === null) {
          delete env[k];
          delete opts.env[k];
        } else if (typeof v === "string") {
          env[k] = v;
          opts.env[k] = v;
        }
      }
      saveEnv(env);
      return { status: 200, body: { ok: true } };
    }

    // ── git (commit/sync) over the active platform ────────────────────────
    if (pathname === "/api/commit" && method === "POST") {
      const message = (parseBody<{ message?: string }>(body).message || "").trim() || "manual commit from admin UI";
      try {
        await platform.git.ensureRepo();
        await writeDatabaseDumps(platform).catch(() => {});
        const hash = platform.git.commitAll
          ? await platform.git.commitAll(message)
          : await platform.git.autoCommit(["."], message);
        return { status: 200, body: { ok: true, committed: hash !== "no-changes", hash } };
      } catch (err) {
        return { status: 200, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }
    if ((pathname === "/api/sync/push" || pathname === "/api/sync/pull") && method === "POST") {
      const p = parseBody<{ local?: string; remote?: string }>(body);
      const posted = p.remote ?? "";
      const url = opts.remote || (/[:\/]/.test(posted) ? posted : "");
      if (!url) return { status: 400, body: { error: "set a git remote first" } };
      const branch = posted || p.local || "master";
      try {
        if (pathname === "/api/sync/pull") {
          const out = platform.git.pull
            ? await platform.git.pull(url, branch)
            : await platform.git.fetch?.(url);
          const dbSync = await applyDatabaseDumps(platform).catch(() => null);
          return { status: 200, body: { ok: true, output: typeof out === "string" ? out : JSON.stringify(out ?? {}), dbSync } };
        }
        const out = await withSyncLock(platform, { remote: url }, async () => {
          await writeDatabaseDumps(platform).catch(() => {});
          await platform.git.commitAll?.("sync: database dumps").catch(() => {});
          return platform.git.push?.(url, branch);
        });
        return { status: 200, body: { ok: true, output: typeof out === "string" ? out : JSON.stringify(out ?? {}) } };
      } catch (err) {
        return { status: 200, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    // ── logs ──────────────────────────────────────────────────────────────
    if (pathname === "/api/log") return { status: 200, body: { content: "" } };

    // ── secrets (declarations in app/*/secrets.json; stored in localStorage) ─
    if (pathname === "/api/secrets" && method === "GET") {
      const stored = readSecrets();
      const secrets: unknown[] = [];
      try {
        const appDir = platform.path.join(platform.workspaceRoot, "app");
        const apps = await platform.fs.readdir(appDir, { withFileTypes: true });
        for (const appEntry of apps) {
          if (!appEntry.isDirectory()) continue;
          try {
            const raw = JSON.parse(
              await platform.fs.readFile(platform.path.join(appDir, appEntry.name, "secrets.json"), "utf8"),
            ) as unknown;
            const list = Array.isArray(raw)
              ? raw
              : Array.isArray((raw as { secrets?: unknown[] })?.secrets)
                ? (raw as { secrets: unknown[] }).secrets
                : [];
            for (const item of list) {
              const it = item as { name?: unknown; description?: unknown; contentType?: unknown };
              if (typeof it?.name !== "string") continue;
              const hit = stored[`${appEntry.name}/${it.name}`];
              secrets.push({
                app: appEntry.name,
                name: it.name,
                description: typeof it.description === "string" ? it.description : "",
                contentType: typeof it.contentType === "string" ? it.contentType : null,
                present: !!hit,
                size: hit ? Math.floor((hit.base64.length * 3) / 4) : 0,
                updatedAt: hit?.updatedAt ?? null,
              });
            }
          } catch {
            /* no manifest */
          }
        }
      } catch {
        /* no app dir */
      }
      return { status: 200, body: { secrets } };
    }
    if (pathname === "/api/secrets" && method === "POST") {
      if (!(body instanceof FormData)) return { status: 400, body: { error: "multipart required" } };
      const appName = search.get("app") ?? "";
      const secretName = search.get("name") ?? "";
      const file = body.get("file");
      if (!(file instanceof File)) return { status: 400, body: { error: "no file" } };
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > 1024 * 1024) return { status: 413, body: { error: "secret too large (max 1 MB)" } };
      const map = readSecrets();
      map[`${appName}/${secretName}`] = {
        contentType: file.type || "application/octet-stream",
        base64: base64Of(bytes),
        updatedAt: new Date().toISOString(),
      };
      writeSecrets(map);
      return { status: 200, body: { ok: true, app: appName, name: secretName, size: bytes.length } };
    }
    if (pathname === "/api/secrets/vars" && method === "POST") {
      const appName = search.get("app") ?? "";
      const secretName = search.get("name") ?? "";
      const value = parseBody<{ value?: unknown }>(body).value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { status: 400, body: { error: "value must be an object" } };
      }
      const text = JSON.stringify(value, null, 2);
      const map = readSecrets();
      map[`${appName}/${secretName}`] = {
        contentType: "application/json",
        base64: base64Of(new TextEncoder().encode(text)),
        updatedAt: new Date().toISOString(),
      };
      writeSecrets(map);
      return { status: 200, body: { ok: true, app: appName, name: secretName, size: text.length } };
    }
    // Import a desktop secrets.db (app_secrets table) into the localStorage
    // store. Body: { base64 }. The uploaded DB is written to a temp OPFS path
    // (not *.db, so the auto-sync dumper ignores it), read, then removed.
    if (pathname === "/api/secrets/import" && method === "POST") {
      const b64 = parseBody<{ base64?: string }>(body).base64 ?? "";
      if (!b64) return { status: 400, body: { error: "base64 required" } };
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const tmpAbs = platform.path.join(platform.workspaceRoot, ".secrets-import.tmp");
      try {
        await platform.fs.writeFile(tmpAbs, bytes);
        const db = await platform.sqlite.open(tmpAbs, { readOnly: true });
        let imported = 0;
        try {
          const stmt = await db.prepare("SELECT app, name, content, content_type, updated_at FROM app_secrets");
          const rows = (await stmt.all()) as Array<Record<string, unknown>>;
          const map = readSecrets();
          for (const row of rows) {
            const app = String(row.app ?? "");
            const name = String(row.name ?? "");
            if (!app || !name) continue;
            const raw = row.content;
            const bytesOf =
              raw instanceof Uint8Array
                ? raw
                : raw instanceof ArrayBuffer
                  ? new Uint8Array(raw)
                  : Array.isArray(raw)
                    ? Uint8Array.from(raw as number[])
                    : typeof raw === "string"
                      ? new TextEncoder().encode(raw)
                      : new Uint8Array();
            map[`${app}/${name}`] = {
              contentType: row.content_type == null ? null : String(row.content_type),
              base64: base64Of(bytesOf),
              updatedAt: row.updated_at == null ? new Date().toISOString() : String(row.updated_at),
            };
            imported++;
          }
          writeSecrets(map);
        } finally {
          await db.close();
        }
        return { status: 200, body: { ok: true, imported } };
      } catch (err) {
        return { status: 200, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      } finally {
        await platform.fs.rm(tmpAbs).catch(() => {});
      }
    }
    if (pathname === "/api/secrets" && method === "DELETE") {
      const appName = search.get("app") ?? "";
      const secretName = search.get("name") ?? "";
      const map = readSecrets();
      const key = `${appName}/${secretName}`;
      const existed = !!map[key];
      delete map[key];
      writeSecrets(map);
      return { status: existed ? 200 : 404, body: { ok: existed } };
    }

    if (pathname.startsWith("/api/")) return UNAVAILABLE(pathname);
    return { status: 404, body: { error: "not found" } };
  }

  // ── two-way Telegram bridge (server half: src/telegram-bridge.ts) ─────
  // The tab is the conversation's brain: this loop only relays messages to
  // and from the admin. XHR is used because the fetch shim routes `/api/*`
  // straight back into this backend. Nothing here touches the server's log,
  // sessions, or follow bindings — the OPFS session stays in this page.
  const BRIDGE_KEY = "bob:telegram-bridge";
  const BRIDGE_SESSION_KEY = "bob:telegram-bridge-session";
  const BRIDGE_SEEN_KEY = "bob:telegram-bridge-seen";
  let bridgeWasOn = false;
  let bridgeChain: Promise<void> = Promise.resolve();

  const lstore = {
    read(key: string): string {
      try {
        return localStorage.getItem(key) ?? "";
      } catch {
        return "";
      }
    },
    write(key: string, value: string | null): void {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        /* quota / private mode */
      }
    },
  };
  const bridgeSeen = (): number[] => {
    try {
      const raw = JSON.parse(lstore.read(BRIDGE_SEEN_KEY) || "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
    } catch {
      return [];
    }
  };
  const bridgeDelay = (): number =>
    typeof document !== "undefined" && document.visibilityState === "hidden" ? 10_000 : 4_000;

  /** Answer one phone message in the OPFS session, then relay the reply. */
  async function runBridgeMessage(msg: { id: number; text: string }, epoch: number): Promise<void> {
    // Pinned when the bridge was switched on: switching browser chats does
    // not silently re-target the phone thread.
    const key = lstore.read(BRIDGE_SESSION_KEY) || (await ensureSession());
    await whenIdle(key);
    const record = await runTurn(crypto.randomUUID(), msg.text, key);
    const text =
      record.status === "error"
        ? `Something went wrong: ${record.error ?? "error"}`
        : record.output || "(no reply)";
    const sent = await adminPost("/api/telegram/relay", { text, replyTo: msg.id, epoch });
    if (sent.status !== 200) console.warn("[bridge] relay failed:", sent.status, sent.data);
  }

  /** Heartbeat → inbox → run → relay. Reschedules itself (visibility-aware). */
  async function bridgeTick(): Promise<void> {
    try {
      if (!opts.serverModels || lstore.read(BRIDGE_KEY) !== "1") {
        if (bridgeWasOn) {
          bridgeWasOn = false;
          await adminPost("/api/telegram/bridge", { enabled: false });
        }
        return;
      }
      const beat = await adminPost("/api/telegram/bridge", { enabled: true });
      if (beat.status !== 200) {
        bridgeWasOn = false;
        return; // server gone or no linked chat: nothing to relay
      }
      bridgeWasOn = true;
      const inbox = await adminGet("/api/telegram/inbox");
      if (!inbox || inbox.bridged !== true) return;
      const pending = Array.isArray(inbox.pending) ? (inbox.pending as Array<Record<string, unknown>>) : [];
      const answered = new Set(Array.isArray(inbox.answeredIds) ? (inbox.answeredIds as number[]) : []);
      const seen = new Set(bridgeSeen());
      const epoch = typeof inbox.epoch === "number" ? inbox.epoch : 0;
      const fresh = pending
        .filter((m): m is { id: number; text: string } => typeof m.id === "number" && typeof m.text === "string")
        .filter((m) => !seen.has(m.id) && !answered.has(m.id));
      if (!fresh.length) return;
      // Remember before running: a reload mid-turn must not run the message
      // twice. If the tab dies before answering, the server's sweep takes over.
      lstore.write(BRIDGE_SEEN_KEY, JSON.stringify([...seen, ...fresh.map((m) => m.id)].slice(-300)));
      for (const m of fresh) {
        bridgeChain = bridgeChain
          .then(() => runBridgeMessage(m, epoch))
          .catch((err) => console.warn("[bridge] turn failed:", err));
      }
    } finally {
      const timer = setTimeout(() => void bridgeTick(), bridgeDelay());
      (timer as { unref?: () => void }).unref?.();
    }
  }

  const ready = Promise.resolve();
  // Start polling only after the first paint: the first tick is a no-op unless
  // the user enabled bridging (localStorage survives reloads).
  setTimeout(() => void bridgeTick(), bridgeDelay());

  return {
    ready,
    request,
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
  };
}
