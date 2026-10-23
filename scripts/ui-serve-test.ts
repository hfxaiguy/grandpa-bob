/**
 * Serving the browser app from web/dist.
 *
 *   web/ is the only browser UI. The admin server serves its build at `/`;
 *   there is no legacy ui/dist fallback (a stray ui/dist is never served).
 *
 *   1. GET / serves web/dist/index.html when the app is built.
 *   2. GET /assets/* serves the content-hashed bundle with a JS content type
 *      and immutable caching (Vite hashes the filenames).
 *   3. Path traversal out of web/dist is refused.
 *   4. GET /seed/* serves authoring inputs from web/public, uncached.
 *   5. A rebuild while the server runs (new index + assets, old files gone) is
 *      served on the next request without a restart — no stale-hash 404s.
 *   6. Without a build, / shows a "UI not built" notice naming web/dist.
 *   7. /settings is unaffected.
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
    clear() {},
    async run() { return { status: "waiting" }; },
    modelSlots: () => [],
    sessionModel: () => undefined,
    sessionModelMap: () => ({}),
  }) as any;

async function get(port: number, p: string) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return {
    status: res.status,
    type: res.headers.get("content-type") || "",
    cache: res.headers.get("cache-control") || "",
    text: await res.text(),
  };
}

// ── with a build present ──
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-ui-serve-"));
  await fs.mkdir(path.join(ws, "logs"), { recursive: true });
  await fs.mkdir(path.join(ws, "web", "dist", "assets"), { recursive: true });
  await fs.writeFile(path.join(ws, "web", "dist", "index.html"), '<!doctype html><div id="app">WEB_MARKER</div>');
  await fs.writeFile(path.join(ws, "web", "dist", "assets", "web-1.js"), "console.log('web');");
  // A stray legacy build: nothing reads ui/dist anymore, so serving it would
  // mean the old fallback crept back in.
  await fs.mkdir(path.join(ws, "ui", "dist", "assets"), { recursive: true });
  await fs.writeFile(path.join(ws, "ui", "dist", "index.html"), '<!doctype html><div id="root">LEGACY_MARKER</div>');
  await fs.writeFile(path.join(ws, "ui", "dist", "assets", "legacy-1.js"), "console.log('legacy');");
  // Authoring input served at /seed/ (web/public/seed/*).
  await fs.mkdir(path.join(ws, "web", "public", "seed"), { recursive: true });
  await fs.writeFile(path.join(ws, "web", "public", "seed", "workspace.json"), '{"seed":true}');
  await fs.writeFile(path.join(ws, "secret.txt"), "top secret");

  const port = await freePort();
  const server = startAdmin({ port, workspaceDir: ws, projectDir: ws, envPath: path.join(ws, "absent.env"), agent: mockAgent() });
  await events.once(server, "listening");

  const root = await get(port, "/");
  assert.equal(root.status, 200);
  assert.match(root.type, /text\/html/);
  assert.match(root.text, /WEB_MARKER/, "the built web app index is served at /");
  assert.doesNotMatch(root.text, /LEGACY_MARKER/, "a stray ui/dist is not served");

  const asset = await get(port, "/assets/web-1.js");
  assert.equal(asset.status, 200);
  assert.match(asset.type, /javascript/);
  assert.match(asset.text, /console\.log\('web'\)/);
  assert.match(asset.cache, /immutable/, "content-hashed assets are cached immutably");

  const legacyAsset = await get(port, "/assets/legacy-1.js");
  assert.equal(legacyAsset.status, 404, "legacy ui/dist assets are not served");

  const traversal = await get(port, "/assets/..%2f..%2fsecret.txt");
  assert.ok(traversal.status === 403 || traversal.status === 404, "path traversal refused");
  assert.doesNotMatch(traversal.text, /top secret/);

  const seed = await get(port, "/seed/workspace.json");
  assert.equal(seed.status, 200, "/seed/ is served from web/public");
  assert.match(seed.text, /"seed":true/);
  assert.match(seed.cache, /no-store/, "authoring inputs are not cached immutably");

  const settings = await get(port, "/settings");
  assert.equal(settings.status, 200);
  assert.match(settings.type, /text\/html/);

  // ── a `build:web` while the server runs ──
  // Vite rewrites index.html to new content hashes and clears the old assets.
  // / must serve the current index (reading it per request) so the reloaded
  // page asks for files that exist; a startup snapshot would 404 here.
  await fs.rm(path.join(ws, "web", "dist", "assets", "web-1.js"));
  await fs.writeFile(path.join(ws, "web", "dist", "assets", "web-2.js"), "console.log('rebuilt');");
  await fs.writeFile(
    path.join(ws, "web", "dist", "index.html"),
    '<!doctype html><div id="app">REBUILT_MARKER</div><script type="module" src="/assets/web-2.js"></script>',
  );
  const rebuilt = await get(port, "/");
  assert.equal(rebuilt.status, 200);
  assert.match(rebuilt.text, /REBUILT_MARKER/, "a rebuild while running is served on the next request");
  const rebuiltAsset = await get(port, "/assets/web-2.js");
  assert.equal(rebuiltAsset.status, 200, "the rebuilt bundle is served");
  const gone = await get(port, "/assets/web-1.js");
  assert.equal(gone.status, 404, "the replaced bundle is gone (the old-hash 404 being avoided)");

  server.close();
  console.log("web. build served at / with immutable assets; no legacy ui/dist; traversal refused; /seed/ from web/public; rebuild mid-run served; /settings intact");
}

// ── without a build: a clear "UI not built" notice at / ──
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-ui-nobuild-"));
  await fs.mkdir(path.join(ws, "logs"), { recursive: true });
  const port = await freePort();
  const server = startAdmin({ port, workspaceDir: ws, projectDir: ws, envPath: path.join(ws, "absent.env"), agent: mockAgent() });
  await events.once(server, "listening");
  const root = await get(port, "/");
  assert.equal(root.status, 200, "still serves a page");
  assert.match(root.type, /text\/html/);
  assert.match(root.text, /UI not built/, "the notice tells the user to build the UI");
  assert.match(root.text, /web\/dist/, "the notice names the web build");
  server.close();
  console.log("nobuild. no build → UI-not-built notice naming web/dist at /");
}

console.log("ui-serve-test: all assertions passed");
process.exit(0);
