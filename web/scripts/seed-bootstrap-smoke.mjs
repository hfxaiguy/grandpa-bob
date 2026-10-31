// First-load seed bootstrap: a fresh browser must pull the newest public
// BobSwap archive named by `?bootstrap=` before falling back to the bundled
// snapshot, then remember the shelf for later update checks.
// Requires a built web/dist (npm run build:web) and Chromium.
//   node scripts/seed-bootstrap-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = path.join(os.tmpdir(), `bob-seed-bootstrap-${process.pid}`);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// Reuse the bundled trunk so the app's pattern detection works exactly as it
// would after a real publish.
const bundled = JSON.parse(
  readFileSync(new URL("../public/seed/workspace.json", import.meta.url), "utf8"),
);
const bundledMeta = JSON.parse(
  readFileSync(new URL("../public/seed/meta.json", import.meta.url), "utf8"),
);
const trunkFile = bundled.files.find((f) => f.path === "workspace/patterns/trunk.prod.mjs") ?? {
  path: "workspace/patterns/trunk.prod.mjs",
  base64: Buffer.from("export default { name: 'trunk' };").toString("base64"),
};
const markerFile = {
  path: "workspace/patterns/pulled-on-first-load.mjs",
  base64: Buffer.from("export default { bootstrap: true };").toString("base64"),
};
const archive = {
  version: 1,
  createdAt: "2027-02-03T04:05:06.000Z",
  files: [trunkFile, markerFile],
};
const body = JSON.stringify(archive);
const sha256 = createHash("sha256").update(body).digest("hex");
const version = "boot-test-1";
const requests = [];
/** Flip to false to prove the bundled snapshot is still the fallback. */
let publicLatest = true;

const service = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  requests.push(url.pathname + url.search);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-expose-headers", "etag, x-seed-version");
  if (url.pathname === "/api/v1/personal/trunk/latest" && publicLatest) {
    res.setHeader("content-type", "application/json");
    res.setHeader("etag", `"${sha256}"`);
    res.setHeader("x-seed-version", version);
    res.end(body);
    return;
  }
  // `/latest/meta` stays key-gated; a fresh browser has no key and must use
  // the public archive + ETag instead. A private shelf answers 401 here too.
  res.statusCode = 401;
  res.end('{"error":"key required"}');
});

const SERVICE_PORT = await freePort();
await new Promise((resolve) => service.listen(SERVICE_PORT, "127.0.0.1", resolve));
const SERVICE = `http://127.0.0.1:${SERVICE_PORT}`;
const SERVE_PORT = await freePort();
const serve = spawn(
  process.execPath,
  [path.join(path.dirname(new URL(import.meta.url).pathname), "serve.mjs")],
  {
    env: { ...process.env, PORT: String(SERVE_PORT), HOST: "127.0.0.1" },
    stdio: "ignore",
  },
);
const CDP = await freePort();
const chrome = spawn(
  CHROME,
  [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup(code, message) {
  try { chrome.kill("SIGKILL"); } catch {}
  try { serve.kill("SIGKILL"); } catch {}
  try { service.close(); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  if (message) console.error(message);
  process.exit(code);
}
setTimeout(() => cleanup(2, "timeout: seed-bootstrap smoke did not finish"), 120_000).unref();

const getJSON = async (p) => (await fetch(`http://127.0.0.1:${CDP}${p}`)).json();
let devtools;
for (let i = 0; i < 150 && !devtools; i++) {
  try { devtools = await getJSON("/json/version"); } catch { await sleep(100); }
}
if (!devtools) cleanup(1, "chrome devtools unreachable");

const page = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Page.javascriptDialogOpening") {
    send("Page.handleJavaScriptDialog", { accept: true });
  }
};
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return r.result?.result?.value;
}
async function waitFor(expression, label, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expression)) return; } catch {}
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};
await send("Runtime.enable");
await send("Page.enable");

// The static server may still be binding while Chrome starts.
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${SERVE_PORT}/`)).ok) break;
  } catch {}
  await sleep(100);
}

const url =
  `http://127.0.0.1:${SERVE_PORT}/?bootstrap=personal/trunk` +
  `&bootstrap-url=${encodeURIComponent(SERVICE)}`;
await send("Page.navigate", { url });
await waitFor(`document.readyState === "complete" && !!window.__bobWorkspaceTransfer`, "app boot");
await waitFor(
  `(async () => {
    const root = await navigator.storage.getDirectory();
    const profiles = await root.getDirectoryHandle("profiles");
    const ws = await (await profiles.getDirectoryHandle("default")).getDirectoryHandle("workspace");
    try {
      await (await ws.getDirectoryHandle("patterns")).getFileHandle("pulled-on-first-load.mjs");
      return true;
    } catch { return false; }
  })()`,
  "the bootstrapped seed file",
);

const result = JSON.parse(await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const record = registry.profiles.find((p) => p.name === "default");
  const ws = await (await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default")).getDirectoryHandle("workspace");
  const patterns = await ws.getDirectoryHandle("patterns");
  return JSON.stringify({
    pulled: await (await (await patterns.getFileHandle("pulled-on-first-load.mjs")).getFile()).text(),
    seeded: await (await (await ws.getFileHandle(".seeded")).getFile()).text(),
    seedSha: await (await (await ws.getFileHandle(".seed-sha")).getFile()).text(),
    binding: record?.seed,
  });
})()`));

assert(result.pulled.includes("bootstrap: true"), "the public archive was imported");
assert(result.seeded === archive.createdAt, "the archive's createdAt became the freshness stamp");
assert(result.seedSha === sha256, "the archive's SHA-256 was recorded");
assert(result.binding?.baseUrl === SERVICE, "the profile is bound to the bootstrap service");
assert(result.binding?.account === "personal" && result.binding?.seedName === "trunk", "the binding names the seed");
assert(result.binding?.lastVersion?.version === version, "the pulled version is recorded");
assert(requests.some((r) => r.startsWith("/api/v1/personal/trunk/latest")), "the public latest archive was requested");

// Phase 2: a private shelf must fall back to the bundled snapshot. Clear the
// origin's OPFS and make `/latest` answer 401, then boot a fresh tab again.
publicLatest = false;
const attemptsBefore = requests.filter((r) => r.startsWith("/api/v1/personal/trunk/latest")).length;
await send("Storage.clearDataForOrigin", {
  origin: `http://127.0.0.1:${SERVE_PORT}`,
  storageTypes: "all",
});
await send("Page.navigate", { url: `${url}&fallback=1` });
await waitFor(`document.readyState === "complete" && !!window.__bobWorkspaceTransfer`, "fallback boot");
await waitFor(
  `(async () => {
    const root = await navigator.storage.getDirectory();
    const profiles = await root.getDirectoryHandle("profiles");
    const ws = await (await profiles.getDirectoryHandle("default")).getDirectoryHandle("workspace");
    try {
      await ws.getFileHandle(".seeded");
      return true;
    } catch { return false; }
  })()`,
  "the bundled seed fallback",
);
const fallback = JSON.parse(await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const record = registry.profiles.find((p) => p.name === "default");
  const ws = await (await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default")).getDirectoryHandle("workspace");
  let pulled = true;
  try {
    await (await ws.getDirectoryHandle("patterns")).getFileHandle("pulled-on-first-load.mjs");
  } catch { pulled = false; }
  return JSON.stringify({
    seeded: await (await (await ws.getFileHandle(".seeded")).getFile()).text(),
    pulled,
    binding: record?.seed,
  });
})()`));
assert(fallback.seeded === bundledMeta.createdAt, "the bundled snapshot was applied");
assert(fallback.pulled === false, "the private shelf's archive was not applied");
assert(!fallback.binding, "a fallback boot does not bind the private shelf");
assert(
  requests.filter((r) => r.startsWith("/api/v1/personal/trunk/latest")).length > attemptsBefore,
  "the fallback boot still tried the public latest",
);

console.log("seed-bootstrap: public shelf pulled first, private shelf falls back to the bundled seed OK");
cleanup(0);
