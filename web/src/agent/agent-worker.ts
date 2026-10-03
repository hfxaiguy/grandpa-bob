/**
 * Agent Web Worker — the browser target's "server".
 *
 * Owns the Platform (OPFS or the desktop bridge), the tool registry, and the
 * grandma-kat runtime. The main thread sends run requests and receives
 * streamed events + the final result.
 */
import { Tree, name, Call, Return, Tools, knit } from "grandma-kat";
import { createBrowserPlatform, initSqlite } from "../platform/browser";
import { createDesktopPlatform } from "../platform/desktop";
import type { Platform } from "../../../src/platform/types";
import { browserTools } from "./browser-tools";
import { createMemoryLogger } from "./logger";
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

async function handleRun(opts: RunOptions): Promise<void> {
  const task = opts.task ?? "";
  const platform = getPlatform(opts.storage ?? "browser", opts.server ?? "");
  await ready;

  const events: unknown[] = [];
  const logger = createMemoryLogger((event) => {
    events.push(event);
    post({ id: opts.id, type: "event", event });
  });
  const tools = browserTools(platform, { remote: opts.remote ?? "" });

  // Load the pattern from the active workspace; fall back to a deterministic
  // tree when it is absent.
  let pattern: unknown;
  try {
    const mod = await createModuleLoader(platform).load(opts.pattern ?? "patterns/agent_demo.mjs");
    pattern = mod.default ?? mod.pattern;
  } catch {
    pattern = Tree(
      name("worker_demo"),
      Tools("read_file"),
      Call("read", "read_file", { path: "notes/renamed.txt" }),
      Return((m: { branch: Record<string, unknown> }) => ({ read: m.branch.read })),
    );
  }

  const registry = await loadBrowserModels(platform, opts.env ?? {});
  const models =
    Object.keys(registry).length > 0
      ? registry
      : { default: { model: "mock", handler: async () => ({ content: `mock: ${task}` }) } };

  const { result } = await knit(pattern, { models, tools, logger, memory: { task } });
  post({ id: opts.id, type: "result", result, eventCount: events.length });
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
