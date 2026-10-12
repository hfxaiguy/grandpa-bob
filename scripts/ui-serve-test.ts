/**
 * Serving the tiled app UI from ui/dist.
 *
 *   1. GET / serves ui/dist/index.html when the app is built.
 *   2. GET /assets/* serves the content-hashed bundle with a JS content type.
 *   3. Path traversal out of ui/dist is refused.
 *   4. Without a build, / falls back to the classic chat page (still 200).
 *   5. /settings is unaffected.
 *
 * Mock agent + real admin HTTP API. Run: npm run test:ui-serve
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

async function get(port: number, p: string) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, type: res.headers.get("content-type") || "", text: await res.text() };
}

// ── with a build present ──
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-ui-serve-"));
  await fs.mkdir(path.join(ws, "logs"), { recursive: true });
  await fs.mkdir(path.join(ws, "ui", "dist", "assets"), { recursive: true });
  await fs.writeFile(path.join(ws, "ui", "dist", "index.html"), "<!doctype html><div id=\"root\">APP_MARKER</div>");
  await fs.writeFile(path.join(ws, "ui", "dist", "assets", "index-abc.js"), "console.log('app');");
  await fs.writeFile(path.join(ws, "secret.txt"), "top secret");

  const port = await freePort();
  const server = startAdmin({ port, workspaceDir: ws, projectDir: ws, envPath: path.join(ws, "absent.env"), agent: mockAgent() });
  await events.once(server, "listening");

  const root = await get(port, "/");
  assert.equal(root.status, 200);
  assert.match(root.type, /text\/html/);
  assert.match(root.text, /APP_MARKER/, "the built app index is served at /");

  const asset = await get(port, "/assets/index-abc.js");
  assert.equal(asset.status, 200);
  assert.match(asset.type, /javascript/);
  assert.match(asset.text, /console\.log\('app'\)/);

  const traversal = await get(port, "/assets/..%2f..%2fsecret.txt");
  assert.ok(traversal.status === 403 || traversal.status === 404, "path traversal refused");
  assert.doesNotMatch(traversal.text, /top secret/);

  const settings = await get(port, "/settings");
  assert.equal(settings.status, 200);
  assert.match(settings.type, /text\/html/);

  const classic = await get(port, "/classic");
  assert.equal(classic.status, 200, "the classic chat page stays reachable");
  assert.match(classic.type, /text\/html/);

  server.close();
  console.log("1-3. built app served at / with assets; traversal refused; /settings + /classic intact");
}

// ── without a build: classic chat page fallback ──
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-ui-nobuild-"));
  await fs.mkdir(path.join(ws, "logs"), { recursive: true });
  const port = await freePort();
  const server = startAdmin({ port, workspaceDir: ws, projectDir: ws, envPath: path.join(ws, "absent.env"), agent: mockAgent() });
  await events.once(server, "listening");
  const root = await get(port, "/");
  assert.equal(root.status, 200, "fallback still serves a page");
  assert.match(root.type, /text\/html/);
  server.close();
  console.log("4. no build → classic chat page fallback");
}

console.log("ui-serve-test: all assertions passed");
process.exit(0);
