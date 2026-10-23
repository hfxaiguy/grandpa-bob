/**
 * Web chat sessions — state lives in the log DB as host markers
 * (src/web-log.ts). There is no web-turns.json anymore.
 *
 *   1. First boot (no state) auto-opens a fresh session; a completed turn is
 *      persisted as a `web_turn_end` marker with label derived from the first
 *      message; /api/turns strips prompt messages.
 *   2. Restart: NOTHING is active. /api/chat is refused (409) until the user
 *      explicitly resumes a session; resume restores its history. A turn
 *      whose run wrote events but no marker (a crash) leaves no phantom.
 *   3. "New chat" opens a second session; the old history survives.
 *   4. clear starts a NEW session; the left conversation stays in the picker.
 *   5. delete tombstones the session (gone from the picker) but keeps its
 *      trace in the log.
 *   6. auto-follow: the webui pins itself to the live telegram chat; mirrored
 *      turns land as markers with their event windows.
 *   7. migration: a legacy web-turns.json is imported once (turns matched to
 *      their run get real event bounds), then renamed away and never written.
 *
 * The mock agent writes engine-like rows into logs/grandma-kat.db, because
 * that is what the real engine does — derivation reads them back.
 * Mock model handler, no network. Run: npm run test:webturns
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { DatabaseSync } from "node:sqlite";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-webturns-"));
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

/** Engine-like writes into the workspace's log DB. */
function engine(wsDir: string) {
  const db = new DatabaseSync(path.join(wsDir, "logs", "grandma-kat.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS calls (
    run_id TEXT NOT NULL, definition_id TEXT NOT NULL,
    seq INTEGER PRIMARY KEY AUTOINCREMENT, branch_path TEXT, iteration INTEGER,
    scope_id INTEGER, kind TEXT NOT NULL, content TEXT)`);
  const stmt = db.prepare(
    "INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, 'test', ?, ?, ?, ?, ?)");
  return {
    log(runId: string, e: Record<string, unknown>) {
      stmt.run(runId, (e.branch_path as string) ?? null, (e.iteration as number) ?? 1, (e.scope_id as number) ?? null, String(e.kind), JSON.stringify(e.content ?? null));
    },
    close() { db.close(); },
  };
}

const usedKeys: string[] = [];
let runSeq = 0;
const mockAgent = (wsDir: string, continuations: Map<string, string> = new Map()) => {
  const eng = engine(wsDir);
  return {
    cache: eng,
    sessionKeys: () => ["12345:0", "999:42"],
    sessionMeta: () => [],
    sessionContinuationIds: () => continuations,
    hasContinuation: () => true,
    consumesInputDirectly: async () => true,
    modelSlots: () => [],
    clear() {},
    async run(key: string, content: unknown, onEmit: (v: unknown) => void, opts?: any) {
      usedKeys.push(key);
      const runId = `run-${++runSeq}`;
      const raw = [
        { run_id: runId, kind: "llm_call", branch_path: "relay", iteration: 1, content: { model: "cheap", messages: [{ role: "system", content: "SECRET-PROMPT" }] } },
        { run_id: runId, kind: "emit", branch_path: "relay", iteration: 1, content: { child: "reply", value: { text: "echo:" + String(content) } } },
      ];
      for (const e of raw) {
        eng.log(runId, e);
        opts?.onEvent?.(e);
      }
      onEmit({ text: "echo:" + String(content) });
      return { status: "waiting", continuation: `${runId}:1`, runId };
    },
  } as any;
};

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

function markerRows(wsDir: string, key: string) {
  const db = new DatabaseSync(path.join(wsDir, "logs", "grandma-kat.db"), { readOnly: true });
  const rows = db.prepare("SELECT kind, content FROM calls WHERE run_id = ? ORDER BY seq").all(key) as { kind: string; content: string }[];
  db.close();
  return rows;
}

let restarts = 0;
async function boot(opts?: { wsDir?: string; agent?: any }) {
  const mod = await import(`../src/admin.ts${restarts++ ? `?restart=${restarts}` : ""}`);
  const port = await freePort();
  const agent = opts?.agent ?? mockAgent(opts?.wsDir ?? ws);
  const server = mod.startAdmin({
    port,
    workspaceDir: opts?.wsDir ?? ws,
    agent,
  });
  await events.once(server, "listening");
  return { port, server, mod, agent };
}

const turnsFile = path.join(ws, "logs", "web-turns.json");

// ── 1. first boot: auto new session, chat works, turn persisted as marker ──
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

  const markers = markerRows(ws, firstKey);
  const turnEnds = markers.filter((m) => m.kind === "web_turn_end");
  assert.equal(turnEnds.length, 1, "the turn is one marker row");
  assert.ok(!JSON.stringify(turnEnds).includes("SECRET-PROMPT"), "markers carry UI state, never prompt text");

  const label = (await api(port, "GET", "/api/session")).json.label;
  assert.equal(label, "hi", "label derived from first message");

  const turns = (await api(port, "GET", "/api/turns")).json.turns;
  assert.ok(!JSON.stringify(turns[0].events).includes("SECRET-PROMPT"),
    "live /api/turns no longer ships raw prompt messages");
  assert.ok(typeof (turns[0].events.find((e: any) => e.kind === "llm_call")?.content as { messages?: unknown })?.messages === "object",
    "a messages summary ({ count, chars }) is kept");
  await assert.rejects(fs.stat(turnsFile), "no web-turns.json is written");
  server.close();
  console.log("1. first boot: auto-session, turn marker persisted, prompts stripped");
}

// ── 2. restart: nothing active; explicit resume restores history ──────
{
  // A crashed turn: events in the log, no turn marker. It must not appear.
  const eng = engine(ws);
  eng.log("run-crashed", { kind: "llm_call", branch_path: "relay", iteration: 1, content: { model: "cheap", messages: [{ role: "user", content: "ghost" }] } });
  eng.close();

  const { port, server } = await boot(); // fresh module state = restart
  const s1 = await api(port, "GET", "/api/session");
  assert.equal(s1.json.active, null, "no session is armed automatically after restart");
  const local1 = s1.json.sessions.filter((x: any) => !x.remote);
  assert.equal(local1.length, 1);
  assert.equal(local1[0].key, firstKey);
  assert.equal(local1[0].label, "hi", "label survives via the marker");
  // The agent's live Telegram conversations surface as followable entries.
  const remote1 = s1.json.sessions.filter((x: any) => x.remote);
  assert.equal(remote1.length, 2, "telegram sessions offered for follow");
  assert.match(remote1.find((x: any) => x.key === "12345:0").label, /chat 12345 \(general\)/);
  assert.match(remote1.find((x: any) => x.key === "999:42").label, /topic 42/);

  const refused = await api(port, "POST", "/api/chat", { text: "not yet" });
  assert.equal(refused.status, 409, "chat refused until a session is selected");

  // FOLLOW a Telegram conversation: selecting its foreign key arms it and
  // messages run under that exact key (shared with the other transport).
  const fol = await api(port, "POST", "/api/session", { key: "12345:0" });
  assert.equal(fol.status, 200, "foreign session can be selected");
  assert.equal(fol.json.active, "12345:0");
  assert.deepEqual(fol.json.turns, [], "followed session starts with an empty transcript");
  const intoTg = await api(port, "POST", "/api/chat", { text: "from web" });
  await waitDone(port, intoTg.json.turnId);
  assert.equal(usedKeys.at(-1), "12345:0", "message ran under the telegram key");
  const nowLocal = (await api(port, "GET", "/api/session")).json.sessions;
  assert.ok(nowLocal.find((x: any) => x.key === "12345:0" && !x.remote && x.turns === 1),
    "followed session adopted with its turn history");

  const sel = await api(port, "POST", "/api/session", { key: firstKey });
  assert.equal(sel.status, 200);
  assert.equal(sel.json.active, firstKey);
  assert.equal(sel.json.turns.length, 1, "history restored; the crashed run left no turn");
  assert.equal(sel.json.turns[0].input, "hi");

  const ok = await api(port, "POST", "/api/chat", { text: "again" });
  assert.equal(ok.status, 200, "chat works after explicit resume");
  await waitDone(port, ok.json.turnId);
  server.close();
  console.log("2. restart: refuses chat, explicit resume restores history");
}

// ── 3. new chat: second session, first one's history intact ───────────
let brandNewKey = "";
{
  const { port, server } = await boot();
  const n = await api(port, "POST", "/api/session", { new: true });
  assert.equal(n.status, 200);
  assert.notEqual(n.json.active, firstKey);
  assert.deepEqual(n.json.turns, []);
  brandNewKey = n.json.active;
  const { json } = await api(port, "POST", "/api/chat", { text: "brand new" });
  await waitDone(port, json.turnId);
  const list = (await api(port, "GET", "/api/session")).json.sessions;
  const old = list.find((x: any) => x.key === firstKey);
  assert.ok(old.turns >= 2, "old session history untouched");
  server.close();
  console.log("3. new chat: independent session, history preserved");

  // ── 4. clear starts a NEW session; the left one stays selectable ────
  const { port: p4, server: srv4 } = await boot();
  await api(p4, "POST", "/api/session", { key: firstKey });
  const before = (await api(p4, "GET", "/api/session")).json.turns.length;
  assert.ok(before >= 2);
  const c = await api(p4, "POST", "/api/clear");
  assert.equal(c.status, 200);
  assert.notEqual(c.json.active, firstKey, "clear starts a fresh session");
  const after = await api(p4, "GET", "/api/session");
  assert.equal(after.json.turns.length, 0, "the fresh session is empty");
  const kept = after.json.sessions.find((x: any) => x.key === firstKey);
  assert.ok(kept && kept.turns >= 2, "the left conversation keeps its history in the picker");

  // ── 5. delete tombstones the session but keeps its trace ────────────
  const beforeRows = markerRows(ws, brandNewKey).length;
  const del = await api(p4, "POST", "/api/session", { delete: brandNewKey });
  assert.equal(del.status, 200);
  const list4 = (await api(p4, "GET", "/api/session")).json.sessions;
  assert.ok(!list4.find((x: any) => x.key === brandNewKey), "deleted session gone from the picker");
  assert.ok(markerRows(ws, brandNewKey).length > beforeRows, "the tombstone is a marker too");
  srv4.close();
  console.log("4+5. clear starts fresh; delete tombstones and keeps the trace");
}

// ── 6. auto-follow: mirrored telegram turns land as markers ───────────
{
  const ws6 = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-follow-"));
  await fs.mkdir(path.join(ws6, "logs"), { recursive: true });
  const meta: { key: string; updatedAt: number }[] = [
    { key: "777:0", updatedAt: Date.now() - 5000 },
    { key: "web:stale", updatedAt: Date.now() }, // newer, but must NOT be followed
  ];
  const eng6 = engine(ws6);
  const agent6 = {
    cache: eng6,
    sessionMeta: () => meta,
    sessionKeys: () => meta.map((m) => m.key),
    sessionContinuationIds: () => new Map(),
    hasContinuation: () => true,
    consumesInputDirectly: async () => true,
    modelSlots: () => [],
    async run(key: string, content: unknown, onEmit: (v: unknown) => void, opts?: any) {
      usedKeys.push(key);
      const runId = `run-follow-${++runSeq}`;
      const raw = { run_id: runId, kind: "llm_call", branch_path: "relay", iteration: 1, content: { model: "cheap", messages: [{ role: "system", content: "TG-PROMPT" }] } };
      eng6.log(runId, raw);
      opts?.onEvent?.(raw);
      onEmit({ text: "ok" });
      return { status: "waiting", continuation: `${runId}:1` };
    },
    clear() {},
  } as any;

  const { port, server, mod } = await boot({ wsDir: ws6, agent: agent6 });
  const s = await api(port, "GET", "/api/session");
  assert.equal(s.json.follow, true, "follow defaults to ON");
  assert.equal(s.json.active, "777:0", "boot adopts the freshest TELEGRAM key");
  await api(port, "POST", "/api/chat", { text: "via web" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(usedKeys.at(-1), "777:0", "web messages run the telegram conversation");

  // Telegram-side turns mirror into the followed transcript, and a turn on
  // an unfollowed key surfaces that key as its own selectable session.
  const tgRun = `run-tg-${++runSeq}`;
  const tgEvents = [
    { run_id: tgRun, kind: "llm_call", branch_path: "relay", iteration: 1, content: { model: "cheap", messages: [{ role: "system", content: "TG-PROMPT" }] } },
    { run_id: tgRun, kind: "record", branch_path: "relay", iteration: 1, scope_id: 5, content: { child: "messages", op: "memoryUpdate", value: [1, 2, 3] } },
  ];
  mod.remoteTurnStart("777:0", "on the phone");
  for (const e of tgEvents) {
    eng6.log(tgRun, e);
    mod.remoteTurnEvent("777:0", e);
  }
  mod.remoteTurnEnd("777:0", "answer from grandma's tree");
  const sm = await api(port, "GET", "/api/session");
  const tgTurn = sm.json.turns.find((t: any) => t.input === "on the phone");
  assert.ok(tgTurn && tgTurn.output === "answer from grandma's tree", "telegram turn appears in the followed web transcript");
  assert.equal(tgTurn.status, "done");
  assert.equal(tgTurn.events.length, 2, "tree steps replayed from the log for the turn");
  assert.equal(tgTurn.events[0].kind, "llm_call");
  assert.equal(tgTurn.events[1].content.op, "memoryUpdate", "memory steps kept");
  assert.ok(!JSON.stringify(tgTurn.events[0].content).includes("TG-PROMPT"), "replayed events are sanitized");
  const tgDisk = markerRows(ws6, "777:0");
  assert.ok(!JSON.stringify(tgDisk).includes("TG-PROMPT"), "markers never carry prompt text");
  mod.remoteTurnStart("555:0", "other chat");
  mod.remoteTurnEnd("555:0", "other reply");
  const sm2 = await api(port, "GET", "/api/session");
  assert.ok(sm2.json.sessions.some((x: any) => x.key === "555:0" && x.turns === 1),
    "mirrored turn on an inactive key creates its session entry");

  // A newer telegram conversation appears → the webui jumps to it.
  meta.unshift({ key: "888:3", updatedAt: Date.now() + 1000 });
  const s2 = await api(port, "GET", "/api/session");
  assert.equal(s2.json.active, "888:3", "follow retargets to the newer conversation");
  assert.ok(s2.json.sessions.some((x: any) => x.key === "777:0"), "the old conversation remains selectable");

  // Turning follow OFF freezes the choice — new telegram activity is ignored.
  await api(port, "POST", "/api/session", { follow: false });
  meta[0] = { key: "999:9", updatedAt: Date.now() + 9999 };
  const s3 = await api(port, "GET", "/api/session");
  assert.equal(s3.json.active, "888:3", "no retargeting while off");
  const s4 = await api(port, "POST", "/api/session", { new: true });
  assert.equal(s4.json.follow, false, "new chat keeps following off");

  // Back ON → jumps to the newest.
  const s5 = await api(port, "POST", "/api/session", { follow: true });
  assert.equal(s5.json.active, "999:9", "re-enabling follow adopts the newest conversation");
  server.close();
  eng6.close();
  console.log("6. auto-follow telegram: adopt, mirror as markers, opt out, re-enable");
}

// ── 7. legacy migration: imported once, renamed away, never written ───
{
  const ws7 = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-migrate-"));
  await fs.mkdir(path.join(ws7, "logs"), { recursive: true });
  const eng7 = engine(ws7);
  // The legacy session's current run, with one delivered human input.
  eng7.log("run-legacy", { kind: "llm_call", branch_path: "relay", iteration: 1, content: { model: "cheap", messages: [{ role: "system", content: "SECRET-PROMPT" }] } });
  eng7.log("run-legacy", { kind: "human", branch_path: "relay", iteration: 1, scope_id: 1, content: { child: "input", delivered: true, value: "second message" } });
  eng7.close();
  await fs.writeFile(
    path.join(ws7, "logs", "web-turns.json"),
    JSON.stringify({
      "web:legacy": {
        label: "legacy chat",
        pattern: "trunk",
        updatedAt: Date.now(),
        turns: [
          { turnId: "t-old-1", input: "first message", inputApp: "trunk", startedAt: Date.now() - 60000, endedAt: Date.now() - 50000, status: "done", error: null, output: "old reply 1", events: [] },
          { turnId: "t-old-2", input: "second message", inputApp: "trunk", startedAt: Date.now() - 40000, endedAt: Date.now() - 30000, status: "done", error: null, output: "old reply 2", events: [] },
        ],
      },
      "8473468946:0": {
        label: "telegram · chat 8473468946 (general)",
        pattern: "",
        updatedAt: Date.now(),
        turns: [],
      },
    }),
  );
  const continuations = new Map([["web:legacy", "run-legacy"]]);
  const agent7 = mockAgent(ws7, continuations);
  const { port, server } = await boot({ wsDir: ws7, agent: agent7 });
  assert.ok(await fs.stat(path.join(ws7, "logs", "web-turns.json.migrated")), "legacy file renamed away");
  await assert.rejects(fs.stat(path.join(ws7, "logs", "web-turns.json")), "no live legacy file");

  const list = (await api(port, "GET", "/api/session")).json.sessions;
  const legacy = list.find((x: any) => x.key === "web:legacy");
  assert.equal(legacy.label, "legacy chat", "label override imported");
  assert.equal(legacy.turns, 2);
  const tg = list.find((x: any) => x.key === "8473468946:0");
  assert.match(tg.label, /telegram/, "telegram key adopted by the migration");

  const sel = await api(port, "POST", "/api/session", { key: "web:legacy" });
  assert.equal(sel.json.turns.length, 2, "turns restored");
  const second = sel.json.turns.find((t: any) => t.input === "second message");
  assert.ok(second.events.length >= 1, "the matched turn replayed its event window");
  assert.ok(!JSON.stringify(second.events).includes("SECRET-PROMPT"), "replayed events are sanitized");
  const first = sel.json.turns.find((t: any) => t.input === "first message");
  assert.equal(first.events.length, 0, "an unmatched legacy turn replays without a log window");
  assert.equal(first.output, "old reply 1", "its stored reply survives");
  server.close();
  console.log("7. legacy web-turns.json imported into the log, then gone");
}

console.log("web-turns-test: all assertions passed");
process.exit(0);
