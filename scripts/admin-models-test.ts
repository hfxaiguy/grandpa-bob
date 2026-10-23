/**
 * Model registry admin API.
 *
 *   1. POST /api/models validates before writing — bad JSON is rejected and
 *      models.json is left untouched (a typo must not break the next restart).
 *   2. A valid save writes the file AND hot-applies it to the live agent
 *      (updateModels) — no restart — returning per-slot reachability.
 *   3. GET /api/models/slots summarizes the live registry without api keys.
 *   4. POST /api/models/test probes an entry and returns the provider's model
 *      list (against a local fake OpenAI-compatible server).
 *   5. POST /api/chat/model sets and clears the active conversation's override.
 *
 * Mock agent + real admin HTTP API. Run: npm run test:admin-models
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { startAdmin } from "../src/admin.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-admin-models-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const modelsFile = path.join(ws, "models.json");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

// Shared, mutable stand-in for the parts of Agent the admin talks to.
const state: {
  slots: { name: string; model: string; baseURL: string }[];
  overrides: Map<string, Record<string, string>>;
  updated: Record<string, unknown> | null;
} = {
  slots: [
    { name: "strong", model: "big", baseURL: "http://127.0.0.1:1/v1" },
    { name: "cheap", model: "small", baseURL: "http://127.0.0.1:1/v1" },
    { name: "claude", model: "claude-3", baseURL: "http://127.0.0.1:1/v1" },
  ],
  overrides: new Map(),
  updated: null,
};
const mockAgent = () =>
  ({
    sessionKeys: () => [],
    sessionMeta: () => [],
    hasContinuation: () => false,
    consumesInputDirectly: async () => false,
    clear() {},
    async run() { return { status: "waiting", continuation: "mock" }; },
    modelSlots: () => state.slots,
    sessionModel: (k: string, role = "strong") => state.overrides.get(k)?.[role],
    sessionModelMap: (k: string) => ({ ...(state.overrides.get(k) ?? {}) }),
    setSessionModel: (k: string, role: string, target: string) => {
      if (!state.slots.some((m) => m.name === target)) return false;
      const rec = state.overrides.get(k) ?? {};
      rec[role] = target;
      state.overrides.set(k, rec);
      return true;
    },
    clearSessionModel: (k: string, role?: string) => {
      const rec = state.overrides.get(k);
      if (!rec) return;
      if (role) delete rec[role];
      if (!role || !Object.keys(rec).length) state.overrides.delete(k);
    },
    updateModels: (reg: Record<string, unknown>) => { state.updated = reg; },
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

// ── 1. invalid registry rejected, nothing written ──
{
  const r = await api("POST", "/api/models", { json: "{ not json" });
  assert.equal(r.status, 400, "invalid JSON → 400");
  assert.match(String(r.json.error), /invalid JSON/i);
  await assert.rejects(fs.readFile(modelsFile, "utf8"), "models.json was not created");
  // Structurally invalid (missing model) also rejected.
  const r2 = await api("POST", "/api/models", { json: JSON.stringify({ strong: { baseURL: "http://x" } }) });
  assert.equal(r2.status, 400, "missing required field → 400");
  console.log("1. invalid registry rejected before writing");
}

// ── 2. valid save writes + hot-applies + returns reachability ──
{
  const registry = {
    strong: { baseURL: "http://127.0.0.1:1/v1", apiKey: "k", model: "big" },
    cheap: { baseURL: "http://127.0.0.1:1/v1", apiKey: "k", model: "small" },
  };
  const r = await api("POST", "/api/models", { json: JSON.stringify(registry) });
  assert.equal(r.status, 200, "valid registry accepted");
  assert.deepEqual(Object.keys(r.json.reachable).sort(), ["cheap", "strong"], "reachability per slot");
  const onDisk = JSON.parse(await fs.readFile(modelsFile, "utf8"));
  assert.equal(onDisk.strong.model, "big", "models.json written");
  assert.ok(state.updated && "strong" in state.updated, "live agent registry hot-applied");
  console.log("2. valid save written, hot-applied, reachability returned");
}

// ── 3. /api/models/slots never leaks the api key ──
{
  const r = await api("GET", "/api/models/slots");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.slots, state.slots, "slots mirror the live registry");
  assert.ok(!JSON.stringify(r.json).includes("apiKey"), "no apiKey field in the slots payload");
  console.log("3. slots endpoint hides api keys");
}

// ── 4. /api/models/test against a local OpenAI-compatible server ──
{
  const fake = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const fport = await freePort();
  await new Promise<void>((r) => fake.listen(fport, "127.0.0.1", () => r()));
  try {
    const r = await api("POST", "/api/models/test", {
      baseURL: `http://127.0.0.1:${fport}/v1`,
      apiKey: "k",
      model: "a-model",
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true, "reachable via /v1/models");
    assert.deepEqual(r.json.models, ["a-model", "z-model"], "provider model list returned, sorted");
    // Missing baseURL → 400.
    const bad = await api("POST", "/api/models/test", { model: "x" });
    assert.equal(bad.status, 400, "entry without baseURL rejected");
  } finally {
    await new Promise<void>((r) => fake.close(() => r()));
  }
  console.log("4. test endpoint probes reachability and lists models");
}

// ── 5. /api/chat/model sets and clears the active conversation override ──
{
  const s = await api("GET", "/api/session");
  assert.ok(s.json.active, "first boot opens a session");
  const active = s.json.active as string;

  const setStrong = await api("POST", "/api/chat/model", { role: "strong", slot: "claude" });
  assert.equal(setStrong.status, 200);
  assert.equal(setStrong.json.models.strong, "claude", "strong override set on the active session");
  const setCheap = await api("POST", "/api/chat/model", { role: "cheap", slot: "strong" });
  assert.equal(setCheap.json.models.cheap, "strong", "cheap override set independently");
  assert.deepEqual(setCheap.json.models, { strong: "claude", cheap: "strong" }, "both roles held at once");

  const unknown = await api("POST", "/api/chat/model", { role: "strong", slot: "does-not-exist" });
  assert.equal(unknown.status, 400, "unknown slot rejected");

  const clearCheap = await api("POST", "/api/chat/model", { role: "cheap", slot: null });
  assert.deepEqual(clearCheap.json.models, { strong: "claude" }, "only the cheap role cleared");

  const clearAll = await api("POST", "/api/chat/model", {});
  assert.deepEqual(clearAll.json.models, {}, "no role → clear everything");
  assert.equal(state.overrides.has(active), false);

  // Selecting the slot named the same as the role is a real choice, not a
  // silent clear (the common models.json names its slots cheap/strong).
  const sameRole = await api("POST", "/api/chat/model", { role: "strong", slot: "strong" });
  assert.equal(sameRole.status, 200);
  assert.equal(sameRole.json.models.strong, "strong", "role-named slot persists");
  const clearSame = await api("POST", "/api/chat/model", { role: "strong", slot: null });
  assert.deepEqual(clearSame.json.models, {}, "the default entry still clears");
  console.log("5. per-role chat model overrides set and clear independently");
}

server.close();
console.log("admin-models-test: all assertions passed");
process.exit(0);
