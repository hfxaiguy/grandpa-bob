/**
 * Admin web sessions — the multi-session lifecycle.
 *
 *   1. An empty, unlabeled "new chat" has NO markers (nothing on disk), and
 *      clicking "new chat" again reuses it instead of minting another shell.
 *   2. Multiple local sessions are independent: each keeps its own turn
 *      history and its own continuation (the tree state keyed by session).
 *   3. The 10-session cap is a display bound, enforced on every read; older
 *      sessions are NOT destroyed (their markers stay in the log).
 *   4. After a restart, only used sessions are offered in the picker.
 *
 * State lives in the log DB as host markers (src/web-log.ts). Mock agent +
 * real admin HTTP API, no network. Run: npm run test:admin-sessions
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { DatabaseSync } from "node:sqlite";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-admin-sessions-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

// Shared observations across the mock agents (survive a simulated restart).
const usedKeys: string[] = [];
const cleared: string[] = [];
const continuations = new Set<string>();

const mockAgent = () =>
  ({
    // No Telegram conversations — keep the picker purely local.
    sessionKeys: () => [],
    sessionMeta: () => [],
    hasContinuation: (k: string) => continuations.has(k),
    consumesInputDirectly: async () => false,
    clear(k: string) {
      cleared.push(k);
      continuations.delete(k);
    },
    async run(key: string, content: unknown, onEmit?: (v: unknown) => void) {
      usedKeys.push(key);
      continuations.add(key);
      onEmit?.({ text: "echo:" + String(content) });
      return { status: "waiting", continuation: "mock:" + key };
    },
  }) as any;

let restarts = 0;
async function boot() {
  const mod = await import(`../src/admin.ts${restarts++ ? `?restart=${restarts}` : ""}`);
  const port = await freePort();
  const server = mod.startAdmin({ port, workspaceDir: ws, agent: mockAgent() });
  await events.once(server, "listening");
  return { port, server, mod };
}

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
  for (let i = 0; i < 200; i++) {
    const s = await api(port, "GET", "/api/session");
    const t = (s.json.turns || []).find((x: any) => x.turnId === turnId);
    if (t && t.status !== "running") return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("turn never finished");
}

/** Host markers for a key (the session's persisted state). */
function markers(key: string) {
  const db = new DatabaseSync(path.join(ws, "logs", "grandma-kat.db"), { readOnly: true });
  let rows: { kind: string; content: string }[] = [];
  try {
    rows = db.prepare("SELECT kind, content FROM calls WHERE run_id = ? ORDER BY seq").all(key) as typeof rows;
  } catch {
    // table may not exist yet on the very first boot read
  }
  db.close();
  return rows;
}

const localSessions = (json: any) => (json.sessions || []).filter((s: any) => !s.remote);

// ── 1. empty shell has no markers; new chat reuses it ──
{
  const { port, server } = await boot();
  const s0 = await api(port, "GET", "/api/session");
  assert.ok(s0.json.active, "first boot opens a session");
  const firstKey = s0.json.active;
  assert.match(firstKey, /^web:/);

  // The auto-opened session is empty + unlabeled: it must leave no markers.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(markers(firstKey), [], "an empty, unlabeled session writes nothing");

  // Clicking "new chat" again reuses the empty active session (no shell minted).
  const again = await api(port, "POST", "/api/session", { new: true });
  assert.equal(again.json.active, firstKey, "an unused new chat is reused, not duplicated");
  assert.deepEqual(markers(firstKey), [], "still nothing written while it stays empty");

  // Using it labels it and it persists.
  const chat = await api(port, "POST", "/api/chat", { text: "hello" });
  await waitDone(port, chat.json.turnId);
  const after = markers(firstKey);
  assert.equal(after.filter((m) => m.kind === "web_turn_end").length, 1, "a used session persists a turn marker");
  const label = (await api(port, "GET", "/api/session")).json.label;
  assert.equal(label, "hello");
  server.close();
  console.log("1. empty shell writes nothing; new chat reuses it");
}

// ── 2. independent sessions: own history, own continuation ──
{
  const { port, server } = await boot();
  // A new chat mints a second session (the restored one is already used).
  const n = await api(port, "POST", "/api/session", { new: true });
  const secondKey = n.json.active;
  assert.ok(secondKey, "a new chat mints a session when none is empty");
  const chat = await api(port, "POST", "/api/chat", { text: "second" });
  await waitDone(port, chat.json.turnId);

  // Active is the second session; its history is its own.
  const active = await api(port, "GET", "/api/session");
  assert.equal(active.json.turns.length, 1);
  assert.equal(active.json.turns[0].input, "second");

  const local = localSessions(active.json);
  assert.equal(local.length, 2, "two independent local sessions");
  const hello = local.find((s: any) => s.label === "hello");
  const second = local.find((s: any) => s.label === "second");
  assert.ok(hello && second, "both sessions are listed with their labels");

  // Resume the first session: its own history, and its own continuation.
  const resumeHello = await api(port, "POST", "/api/session", { key: hello.key });
  assert.equal(resumeHello.json.active, hello.key);
  assert.equal(resumeHello.json.turns[0].input, "hello", "the first session's history is its own");
  const chatAgain = await api(port, "POST", "/api/chat", { text: "again" });
  await waitDone(port, chatAgain.json.turnId);
  assert.equal(usedKeys.at(-1), hello.key, "the resumed session ran under its own key");
  assert.ok(continuations.has(hello.key) && continuations.has(second.key), "each session keeps its own continuation");

  // The other session's history is untouched.
  const back = await api(port, "POST", "/api/session", { key: second.key });
  assert.equal(back.json.turns.length, 1, "the other session's history is separate");
  assert.equal(back.json.turns[0].input, "second");
  server.close();
  console.log("2. multiple sessions: independent history and continuations");
}

// ── 3. the cap is a display bound; older sessions are not destroyed ──
{
  const clearedBefore = cleared.length;
  const { port, server } = await boot();
  // Grow past the cap; each new chat is used so it is a real session.
  const firstOfCap = await api(port, "GET", "/api/session");
  const oldestKey = firstOfCap.json.sessions.find((s: any) => s.label === "second")?.key
    ?? firstOfCap.json.sessions[0]?.key;
  for (let i = 0; i < 12; i++) {
    await api(port, "POST", "/api/session", { new: true });
    const chat = await api(port, "POST", "/api/chat", { text: `cap-${i}` });
    await waitDone(port, chat.json.turnId);
  }
  const s = await api(port, "GET", "/api/session");
  const local = localSessions(s.json);
  assert.ok(local.length <= 10, `local sessions stay capped (got ${local.length})`);
  assert.equal(cleared.length, clearedBefore, "the cap never destroys a session's tree state");
  assert.ok(local.some((x: any) => x.key === s.json.active), "the active session is always listed");
  assert.ok(oldestKey && markers(oldestKey).length > 0, "a beyond-cap session keeps its markers in the log");
  server.close();
  console.log("3. cap is a display bound; older sessions stay in the log");
}

// ── 4. restart: only used sessions are offered ──
{
  const { port, server } = await boot();
  const s = await api(port, "GET", "/api/session");
  assert.equal(s.json.active, null, "no session auto-resumes after a restart");
  const local = localSessions(s.json);
  assert.ok(local.every((x: any) => x.turns > 0 && x.label), "only used, labeled sessions are offered");
  assert.ok(local.length <= 10, "the cap survives a restart");
  server.close();
  console.log("4. restart offers only used sessions");
}

console.log("admin-sessions-test: all assertions passed");
process.exit(0);
