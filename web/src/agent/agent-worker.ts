/**
 * Agent Web Worker — the browser target's "server".
 *
 * Owns the Platform (OPFS + sqlite worker), the tool registry, and the
 * grandma-kat runtime. The main thread sends run requests and receives
 * streamed events + the final result (replacing the HTTP + SSE transport).
 */
import { Tree, name, Call, Return, Tools, knit } from "grandma-kat";
import { createBrowserPlatform, initSqlite } from "../platform/browser";
import { browserTools } from "./browser-tools";
import { createMemoryLogger } from "./logger";
import { createModuleLoader } from "./module-loader";

const platform = createBrowserPlatform("/workspace");
const ready = initSqlite();

function post(message: unknown): void {
  (self as unknown as Worker).postMessage(message);
}

async function handleRun(id: number, task: string): Promise<void> {
  await ready;

  const events: unknown[] = [];
  const logger = createMemoryLogger((event) => {
    events.push(event);
    post({ id, type: "event", event });
  });
  const tools = browserTools(platform);

  // Load the real pattern from the OPFS workspace. Falls back to a built-in
  // deterministic tree when the pattern file is absent.
  let pattern: unknown;
  try {
    const mod = await createModuleLoader(platform).load("patterns/agent_demo.mjs");
    pattern = mod.default ?? mod.pattern;
  } catch {
    pattern = Tree(
      name("worker_demo"),
      Tools("read_file"),
      Call("read", "read_file", { path: "notes/renamed.txt" }),
      Return((m: { branch: Record<string, unknown> }) => ({ read: m.branch.read })),
    );
  }

  const { result } = await knit(pattern, {
    models: { default: { model: "mock", handler: async () => ({ content: task }) } },
    tools,
    logger,
    memory: {},
  });

  post({ id, type: "result", result, eventCount: events.length });
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as { id: number; type: string; task?: string };
  if (msg.type !== "run") return;
  try {
    await handleRun(msg.id, msg.task ?? "");
  } catch (err) {
    post({
      id: msg.id,
      type: "error",
      error: `agent run failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};
