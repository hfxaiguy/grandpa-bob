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
import { browserTools } from "./browser-tools";
import { assembleGuides, HOST_GUIDES } from "../../../src/tool-guides";
import { createMemoryLogger, type MemoryLogger } from "./logger";
import { createModuleLoader } from "./module-loader";
import { loadBrowserModels } from "./models";

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

interface RunOptions {
  id: number;
  task?: string;
  env?: Record<string, string>;
  pattern?: string;
  remote?: string;
  storage?: "browser" | "desktop";
  server?: string;
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
  const mod = await createModuleLoader(platform).load(patternPath);
  return mod.default ?? mod.pattern;
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

  const tools = browserTools(platform, { remote: opts.remote ?? "" });
  // Host-tool guidance comes from the shared module, so the browser and Node
  // targets teach the model the same tool etiquette.
  const guide = assembleGuides({ hostGuides: HOST_GUIDES, inScope: Object.keys(tools) });
  const registry = await loadBrowserModels(platform, opts.env ?? {});
  const models =
    Object.keys(registry).length > 0
      ? registry
      : { default: { model: "mock", handler: async () => ({ content: `mock: ${task}` }) } };

  const runtime = {
    models,
    tools,
    logger: session.logger,
    loadTree: async () => null,
    onEmit: (value: unknown) => post({ id: opts.id, type: "emit", value }),
  };

  let res: { result?: unknown; status?: string; continuation?: string; humanSlot?: unknown };
  if (session.continuation) {
    res = (await resume(session.continuation, { ...runtime, humanInput: task })) as typeof res;
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
