/**
 * Agent Web Worker — the browser target's "server".
 *
 * Owns the Platform (OPFS or the desktop bridge), the tool registry, the
 * grandma-kat runtime and per-pattern sessions (continuation checkpoints) so
 * trees with `Human(...)` — like the real trunk — can pause and resume across
 * chat messages.
 */
import { Tree, name, Call, Return, Tools, knit, resume } from "grandma-kat";
import { createBrowserPlatform, initSqlite } from "../platform/browser";
import { createDesktopPlatform } from "../platform/desktop";
import type { Platform } from "../../../src/platform/types";
import { browserTools, STUB_TOOL_NAMES } from "./browser-tools";
import { setActiveFs, setFsIndex } from "../shims/node-fs-promises";
import { listAppTrees } from "../../../src/tree-sources";
import { resolveTreeEntry } from "../../../src/tree-versions";
import { assembleGuides, HOST_GUIDES } from "../../../src/tool-guides";
import { createWorkspaceLogger, type MemoryLogger, type WorkspaceLogger } from "./logger";
import {
  getTurns,
  hasLabelPin,
  hasSession,
  labelOf,
  lastAwaiting,
  listSessions,
  turnCount,
  writeDelete,
  writeLabel,
  writeTurnEnd,
} from "./log-store";
import type { TurnMarker } from "../../../src/web-log";
import { createModuleLoader } from "./module-loader";
import { resolvePatternPath } from "./pattern-path";
import { loadBrowserModels } from "./models";
import { parseModels, type ModelRegistry } from "../../../src/model-config";

const ready = initSqlite();
const platforms = new Map<string, Platform>();

async function getPlatform(storage: string, server: string): Promise<Platform> {
  const key = `${storage}|${server}`;
  let platform = platforms.get(key);
  if (!platform) {
    platform =
      storage === "desktop" ? createDesktopPlatform("/", server) : createBrowserPlatform("/workspace");
    platforms.set(key, platform);
  }
  return platform;
}

function post(message: unknown): void {
  (self as unknown as Worker).postMessage(message);
}

/**
 * The registry a tree should see: each overridden role (e.g. "strong")
 * resolves to the conversation's chosen target slot (e.g. "v4.1"). Unknown or
 * stale targets are ignored so deleting a slot cannot break a live chat.
 */
function applyModelOverrides(
  base: ModelRegistry,
  overrides?: Record<string, string>,
): ModelRegistry {
  if (!overrides) return base;
  let out: ModelRegistry | null = null;
  for (const [role, target] of Object.entries(overrides)) {
    if (target === role || !base[target]) continue;
    if (!out) out = { ...base };
    out[role] = base[target];
  }
  return out ?? base;
}

/** One-line description of every configured model slot, for error messages. */
function describeModels(models: Record<string, { baseURL?: string; model?: string }>): string {
  const slots = Object.entries(models).map(([slot, entry]) => {
    const where = entry.baseURL || "(in-page handler)";
    return `${slot}=${entry.model || "?"} @ ${where}`;
  });
  return slots.length ? slots.join(", ") : "(no models configured)";
}

/** Firefox says "NetworkError…", Chrome "Failed to fetch", Node "fetch failed". */
function isNetworkError(message: string): boolean {
  return /NetworkError|Failed to fetch|fetch failed|Load failed|ECONNREFUSED|ENOTFOUND/i.test(message);
}

/**
 * Run a model-backed step and, when the failure is a failed `fetch`, say WHICH
 * endpoint failed. Without this the worker's catch-all reports a bare
 * "NetworkError when attempting to fetch resource." and the user cannot tell a
 * dead model server from a CORS block or a broken workspace.
 */
async function withModelContext<T>(
  models: Record<string, { baseURL?: string; model?: string }>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isNetworkError(message)) throw err;
    throw new Error(
      `${message} — the agent could not reach its model endpoint(s): ${describeModels(models)}. ` +
        `Is the model server running (for the bundled mock: npm --prefix web run mock-llm), ` +
        `and does it allow this page's origin (CORS)? Fix models.json or Settings → Models JSON.`,
    );
  }
}

/**
 * When the app is served by grandpa-bob's admin, use ITS models.json (the file
 * Telegram reads) and route each call through `/api/llm/<slot>`. One config,
 * server-side network (providers without CORS still work), and the API keys
 * never reach the page. Returns null when no admin is serving the app.
 */
async function loadServerModels(env: Record<string, string>): Promise<ModelRegistry | null> {
  try {
    const res = await fetch("/api/models", { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return null;
    const data = (await res.json()) as { json?: string };
    if (!data.json?.trim()) return null;
    const registry = parseModels(data.json, env);
    const origin = self.location.origin;
    const out: ModelRegistry = {};
    for (const [name, entry] of Object.entries(registry)) {
      out[name] = {
        ...entry,
        baseURL: `${origin}/api/llm/${encodeURIComponent(name)}`,
        apiKey: "proxy",
      };
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Wrap the tool map so any name a tree declares but this target doesn't
 * implement resolves to an error stub instead of failing the knit. Keeps
 * trunk working as the workspace's tool list evolves.
 */
function withStubs(tools: Record<string, unknown>): Record<string, unknown> {
  const stub = (name: string): unknown => ({
    description: `${name} is not available in the browser target.`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ error: `${name} is not available in the browser target` }),
  });
  return new Proxy(tools, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      return typeof prop === "string" ? stub(prop) : undefined;
    },
    has() {
      return true;
    },
  });
}

interface RunOptions {
  id: number;
  task?: string;
  env?: Record<string, string>;
  pattern?: string;
  remote?: string;
  storage?: "browser" | "desktop";
  server?: string;
  /** The chat session this run belongs to (the drawer's active key). */
  chatKey?: string;
  modelsJson?: string;
  /** Served by the admin: use its models.json via the /api/llm proxy. */
  serverModels?: boolean;
  /** Per-conversation role→slot overrides (e.g. strong → "v4.1"). */
  modelOverrides?: Record<string, string>;
}

interface Session {
  logger: WorkspaceLogger;
  continuation: string;
  currentId: number;
  platform: Platform;
}

const sessions = new Map<string, Session>();
/** The session each in-flight/completed run used, so a turn marker can find it. */
const runs = new Map<number, Session>();

function getSession(key: string, platform: Platform): Session {
  let session = sessions.get(key);
  if (!session) {
    const created: Session = {
      logger: null as unknown as WorkspaceLogger,
      continuation: "",
      currentId: 0,
      platform,
    };
    created.logger = createWorkspaceLogger(platform, (event) =>
      post({ id: created.currentId, type: "event", event }),
    );
    sessions.set(key, created);
    session = created;
  }
  return session;
}

async function loadPattern(platform: Platform, patternPath: string): Promise<unknown> {
  try {
    const mod = await createModuleLoader(platform).load(patternPath);
    return mod.default ?? mod.pattern;
  } catch (err) {
    throw new Error(
      `cannot load pattern ${patternPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const indexed = new Set<string>();

/** Build the sync fs index (used by `appTreeNames()` inside tree patterns). */
async function ensureIndex(platform: Platform, key: string): Promise<void> {
  if (indexed.has(key)) return;
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await platform.fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = platform.path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(platform.workspaceRoot);
  setFsIndex(files);
  indexed.add(key);
}

const treeCache = new Map<string, Promise<unknown>>();

/** Resolve + load a tree by logical name (or `name@ref`) from the workspace. */
async function loadTreeRef(platform: Platform, name: string): Promise<unknown> {
  const key = `${platform.workspaceRoot}|${name}`;
  let pending = treeCache.get(key);
  if (!pending) {
    pending = (async () => {
      const at = name.lastIndexOf("@");
      const entry = await resolveTreeEntry(
        platform.workspaceRoot,
        at >= 0 ? name.slice(0, at) : name,
        at >= 0 ? name.slice(at + 1) : null,
      );
      const file = entry?.file ?? `app/${name}/tree.mjs`;
      const mod = await createModuleLoader(platform).load(file);
      return (mod as { default?: unknown }).default ?? mod;
    })();
    treeCache.set(key, pending);
  }
  return pending;
}

/** Every runnable app tree (`app/<name>/tree.mjs`) as a callable tree tool, plus its guide. */
async function buildAppTreeTools(
  platform: Platform,
): Promise<{ tools: Record<string, unknown>; guides: Map<string, string> }> {
  const apps = await listAppTrees(platform.workspaceRoot).catch(() => []);
  const tools: Record<string, unknown> = {};
  const guides = new Map<string, string>();
  for (const app of apps) {
    if (app.guide && app.guide.trim()) guides.set(app.name, app.guide);
    // `tree` (not a plain execute) is what makes the engine run the app as a
    // tree tool: it logs tree_enter/tree_exit, tags emits to the app, and lets
    // a Human() inside pause/resume in place. A plain tool here made every app
    // emit look like the trunk's, so an app tile showed no bubbles.
    tools[app.name] = {
      description: app.description,
      parameters: { type: "object", properties: { input: { type: "string", description: "Input seeded into the tree as 'input'." } }, required: ["input"] },
      tree: app.name,
      guide: app.guide ?? "",
    };
  }
  return { tools, guides };
}

async function handleRun(opts: RunOptions): Promise<void> {
  const task = opts.task ?? "";
  const storage = opts.storage ?? "browser";
  const server = opts.server ?? "";
  const platform = await getPlatform(storage, server);
  await ready;

  // The tree catalog (resolveTreeEntry) reads through the node:fs shim, so the
  // shim must follow the selected backend *before* a pattern name is resolved.
  // A fresh worker starts pointed at OPFS; resolving first made the first turn
  // after a reload look for `patterns/context_manager.mjs` in the wrong place.
  setActiveFs(platform.fs);

  // The picker sends a logical name ("context_manager", "name@v3"); boot sends
  // a path ("patterns/trunk.mjs"). Session identity uses the resolved file so
  // both shapes share one conversation.
  const patternPath = await resolvePatternPath(platform, opts.pattern);

  // One continuation per chat session: two chats on the same tree must not
  // share a pause/checkpoint.
  const chatKey = opts.chatKey || "local";
  const sessionKey = `${storage}|${server}|${chatKey}|${patternPath}`;
  const session = getSession(sessionKey, platform);
  session.currentId = opts.id;
  runs.set(opts.id, session);

  await ensureIndex(platform, sessionKey);

  const registry = await (async (): Promise<ModelRegistry> => {
    // Served by the admin: its models.json is the single source (and the
    // /api/llm proxy supplies the network + keys). Settings JSON is only a
    // standalone fallback now.
    if (opts.serverModels) {
      const fromServer = await loadServerModels(opts.env ?? {});
      if (fromServer) return fromServer;
    }
    if (opts.modelsJson && opts.modelsJson.trim()) {
      try {
        return parseModels(opts.modelsJson, opts.env ?? {});
      } catch {
        /* fall through to models.json */
      }
    }
    return loadBrowserModels(platform, opts.env ?? {});
  })();
  const models =
    Object.keys(registry).length > 0
      ? applyModelOverrides(registry, opts.modelOverrides)
      : { default: { model: "mock", handler: async () => ({ content: `mock: ${task}` }) } };

  const onEmit = (value: unknown): void => post({ id: opts.id, type: "emit", value });
  const toolsMap: Record<string, unknown> = {
    ...browserTools(platform, { remote: opts.remote ?? "", flushLog: () => session.logger.flush() }),
  };
  const tools = withStubs(toolsMap);
  const appTree = await buildAppTreeTools(platform);
  Object.assign(toolsMap, appTree.tools);

  // Host + app guidance comes from the shared module, so the browser and Node
  // targets teach the model the same tool etiquette. Stubs are excluded so a
  // guide never points at a tool this target only stands in for.
  const guide = assembleGuides({
    hostGuides: HOST_GUIDES,
    appGuides: appTree.guides,
    inScope: Object.keys(toolsMap).filter((name) => !STUB_TOOL_NAMES.includes(name)),
  });

  const runtime = {
    models,
    tools,
    logger: session.logger,
    loadTree: (name: string) => loadTreeRef(platform, name),
    onEmit,
  };

  let res: { result?: unknown; status?: string; continuation?: string; humanSlot?: unknown };
  if (session.continuation) {
    res = (await withModelContext(models, () =>
      resume(session.continuation, {
        ...runtime,
        memory: { guide },
        humanInput: task,
      }),
    )) as typeof res;
  } else {
    const pattern = await loadPattern(platform, patternPath);
    res = (await withModelContext(models, () =>
      knit(pattern, { ...runtime, memory: { guide } }),
    )) as typeof res;
    if (res.status === "waiting") {
      if (task) {
        res = (await withModelContext(models, () =>
          resume(res.continuation!, { ...runtime, humanInput: task }),
        )) as typeof res;
      } else {
        session.continuation = res.continuation!;
        runs.delete(opts.id);
        post({ id: opts.id, type: "result", result: { status: "waiting", humanSlot: res.humanSlot }, eventCount: 0 });
        void session.logger.flush();
        return;
      }
    }
  }

  session.continuation = res.status === "waiting" ? (res.continuation ?? "") : "";
  post({
    id: opts.id,
    type: "result",
    result: res.result ?? { status: res.status ?? "done" },
    eventCount: session.logger.events.length,
  });
  void session.logger.flush();
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as (RunOptions & { type: string }) | LogMessage;
  if (msg.type === "log") {
    await handleLog(msg as LogMessage);
    return;
  }
  if (msg.type !== "run") return;
  try {
    await handleRun(msg as RunOptions);
  } catch (err) {
    post({
      id: msg.id,
      type: "error",
      error: `agent run failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};

// ── session log RPC ─────────────────────────────────────────────────────
// The main-thread local backend asks the worker (which owns the platform and
// therefore the run log) to read/write sessions, so every access shares the
// logger's serial queue and connection.

interface LogMessage {
  id: number;
  type: "log";
  op: string;
  payload?: Record<string, unknown>;
  storage?: "browser" | "desktop";
  server?: string;
}

function describeKey(key: string): string {
  // Same labels as src/admin.ts's describeForeignKey: a shared desktop log can
  // hold Telegram keys as well as web ones.
  if (key.startsWith("web:")) return `web ${key.slice(4)} (no history)`;
  const m = key.match(/^(-?\d+):(\d+)(?::([0-9a-f]{1,12}))?$/);
  if (!m) return key;
  const [, chat, thread, id] = m;
  const where = thread === "0" ? " (general)" : ` · topic ${thread}`;
  return `telegram · chat ${chat}${where}${id ? ` · session ${id}` : ""}`;
}

async function handleLog(msg: LogMessage): Promise<void> {
  const p = msg.payload ?? {};
  try {
    const platform = await getPlatform(msg.storage ?? "browser", msg.server ?? "");
    await ready;
    let result: unknown;

    switch (msg.op) {
      case "listSessions":
        result = await listSessions(platform, describeKey);
        break;
      case "turns":
        result = await getTurns(platform, String(p.key ?? ""), { withEvents: p.withEvents === true });
        break;
      case "turnEnd": {
        // Flush the engine events first, then write the marker with the run's
        // real seq bounds. The run session is the one that logged them.
        const session = typeof p.run === "number" ? runs.get(p.run) : undefined;
        if (session) await session.logger.flush();
        const marker = p.marker as TurnMarker;
        if (!marker || typeof marker.key !== "string") throw new Error("turnEnd needs a marker");
        await writeTurnEnd(session?.platform ?? platform, marker);
        if (session && typeof p.run === "number") runs.delete(p.run);
        result = { ok: true };
        break;
      }
      case "label":
        await writeLabel(platform, String(p.key ?? ""), String(p.label ?? ""));
        result = { ok: true };
        break;
      case "delete":
        await writeDelete(platform, String(p.key ?? ""));
        result = { ok: true };
        break;
      case "hasSession":
        result = await hasSession(platform, String(p.key ?? ""));
        break;
      case "turnCount":
        result = await turnCount(platform, String(p.key ?? ""));
        break;
      case "labelOf":
        result = await labelOf(platform, String(p.key ?? ""));
        break;
      case "hasLabelPin":
        result = await hasLabelPin(platform, String(p.key ?? ""));
        break;
      case "lastAwaiting":
        result = await lastAwaiting(platform, String(p.key ?? ""));
        break;
      default:
        throw new Error(`unknown log op: ${msg.op}`);
    }
    post({ id: msg.id, type: "log-result", ok: true, result });
  } catch (err) {
    post({
      id: msg.id,
      type: "log-result",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
