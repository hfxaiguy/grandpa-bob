/**
 * Live memory push over SSE.
 *
 * A turn's memory-slot writes must reach the browser *as they happen*, not
 * only when the turn ends (the panel used to stay stale until turn_end).
 *
 *   1. A memory record event emitted mid-turn is broadcast as a
 *      `{ type: "memory", app, values }` SSE message immediately.
 *   2. /api/tree/memory reflects the same value (the full-map fallback).
 *
 * Mock model handler, no network. Run: npm run test:web-memory
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-web-memory-"));
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

const mockAgent = () =>
  ({
    sessionKeys: () => [],
    sessionMeta: () => [],
    hasContinuation: () => true,
    consumesInputDirectly: async () => true,
    sessionRef: () => undefined,
    pinnedVersions: () => [],
    modelSlots: () => [],
    clear() {},
    async run(_key: string, content: unknown, onEmit: (v: unknown) => void, opts?: any) {
      // A memory write, exactly as the engine logs it.
      opts?.onEvent?.({
        kind: "record",
        branch_path: "relay",
        scope_id: 1,
        content: { op: "memory", child: "count", value: 42 },
      });
      onEmit({ text: "echo:" + String(content) });
      return { status: "waiting", continuation: "mock:1" };
    },
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

const port = await freePort();
const mod = await import("../src/admin.ts");
const server = mod.startAdmin({ port, workspaceDir: ws, agent: mockAgent() });
await events.once(server, "listening");

// Follow the live SSE stream.
const sse = await fetch(`http://127.0.0.1:${port}/api/events`);
const reader = sse.body!.getReader();
const dec = new TextDecoder();
let buf = "";
const memoryMsgs: any[] = [];
const pump = (async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const msg = JSON.parse(line.slice(6));
      if (msg?.type === "memory") memoryMsgs.push(msg);
    }
  }
})();

const s0 = await api(port, "GET", "/api/session");
assert.ok(s0.json.active, "first boot opens a session");

const chat = await api(port, "POST", "/api/chat", { text: "hi" });
assert.equal(chat.status, 200);

// Wait for the memory broadcast (it should arrive mid-turn, well before end).
for (let i = 0; i < 100 && memoryMsgs.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 20));
}
assert.ok(memoryMsgs.length > 0, "a memory SSE message arrives during the turn");
const m = memoryMsgs[0];
assert.equal(m.app, "trunk");
assert.equal(m.values["relay/count"], 42, "the written value is pushed");

// The full-map endpoint agrees.
const mem = await api(port, "GET", "/api/tree/memory");
assert.equal(mem.json.apps.trunk["relay/count"], 42, "the memory endpoint agrees");

reader.cancel().catch(() => {});
server.close();
console.log("web-memory: live memory push works");
