/**
 * Per-turn token counting — the web UI's token line.
 *
 * The engine logs `usage` ({ input, output }) on each `llm_call`; the host
 * sums it per turn as events stream in (before the turn's 500-event window
 * caps), reports the total on turn_end, and persists it on the turn marker so
 * a reload derives the same numbers. This test drives the real admin HTTP API
 * with a mock agent whose calls report usage:
 *
 *   1. two reporting calls + one silent call sum to { input, output, calls }
 *   2. the llm_call events keep their usage (the UI could inspect them)
 *   3. SSE turn_end carries the totals live
 *   4. GET /api/turns re-derives the same totals from the marker row
 *
 * Run: npm run test:tokens
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { DatabaseSync } from "node:sqlite";
import { startAdmin } from "../src/admin.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-tokens-"));
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

// The engine writes every event into the workspace log DB; the mock does the
// same, because the admin reads completed turns back from there (web-log.ts).
const engDb = new DatabaseSync(path.join(ws, "logs", "grandma-kat.db"));
engDb.exec("PRAGMA journal_mode = WAL");
engDb.exec(`CREATE TABLE IF NOT EXISTS calls (
  run_id TEXT NOT NULL, definition_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT, branch_path TEXT, iteration INTEGER,
  scope_id INTEGER, kind TEXT NOT NULL, content TEXT)`);
const engStmt = engDb.prepare(
  "INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, 'test', ?, ?, ?, ?, ?)");

// Two rounds report usage; the third (no-tools answer) reports none — the last
// must not invent a call.
const script = [
  { kind: "llm_call", content: { child: "trunk-prompt", round: 1, usage: { input: 120, output: 30 } } },
  { emit: "first" },
  { kind: "llm_call", content: { child: "trunk-prompt", round: 2, usage: { input: 180, output: 20 } } },
  { kind: "llm_call", content: { child: "trunk-prompt", round: 3 } },
  { emit: "second" },
];

const mockAgent = () =>
  ({
    sessionKeys: () => [],
    sessionMeta: () => [],
    hasContinuation: () => true, // skip the grow pass
    consumesInputDirectly: async () => false,
    clear() {},
    async run(_key: string, _content: unknown, onEmit?: (v: unknown) => void, opts?: { onEvent?: (e: unknown) => void }) {
      const runId = `run-tokens-${Date.now()}`;
      for (const step of script) {
        if ("emit" in step) {
          onEmit?.({ text: step.emit });
        } else {
          const e = { run_id: runId, ...step } as Record<string, unknown>;
          engStmt.run(runId, null, 1, null, String(e.kind), JSON.stringify(e.content ?? null));
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

// Collect the live SSE broadcast (turn_end carries the totals).
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

const s = await api("GET", "/api/session");
assert.ok(s.json.active, "first boot opens a session");
await api("POST", "/api/chat", { text: "hello" });

let turns: any[] = [];
for (let i = 0; i < 60; i++) {
  const t = await api("GET", "/api/turns");
  turns = t.json.turns ?? [];
  if (turns.length && turns.at(-1).status !== "running") break;
  await new Promise((r) => setTimeout(r, 50));
}
assert.equal(turns.length, 1, "one turn recorded");
const turn = turns[0];

// 1. the sum: only the reporting calls count.
assert.deepEqual(turn.tokens, { input: 300, output: 50, calls: 2 }, "usage is summed per turn; silent calls add nothing");
console.log("1. per-turn totals from the stream:", JSON.stringify(turn.tokens));

// 2. the events themselves keep the reported usage.
const calls = turn.events.filter((e: any) => e.kind === "llm_call");
assert.equal(calls.length, 3);
assert.deepEqual(calls[0].content.usage, { input: 120, output: 30 }, "llm_call keeps its usage");
assert.equal(calls[2].content.usage, undefined, "no usage reported stays absent");
console.log("2. llm_call events keep usage (the UI can inspect them)");

// 3. live turn_end carries the totals.
const end = sse.filter((m) => m?.type === "turn_end").at(-1);
assert.ok(end, "turn_end was broadcast");
assert.deepEqual(end.tokens, { input: 300, output: 50, calls: 2 }, "turn_end carries the totals live");
console.log("3. turn_end carries tokens live");

// 4. the finished turn is derived from its marker: reload shows the same.
const again = await api("GET", "/api/turns");
const stored = (again.json.turns ?? []).at(-1);
assert.deepEqual(stored.tokens, { input: 300, output: 50, calls: 2 }, "the marker persists the totals");
console.log("4. /api/turns re-derives the same totals from the log marker");

sseReq.destroy();
server.close();
engDb.close();
await fs.rm(ws, { recursive: true, force: true });
console.log("tokens-test: all assertions passed");
process.exit(0);
