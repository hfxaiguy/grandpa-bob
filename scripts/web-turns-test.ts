/**
 * Web chat turn persistence — <workspace>/logs/web-turns.json.
 *
 *   1. A completed turn is persisted after turn_end (mock agent, no LLM).
 *   2. A fresh admin "boot" (cache-busted re-import = simulated restart)
 *      restores the history via /api/turns and drops interrupted "running"
 *      turns.
 *   3. POST /api/clear empties the file.
 *
 * Run: npm run test:webturns
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-webturns-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const turnsFile = path.join(ws, "logs", "web-turns.json");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const mockAgent = () =>
  ({
    hasContinuation: () => true,
    async run(_key: string, content: unknown, onEmit: (v: unknown) => void, opts?: any) {
      opts?.onEvent?.({
        kind: "llm_call",
        branch_path: "relay",
        iteration: 1,
        content: { model: "cheap", messages: [{ role: "system", content: "SECRET-PROMPT" }] },
      });
      onEmit({ text: "echo:" + String(content) });
      return { status: "waiting", continuation: "mock:1" };
    },
    clear() {},
  }) as any;

async function api(port: number, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

// ── 1. first boot: one turn runs and is persisted ──
let restarts = 0;
const boot = async () => {
  const mod = await import(`../src/admin.ts${restarts++ ? `?restart=${restarts}` : ""}`);
  const port = await freePort();
  const server = mod.startAdmin({ port, workspaceDir: ws, agent: mockAgent() });
  await events.once(server, "listening");
  return { port, server };
}

{
  const { port, server } = await boot();
  const { status, json } = await api(port, "POST", "/api/chat", { text: "hi" });
  assert.equal(status, 200);
  const turnId = json.turnId;

  let turns: any[] = [];
  for (let i = 0; i < 50; i++) {
    turns = (await api(port, "GET", "/api/turns")).json.turns;
    if (turns.find((t) => t.turnId === turnId)?.status !== "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(turns.length, 1, "one turn recorded");
  assert.equal(turns[0].status, "done");
  assert.equal(turns[0].input, "hi");
  assert.equal(turns[0].output, "echo:hi");

  const onDisk = JSON.parse(await fs.readFile(turnsFile, "utf8"));
  assert.equal(onDisk.length, 1, "turn persisted to web-turns.json");
  assert.equal(onDisk[0].output, "echo:hi");

  // Live view keeps the raw prompt for the open session; the persisted
  // copy must not duplicate it (grandma-kat.db is the audit trail).
  const liveEvents = (await api(port, "GET", "/api/turns")).json.turns[0].events;
  assert.ok(
    JSON.stringify(liveEvents).includes("SECRET-PROMPT"),
    "live /api/turns keeps raw prompt messages",
  );
  assert.ok(
    !JSON.stringify(onDisk[0].events).includes("SECRET-PROMPT"),
    "persisted events have prompt messages stripped",
  );
  assert.equal(onDisk[0].events[0].kind, "llm_call", "event metadata kept");
  assert.equal(onDisk[0].events[0].content.model, "cheap");
  server.close();
  console.log("1. completed turn written to web-turns.json");

  // ── 2. restart restores history, drops interrupted turns ──
  onDisk.push({
    turnId: "ghost", input: "interrupted", startedAt: Date.now(),
    endedAt: null, status: "running", error: null, output: null, events: [],
  });
  await fs.writeFile(turnsFile, JSON.stringify(onDisk));

  const { port: port2, server: server2 } = await boot(); // fresh module state
  const restored = (await api(port2, "GET", "/api/turns")).json.turns;
  assert.equal(restored.length, 1, "only completed turns restored");
  assert.equal(restored[0].input, "hi");
  assert.ok(!restored.find((t: any) => t.turnId === "ghost"), "running turn dropped");
  console.log("2. restart restored history, dropped interrupted turn");

  // ── 3. clear empties the persisted file ──
  await api(port2, "POST", "/api/clear");
  assert.deepEqual(JSON.parse(await fs.readFile(turnsFile, "utf8")), []);
  assert.equal((await api(port2, "GET", "/api/turns")).json.turns.length, 0);
  server2.close();
  console.log("3. /api/clear emptied web-turns.json");
}

console.log("web-turns-test: all assertions passed");
process.exit(0);
