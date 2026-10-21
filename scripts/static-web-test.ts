/**
 * BOB_WEB=0: the admin server serves only the browser UI.
 *
 *   The bot still owns ADMIN_PORT (the familiar URL) but runs no admin state:
 *   the page at "/" boots its in-browser backend, and every `/api/*` answers
 *   503 `{ "admin": false }` — the capability probe the settings page uses to
 *   keep server-only controls visible but disabled.
 *
 *   1. GET / serves the web/dist build (same asset contract as the admin).
 *   2. /api/* answers 503 JSON with `admin: false`, never admin data.
 *   3. /settings redirects to the app (the settings page is an in-page iframe).
 *   4. Path traversal out of web/dist is refused.
 *   5. API mode still answers /api/capabilities with `admin: true`.
 *
 * No agent is needed in static mode. Run: npm run test:web-static
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { startAdmin } from "../src/admin.js";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function get(port: number, p: string, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: "manual" });
  return {
    status: res.status,
    type: res.headers.get("content-type") || "",
    location: res.headers.get("location") || "",
    cache: res.headers.get("cache-control") || "",
    text: await res.text(),
  };
}

const mockAgent = () =>
  ({
    sessionKeys: () => [],
    sessionMeta: () => [],
    hasContinuation: () => false,
    consumesInputDirectly: async () => false,
    sessionRef: () => undefined,
    pinnedVersions: () => [],
    clear() {},
    async run() { return { status: "waiting" }; },
    modelSlots: () => [],
    sessionModel: () => undefined,
    sessionModelMap: () => ({}),
  }) as any;

// ── static mode (BOB_WEB=0) ──
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-static-web-"));
  await fs.mkdir(path.join(ws, "logs"), { recursive: true });
  await fs.mkdir(path.join(ws, "web", "dist", "assets"), { recursive: true });
  await fs.writeFile(path.join(ws, "web", "dist", "index.html"), '<!doctype html><div id="app">STATIC_MARKER</div>');
  await fs.writeFile(path.join(ws, "web", "dist", "assets", "web-1.js"), "console.log('static');");
  await fs.mkdir(path.join(ws, "web", "public", "seed"), { recursive: true });
  await fs.writeFile(path.join(ws, "web", "public", "seed", "workspace.json"), '{"seed":true}');
  await fs.writeFile(path.join(ws, "secret.txt"), "top secret");

  const port = await freePort();
  // No agent, no secrets, no stt: static mode must not need any of them.
  const server = startAdmin({ mode: "static", port, workspaceDir: ws, projectDir: ws, envPath: path.join(ws, "absent.env") });
  await events.once(server, "listening");

  const root = await get(port, "/");
  assert.equal(root.status, 200);
  assert.match(root.type, /text\/html/);
  assert.match(root.text, /STATIC_MARKER/, "the browser UI is served at /");

  const asset = await get(port, "/assets/web-1.js");
  assert.equal(asset.status, 200);
  assert.match(asset.cache, /immutable/, "content-hashed assets are cached immutably");

  const seed = await get(port, "/seed/workspace.json");
  assert.equal(seed.status, 200, "/seed/ is served from web/public");
  assert.match(seed.cache, /no-store/, "authoring inputs are not cached immutably");

  const traversal = await get(port, "/assets/..%2f..%2fsecret.txt");
  assert.ok(traversal.status === 403 || traversal.status === 404, "path traversal refused");
  assert.doesNotMatch(traversal.text, /top secret/);

  for (const p of ["/api/status", "/api/capabilities", "/api/session", "/api/models"]) {
    const api = await get(port, p);
    assert.equal(api.status, 503, `${p} is not served in static mode`);
    assert.match(api.type, /application\/json/);
    const body = JSON.parse(api.text) as { admin?: boolean; error?: string };
    assert.equal(body.admin, false, `${p} tells the page there is no admin`);
    assert.match(body.error || "", /BOB_WEB=1/, "the refusal names the opt-in flag");
  }

  const post = await get(port, "/api/chat", "POST");
  assert.equal(post.status, 503, "write endpoints are closed too");

  const settings = await get(port, "/settings");
  assert.equal(settings.status, 302, "a direct /settings hit has no API behind it");
  assert.equal(settings.location, "/", "…so it goes back to the app");

  const missing = await get(port, "/nope");
  assert.equal(missing.status, 404);

  server.close();
  console.log("static. UI served at /; /api/* 503 {admin:false}; /settings → /; traversal refused");
}

// ── api mode still advertises itself ──
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-static-api-"));
  await fs.mkdir(path.join(ws, "logs"), { recursive: true });
  const port = await freePort();
  const server = startAdmin({
    mode: "api",
    port,
    workspaceDir: ws,
    projectDir: ws,
    envPath: path.join(ws, "absent.env"),
    agent: mockAgent(),
  });
  await events.once(server, "listening");
  const caps = await get(port, "/api/capabilities");
  assert.equal(caps.status, 200, "the admin answers the capability probe");
  const body = JSON.parse(caps.text) as { admin?: boolean };
  assert.equal(body.admin, true, "…and says the server-only controls are live");
  server.close();
  console.log("api. /api/capabilities → {admin:true}");
}

console.log("static-web-test: all assertions passed");
process.exit(0);
