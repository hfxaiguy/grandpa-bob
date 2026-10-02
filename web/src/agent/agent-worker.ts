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

  // Deterministic tree (no model round-trips): exercise the file, SQL and
  // command tools through Call, then return their results. A real agent tree
  // (loaded from OPFS) plugs in here once the module loader lands.
  const pattern = Tree(
    name("worker_demo"),
    Tools("read_file", "sql_write", "sql_query", "list_files"),
    Call("read", "read_file", { path: "notes/renamed.txt" }),
    Call("create", "sql_write", { query: "CREATE TABLE IF NOT EXISTS t(a INTEGER)", path: "worker.db" }),
    Call("ins", "sql_write", { query: "INSERT INTO t VALUES (42)", path: "worker.db" }),
    Call("rows", "sql_query", { query: "SELECT a FROM t", path: "worker.db" }),
    Return((m: { branch: Record<string, unknown> }) => ({
      read: m.branch.read,
      create: m.branch.create,
      insert: m.branch.ins,
      rows: m.branch.rows,
    })),
  );

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
