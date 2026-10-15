/**
 * App attribution — demultiplexing one turn's stream into per-app tiles.
 *
 * A turn enters tree tools (apps); every event, emit, and memory write between
 * `tree_enter` and its matching exit belongs to that app, and a `tree_suspend`
 * marks the app that owns the human-input pause. This is what lets the tiled
 * UI route chat bubbles, memory values, and the input box to the right tile.
 *
 *   1. GET /api/apps lists the trunk plus every app/ tree in the workspace.
 *   2. A turn's events carry an `app` tag ("trunk" at top level; the app the
 *      trunk entered). A nested tree tool is one of that app's capabilities
 *      (email's `answer`, contacts' `contacts_query`) and stays with its app.
 *   3. Emits carry the app that produced them (parallel to the text).
 *   4. A turn that ends paused reports `awaiting` = the app it paused in — the
 *      app, even when the pause is inside one of its capabilities.
 *   5. Memory values are grouped per app; node paths give the indentation.
 *   6. SSE broadcasts the same tags live (turn_start/turn_end carry awaiting;
 *      event carries app).
 *
 * Mock agent + real admin HTTP API. Run: npm run test:app-attribution
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { startAdmin } from "../src/admin.js";
import { newTurnApps, tagEventApp, retagEvents } from "../src/app-attribution.js";

// ── 0. unit: the app stack walk ──
{
  const st = newTurnApps();
  assert.equal(tagEventApp(st, { kind: "llm_call" }), "trunk", "top level is trunk");
  assert.equal(tagEventApp(st, { kind: "tree_enter", content: { tool: "contacts" } }), "contacts");
  assert.equal(
    tagEventApp(st, { kind: "tree_enter", content: { tool: "contacts_query" } }),
    "contacts",
    "a capability stays with its app",
  );
  assert.equal(tagEventApp(st, { kind: "record", content: { op: "memoryUpdate" } }), "contacts", "inside the capability");
  assert.equal(
    tagEventApp(st, { kind: "tree_exit", content: { tool: "contacts_query" } }),
    "contacts",
    "the capability's exit is the app's event",
  );
  assert.equal(tagEventApp(st, { kind: "llm_call" }), "contacts", "back to the app after the capability exits");
  assert.equal(tagEventApp(st, { kind: "tree_exit", content: { tool: "contacts" } }), "contacts");
  assert.equal(tagEventApp(st, { kind: "llm_call" }), "trunk", "back to trunk");

  const st2 = newTurnApps();
  tagEventApp(st2, { kind: "tree_enter", content: { tool: "email" } });
  tagEventApp(st2, { kind: "tree_enter", content: { tool: "draft_email" } });
  assert.equal(
    tagEventApp(st2, { kind: "tree_suspend", content: { tool: "draft_email" } }),
    "email",
    "a pause inside a capability is the app's pause",
  );
  assert.equal(st2.suspended, "email", "suspend records the app, not the capability");

  const evs: { kind?: string; content?: unknown; app?: string }[] = [
    { kind: "llm_call" },
    { kind: "emit" },
    { kind: "tree_enter", content: { tool: "contacts" } },
    { kind: "emit" },
    { kind: "tree_exit", content: { tool: "contacts" } },
  ];
  const r = retagEvents(evs);
  assert.deepEqual(evs.map((e) => e.app), ["trunk", "trunk", "contacts", "contacts", "contacts"], "retag walks the stored stream");
  assert.deepEqual(r.emitApps, ["trunk", "contacts"], "emitApps recovered in order");
  console.log("0. unit: app stack walk (enter/exit/suspend + retag)");
}

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-app-attr-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
// Two app trees so /api/apps has something beyond trunk.
await fs.mkdir(path.join(ws, "app", "contacts"), { recursive: true });
await fs.writeFile(path.join(ws, "app", "contacts", "tree.mjs"), "export default {};\n");
await fs.writeFile(path.join(ws, "app", "contacts", "tree.md"), "# contacts\n\nContact manager.\n");
await fs.mkdir(path.join(ws, "app", "enrich"), { recursive: true });
await fs.writeFile(path.join(ws, "app", "enrich", "tree.mjs"), "export default {};\n");
await fs.writeFile(path.join(ws, "app", "enrich", "tree.md"), "# enrich\n\nProfile enrichment.\n");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

// Scripted turn: trunk emit → enter contacts (emit + memory) → enter a contacts
// capability `lookup` (memory + suspend). The turn ends paused; the pause is
// inside the capability but belongs to contacts.
const script = [
  { kind: "llm_call", branch_path: "0", scope_id: 1, content: { child: "trunk-prompt" } },
  { emit: "trunk says hi" },
  { kind: "tree_enter", branch_path: "0/1", scope_id: 5, content: { tool: "contacts", tree: "contacts" } },
  { kind: "record", branch_path: "0/1", scope_id: 5, content: { op: "memoryUpdate", child: "name", value: "Ada" } },
  { emit: "contacts says hi" },
  { kind: "tree_enter", branch_path: "0/1/0", scope_id: 9, content: { tool: "lookup", tree: "lookup" } },
  { kind: "record", branch_path: "0/1/0", scope_id: 9, content: { op: "memoryUpdate", child: "company", value: "Acme" } },
  { emit: "lookup needs input" },
  { kind: "tree_suspend", branch_path: "0/1/0", scope_id: 9, content: { tool: "lookup", tree: "lookup" } },
];

// A flag the mock flips to simulate a failed turn (e.g. an LLM timeout).
let failNext = false;
let runSeq = 0;

// The engine writes every event into the workspace log DB; the mock does the
// same, because the admin reads completed turns back from there (web-log.ts).
import { DatabaseSync } from "node:sqlite";
const engDb = new DatabaseSync(path.join(ws, "logs", "grandma-kat.db"));
engDb.exec("PRAGMA journal_mode = WAL");
engDb.exec(`CREATE TABLE IF NOT EXISTS calls (
  run_id TEXT NOT NULL, definition_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT, branch_path TEXT, iteration INTEGER,
  scope_id INTEGER, kind TEXT NOT NULL, content TEXT)`);
const engStmt = engDb.prepare(
  "INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, 'test', ?, ?, ?, ?, ?)");

const mockAgent = () =>
  ({
    sessionKeys: () => [],
    sessionMeta: () => [],
    hasContinuation: () => true, // skip the grow pass
    consumesInputDirectly: async () => false,
    sessionRef: () => undefined,
    pinnedVersions: () => [],
    clear() {},
    async run(_key: string, _content: unknown, onEmit?: (v: unknown) => void, opts?: { onEvent?: (e: unknown) => void }) {
      if (failNext) {
        failNext = false;
        throw new Error("LLM request timed out after 120s (mock)");
      }
      const runId = `run-attr-${++runSeq}`;
      for (const step of script) {
        if ("emit" in step) {
          onEmit?.({ text: step.emit });
        } else {
          const e = { run_id: runId, ...step } as Record<string, unknown>;
          engStmt.run(runId, (e.branch_path as string) ?? null, (e.iteration as number) ?? 1, (e.scope_id as number) ?? null, String(e.kind), JSON.stringify(e.content ?? null));
          opts?.onEvent?.(e);
        }
      }
      return { status: "waiting", continuation: "mock" };
    },
    modelSlots: () => [],
    sessionModel: () => undefined,
    sessionModelMap: () => ({}),
  }) as any;

const port = await freePort();
const server = startAdmin({ port, workspaceDir: ws, projectDir: ws, envPath: path.join(ws, "absent.env"), agent: mockAgent() });
await events.once(server, "listening");

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

// ── 1. /api/apps = trunk + every app/ tree ──
{
  const r = await api("GET", "/api/apps");
  assert.equal(r.status, 200);
  const names = r.json.apps.map((a: any) => a.name);
  assert.deepEqual(names, ["trunk", "contacts", "enrich"], "trunk first, then app trees sorted");
  assert.equal(r.json.apps.find((a: any) => a.name === "contacts").description, "Contact manager.");
  console.log("1. /api/apps lists trunk + app trees");
}

// Open the SSE stream before the turn so we capture the live broadcast.
const sse: any[] = [];
const sseReq = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
  res.setEncoding("utf8");
  let buf = "";
  res.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try { sse.push(JSON.parse(line.slice(6))); } catch { /* ignore */ }
      }
    }
  });
});
await new Promise((r) => setTimeout(r, 150));

// ── 2–6. run one turn and inspect the demultiplexed result ──
{
  const s = await api("GET", "/api/session");
  assert.ok(s.json.active, "first boot opens a session");
  await api("POST", "/api/chat", { text: "hello" });

  // Wait for the async turn to finish (the queue runs it after the response).
  let turns: any[] = [];
  for (let i = 0; i < 60; i++) {
    const t = await api("GET", "/api/turns");
    turns = t.json.turns ?? [];
    if (turns.length && turns.at(-1).status !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(turns.length, 1, "one turn recorded");
  const turn = turns[0];

  // 2. event app tags — the app is the outermost tree tool; `lookup` is a
  //    contacts capability and stays with contacts.
  const appOfKind = (kind: string) => turn.events.filter((e: any) => e.kind === kind).map((e: any) => e.app);
  assert.deepEqual(appOfKind("llm_call"), ["trunk"], "trunk prompt belongs to trunk");
  assert.deepEqual(appOfKind("tree_enter"), ["contacts", "contacts"], "a capability stays with its app");
  assert.deepEqual(appOfKind("tree_suspend"), ["contacts"], "suspend tags the app, not the capability");
  const memEvent = turn.events.find((e: any) => e.kind === "record" && e.content?.child === "name");
  assert.equal(memEvent.app, "contacts", "a memory write inside contacts tags contacts");
  const capEvent = turn.events.find((e: any) => e.kind === "record" && e.content?.child === "company");
  assert.equal(capEvent.app, "contacts", "a memory write inside a capability tags the app");

  // 3. emit apps (parallel to emits)
  assert.deepEqual(turn.emits, ["trunk says hi", "contacts says hi", "lookup needs input"]);
  assert.deepEqual(turn.emitApps, ["trunk", "contacts", "contacts"], "an emit from a capability tags the app");

  // 4. awaiting = the app that owns the pause
  assert.equal(turn.awaiting, "contacts", "the pause is inside a capability but belongs to contacts");

  // 5. memory grouped per app
  const mem = await api("GET", "/api/tree/memory");
  assert.deepEqual(mem.json.apps.contacts, { "0/1/name": "Ada", "0/1/0/company": "Acme" }, "contacts memory (incl. its capability) grouped, path kept");
  assert.equal(mem.json.apps.lookup, undefined, "a capability has no tile of its own");
  assert.equal(mem.json.values["0/1/name"], "Ada", "flat values preserved for the old panel");

  // /api/session reports the pause too
  const sess = await api("GET", "/api/session");
  assert.equal(sess.json.awaiting, "contacts", "session exposes the awaiting app");

  // 7. A reply is attributed to the app that was paused (contacts), not trunk,
  //    so the user's bubble lands on the right tile.
  assert.equal(turn.inputApp, "trunk", "the opening message belongs to trunk");
  await api("POST", "/api/chat", { text: "here is the input" });
  let turns2: any[] = [];
  for (let i = 0; i < 60; i++) {
    const t = await api("GET", "/api/turns");
    turns2 = t.json.turns ?? [];
    if (turns2.length >= 2 && turns2.at(-1).status !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(turns2.length, 2, "second turn recorded");
  assert.equal(turns2[1].inputApp, "contacts", "the reply is attributed to the paused app, not trunk");

  // 7b. A failed turn keeps the input on the app it was headed to (retryable),
  //     instead of clearing to nowhere.
  failNext = true;
  await api("POST", "/api/chat", { text: "retry me" });
  let turns3: any[] = [];
  for (let i = 0; i < 60; i++) {
    const t = await api("GET", "/api/turns");
    turns3 = t.json.turns ?? [];
    if (turns3.length >= 3 && turns3[turns3.length - 1].status !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(turns3[2].status, "error", "third turn failed");
  assert.equal(turns3[2].inputApp, "contacts", "errored reply still targets the paused app");
  assert.equal(turns3[2].awaiting, "contacts", "awaiting restored after the error");
  const sess3 = await api("GET", "/api/session");
  assert.equal(sess3.json.awaiting, "contacts", "session awaiting restored for a retry");

  console.log("2-5. events, emits, memory, and awaiting all attribute per app");
}

// ── 6. the SSE broadcast carries the same tags ──
{
  const start = sse.find((m) => m.type === "turn_start");
  const end = sse.find((m) => m.type === "turn_end");
  assert.ok(start, "turn_start broadcast");
  assert.equal(end?.awaiting, "contacts", "turn_end carries awaiting");
  const starts = sse.filter((m) => m.type === "turn_start");
  assert.equal(starts[0]?.inputApp, "trunk", "first turn_start inputApp = trunk");
  assert.equal(starts[1]?.inputApp, "contacts", "second turn_start inputApp = the paused app");
  const evContacts = sse.find((m) => m.type === "event" && m.event?.kind === "tree_enter" && m.event.app === "contacts");
  assert.ok(evContacts, "event broadcast carries the app tag");
  const emitCap = sse.find((m) => m.type === "emit" && m.app === "contacts" && /lookup needs input/.test(m.text ?? ""));
  assert.ok(emitCap, "a capability's emit broadcast carries the app tag");
  console.log("6. SSE broadcasts turn_start/turn_end/event/emit with app tags");
}

sseReq.destroy();
server.close();
console.log("app-attribution-test: all assertions passed");
process.exit(0);
