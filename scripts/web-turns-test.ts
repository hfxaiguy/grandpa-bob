/**
 * Web chat session persistence + explicit selection — logs/web-turns.json.
 *
 *   1. First boot (no disk state) auto-opens a fresh session; a completed
 *      turn persists under its `web:<id>` key with label, and prompt
 *      messages are stripped from the on-disk copy.
 *   2. Restart: NOTHING is active. /api/chat is refused (409) until the
 *      user explicitly resumes a session; resume restores its history
 *      (interrupted "running" turns dropped) and enables chat.
 *   3. "New chat" opens a second, empty session; the old history survives.
 *   4. clear wipes the active session's history but keeps it active.
 *   5. delete removes a session from disk.
 *
 * Mock model handler, no network. Run: npm run test:webturns
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

async function waitDone(port: number, turnId: string) {
  for (let i = 0; i < 100; i++) {
    const s = await api(port, "GET", "/api/session");
    const t = (s.json.turns || []).find((x: any) => x.turnId === turnId);
    if (t && t.status !== "running") return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("turn never finished");
}

let restarts = 0;
async function boot() {
  const mod = await import(`../src/admin.ts${restarts++ ? `?restart=${restarts}` : ""}`);
  const port = await freePort();
  const server = mod.startAdmin({ port, workspaceDir: ws, agent: mockAgent() });
  await events.once(server, "listening");
  return { port, server };
}

// ── 1. first boot: auto new session, chat works, v2 store persisted ──
let firstKey = "";
{
  const { port, server } = await boot();
  const s0 = await api(port, "GET", "/api/session");
  assert.ok(s0.json.active, "first boot opens a session automatically");
  firstKey = s0.json.active;
  assert.match(firstKey, /^web:/);

  const { status, json } = await api(port, "POST", "/api/chat", { text: "hi" });
  assert.equal(status, 200);
  const done = await waitDone(port, json.turnId);
  assert.equal(done.status, "done");
  assert.equal(done.output, "echo:hi");

  const onDisk = JSON.parse(await fs.readFile(turnsFile, "utf8"));
  assert.equal(typeof onDisk, "object");
  assert.ok(!Array.isArray(onDisk), "v2 store is a per-session map");
  const sess = onDisk[firstKey];
  assert.equal(sess.turns.length, 1);
  assert.equal(sess.label, "hi", "label derived from first message");

  const liveEvents = sess.turns[0].events;
  const onDiskStr = JSON.stringify(onDisk);
  const turns = (await api(port, "GET", "/api/turns")).json.turns;
  assert.ok(
    JSON.stringify(turns[0].events).includes("SECRET-PROMPT"),
    "live /api/turns keeps raw prompt messages",
  );
  assert.ok(!onDiskStr.includes("SECRET-PROMPT"), "persisted copy strips prompt messages");
  assert.equal(liveEvents[0].kind, "llm_call", "event metadata kept");
  server.close();
  console.log("1. first boot: auto-session, turn persisted (prompts stripped)");
}

// ── 2. restart: nothing active; explicit resume required and restores ──
{
  // inject a "running" ghost turn (simulates a crash mid-turn)
  const onDisk = JSON.parse(await fs.readFile(turnsFile, "utf8"));
  onDisk[firstKey].turns.push({
    turnId: "ghost", input: "interrupted", startedAt: Date.now(),
    endedAt: null, status: "running", error: null, output: null, events: [],
  });
  await fs.writeFile(turnsFile, JSON.stringify(onDisk));

  const { port, server } = await boot(); // fresh module state = restart
  const s1 = await api(port, "GET", "/api/session");
  assert.equal(s1.json.active, null, "no session is armed automatically after restart");
  assert.equal(s1.json.sessions.length, 1);
  assert.equal(s1.json.sessions[0].key, firstKey);
  assert.equal(s1.json.sessions[0].pattern, "trunk", "session records its tree name");

  const refused = await api(port, "POST", "/api/chat", { text: "not yet" });
  assert.equal(refused.status, 409, "chat refused until a session is selected");

  const sel = await api(port, "POST", "/api/session", { key: firstKey });
  assert.equal(sel.status, 200);
  assert.equal(sel.json.active, firstKey);
  assert.equal(sel.json.turns.length, 1, "interrupted turn dropped, history restored");
  assert.equal(sel.json.turns[0].input, "hi");

  const ok = await api(port, "POST", "/api/chat", { text: "again" });
  assert.equal(ok.status, 200, "chat works after explicit resume");
  await waitDone(port, ok.json.turnId);
  server.close();
  console.log("2. restart: refuses chat, explicit resume restores history");
}

// ── 3. new chat: second session, first one's history intact ──
{
  const { port, server } = await boot();
  const s = await api(port, "GET", "/api/session");
  assert.equal(s.json.sessions.length, 1);
  const n = await api(port, "POST", "/api/session", { new: true });
  assert.equal(n.status, 200);
  assert.notEqual(n.json.active, firstKey);
  assert.deepEqual(n.json.turns, []);
  const { json } = await api(port, "POST", "/api/chat", { text: "brand new" });
  await waitDone(port, json.turnId);
  const list = (await api(port, "GET", "/api/session")).json.sessions;
  assert.equal(list.length, 2, "both sessions recorded");
  const old = list.find((x: any) => x.key === firstKey);
  assert.ok(old.turns >= 2, "old session history untouched");
  server.close();
  console.log("3. new chat: independent session, history preserved");

  // ── 4. clear wipes ACTIVE session only ──
  const { port: p4, server: srv4 } = await boot();
  await api(p4, "POST", "/api/session", { key: firstKey });
  const c = await api(p4, "POST", "/api/clear");
  assert.equal(c.json.active, firstKey, "clear keeps the session active");
  const after = await api(p4, "GET", "/api/session");
  assert.equal(after.json.turns.length, 0, "active history cleared");
  const other = after.json.sessions.find((x: any) => x.key !== firstKey);
  assert.ok(other.turns > 0, "other sessions unaffected");

  // ── 5. delete removes from disk ──
  const del = await api(p4, "POST", "/api/session", { delete: other.key });
  assert.equal(del.status, 200);
  assert.ok(!(await api(p4, "GET", "/api/session")).json.sessions.find((x: any) => x.key === other.key));
  const disk = JSON.parse(await fs.readFile(turnsFile, "utf8"));
  assert.ok(!(other.key in disk), "deleted session gone from web-turns.json");
  srv4.close();
  console.log("4+5. clear scoped to active; delete purges from disk");
}

console.log("web-turns-test: all assertions passed");
process.exit(0);
