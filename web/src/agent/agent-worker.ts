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
import { createMemoryLogger, type MemoryLogger } from "./logger";
import { createModuleLoader } from "./module-loader";
import { loadBrowserModels } from "./models";
import { parseModels, type ModelRegistry } from "../../../src/model-config";

const ready = initSqlite();
const platforms = new Map<string, Platform>();

function getPlatform(storage: string, server: string): Platform {
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
  modelsJson?: string;
}

interface Session {
  logger: MemoryLogger;
  continuation: string;
  currentId: number;
}

const sessions = new Map<string, Session>();

function getSession(key: string): Session {
  let session = sessions.get(key);
  if (!session) {
    const created: Session = { logger: null as unknown as MemoryLogger, continuation: "", currentId: 0 };
    created.logger = createMemoryLogger((event) => post({ id: created.currentId, type: "event", event }));
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
      `cannot load pattern ${patternPath}: ${err instanceof Error ? err.message : String(err)} ` +
        "(is the workspace seeded? run `npm run make-seed`, or use Desktop storage)",
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

/** Every runnable app tree (`app/<name>/tree.mjs`) as a callable tool, plus its guide. */
async function buildAppTreeTools(
  platform: Platform,
  ctx: { models: unknown; tools: unknown; logger: MemoryLogger; onEmit: (value: unknown) => void },
): Promise<{ tools: Record<string, unknown>; guides: Map<string, string> }> {
  const apps = await listAppTrees(platform.workspaceRoot).catch(() => []);
  const tools: Record<string, unknown> = {};
  const guides = new Map<string, string>();
  for (const app of apps) {
    if (app.guide && app.guide.trim()) guides.set(app.name, app.guide);
    tools[app.name] = {
      description: app.description,
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
      execute: async (args: Record<string, unknown>) => {
        try {
          const def = await loadTreeRef(platform, app.name);
          const res = (await knit(def, {
            models: ctx.models as ModelRegistry,
            tools: ctx.tools as Record<string, unknown>,
            logger: ctx.logger,
            loadTree: (name: string) => loadTreeRef(platform, name),
            memory: { input: String(args.input ?? "") },
            onEmit: ctx.onEmit,
          })) as { result?: unknown; status?: string };
          const text =
            res.result != null
              ? typeof res.result === "string"
                ? res.result
                : JSON.stringify(res.result)
              : res.status === "waiting"
                ? "the app tree paused for human input"
                : "";
          return { handled: true, text };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    };
  }
  return { tools, guides };
}

async function handleRun(opts: RunOptions): Promise<void> {
  const task = opts.task ?? "";
  const storage = opts.storage ?? "browser";
  const server = opts.server ?? "";
  const patternPath = opts.pattern ?? "patterns/agent_demo.mjs";
  const platform = getPlatform(storage, server);
  await ready;

  const session = getSession(`${storage}|${server}|${patternPath}`);
  session.currentId = opts.id;

  setActiveFs(platform.fs);
  await ensureIndex(platform, `${storage}|${server}`);

  const registry = await (async (): Promise<ModelRegistry> => {
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
      ? registry
      : { default: { model: "mock", handler: async () => ({ content: `mock: ${task}` }) } };

  const onEmit = (value: unknown): void => post({ id: opts.id, type: "emit", value });
  const toolsMap: Record<string, unknown> = { ...browserTools(platform, { remote: opts.remote ?? "" }) };
  const tools = withStubs(toolsMap);
  const appTree = await buildAppTreeTools(platform, { models, tools, logger: session.logger, onEmit });
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
    res = (await resume(session.continuation, {
      ...runtime,
      memory: { guide },
      humanInput: task,
    })) as typeof res;
  } else {
    const pattern = await loadPattern(platform, patternPath);
    res = (await knit(pattern, { ...runtime, memory: { guide } })) as typeof res;
    if (res.status === "waiting") {
      if (task) res = (await resume(res.continuation!, { ...runtime, humanInput: task })) as typeof res;
      else {
        session.continuation = res.continuation!;
        post({ id: opts.id, type: "result", result: { status: "waiting", humanSlot: res.humanSlot }, eventCount: 0 });
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
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as RunOptions & { type: string };
  if (msg.type !== "run") return;
  try {
    await handleRun(msg);
  } catch (err) {
    post({
      id: msg.id,
      type: "error",
      error: `agent run failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};
