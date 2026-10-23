// Headless check for bound-seed updates: a fake BobSwap service serves
// /latest/meta + /latest; the browser must offer, apply (keeping the run log),
// and then stop offering the update.
// Requires a served build (npm run web:standalone or the admin) and Chromium.
//   node scripts/seed-update-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8080";
const SERVICE_PORT = 8799;
const CDP = Number(process.env.CDP_PORT ?? 9226);
const PROFILE = path.join(os.tmpdir(), `bob-seed-smoke-${process.pid}`);
const READ_KEY = "bsk_live_read";

const archive = {
  version: 1,
  createdAt: "2027-01-02T03:04:05.000Z",
  files: [
    {
      path: "workspace/patterns/updated-by-seed.mjs",
      base64: Buffer.from("export default { updated: true };").toString("base64"),
    },
    {
      path: "workspace/logs/grandma-kat.db",
      base64: Buffer.from("SHOULD-NOT-WIN").toString("base64"),
    },
  ],
};
const body = JSON.stringify(archive);
const sha256 = createHash("sha256").update(body).digest("hex");
const version = `${sha256.slice(0, 12)}-20270102T030405Z`;
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${SERVICE_PORT}`);
  requests.push(url.pathname + url.search);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-expose-headers", "etag, x-seed-version");
  if (url.pathname === "/api/v1/personal/trunk/latest/meta") {
    if (url.searchParams.get("key") !== READ_KEY) {
      res.statusCode = 401;
      res.end('{"error":"key required"}');
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        version: 1,
        createdAt: archive.createdAt,
        fileCount: archive.files.length,
        size: Buffer.byteLength(body),
        sha256,
        seed_id_and_version: version,
      }),
    );
    return;
  }
  if (url.pathname === "/api/v1/personal/trunk/latest") {
    if (url.searchParams.get("key") !== READ_KEY) {
      res.statusCode = 401;
      res.end('{"error":"key required"}');
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("etag", sha256);
    res.setHeader("x-seed-version", version);
    res.end(body);
    return;
  }
  res.statusCode = 404;
  res.end('{"error":"not found"}');
});
await new Promise((resolve) => server.listen(SERVICE_PORT, "127.0.0.1", resolve));

const chrome = spawn(
  "chromium",
  [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup(code, message) {
  try { chrome.kill("SIGKILL"); } catch {}
  try { server.close(); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  if (message) console.error(message);
  process.exit(code);
}
setTimeout(() => cleanup(2, "timeout: seed-update smoke did not finish"), 180_000).unref();

const getJSON = async (p) => (await fetch(`http://127.0.0.1:${CDP}${p}`)).json();
let v; for (let i = 0; i < 150 && !v; i++) { try { v = await getJSON("/json/version"); } catch { await sleep(100); } }
if (!v) cleanup(1, "chrome devtools unreachable");
const page = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0; const pending = new Map(); const exceptions = [];
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Page.javascriptDialogOpening") {
    send("Page.handleJavaScriptDialog", { accept: true });
  }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
};
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result?.result?.value;
}
async function waitFor(expression, label, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const value = await evaluate(expression); if (value) return value; } catch {}
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}
const assert = (condition, message) => { if (!condition) throw new Error(`assertion failed: ${message}`); };
await send("Runtime.enable");
await send("Page.enable");

// Fresh boot (no legacy data).
await send("Page.navigate", { url: `${BASE}/?storage=browser` });
await waitFor(`document.readyState === "complete" && !!window.__bobWorkspaceTransfer`, "app boot");

// Configure the service and bind the default profile to its seed.
await evaluate(`(() => {
  document.getElementById("swap-settings").click();
  document.getElementById("seed-base-url").value = "http://127.0.0.1:${SERVICE_PORT}";
  document.getElementById("seed-read-key").value = "${READ_KEY}";
  document.getElementById("seed-save").click();
  document.getElementById("seed-close").click();
  document.getElementById("profile-manage").click();
  return "opened";
})()`);
await waitFor(
  `!!document.querySelector("#profile-list .profile-row")`,
  "profile manager rows",
);
await evaluate(`(() => {
  const row = document.querySelector("#profile-list .profile-row");
  [...row.querySelectorAll("button")].find((b) => b.textContent === "Seed…").click();
  document.getElementById("seed-account").value = "personal";
  document.getElementById("seed-name").value = "trunk";
  document.getElementById("seed-save").click();
  return "saved";
})()`);
await waitFor(
  `!!JSON.parse(localStorage.getItem("bob:swap") || "{}").services?.["http://127.0.0.1:${SERVICE_PORT}"]`,
  "service saved",
);
await sleep(500);

// Reload: boot must now offer the update.
await send("Page.navigate", { url: `${BASE}/?storage=browser` });
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && !document.getElementById("ws-reseed").hidden`,
  "seed update banner",
);
const label = await evaluate(`document.getElementById("ws-reseed").textContent`);
assert(String(label).includes("Seed update: trunk"), `banner names the seed (got: ${label})`);

// Keep the run log across the update: read it before applying.
const before = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const ws = await (await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default")).getDirectoryHandle("workspace");
  const log = await (await ws.getDirectoryHandle("logs")).getFileHandle("grandma-kat.db").then((h) => h.getFile()).catch(() => null);
  const bytes = log ? new Uint8Array(await log.arrayBuffer()) : new Uint8Array();
  let out = ""; for (const b of bytes) out += String.fromCharCode(b);
  return JSON.stringify({ size: bytes.length, text: btoa(out) });
})()`);
const logBefore = JSON.parse(before);

// Apply (the confirm is auto-accepted by the CDP handler above).
await evaluate(`document.getElementById("ws-reseed").click()`);
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer`,
  "reload after applying the seed",
);
await sleep(800);

const after = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const profile = await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default");
  const ws = await profile.getDirectoryHandle("workspace");
  const updated = await (await (await ws.getDirectoryHandle("patterns")).getFileHandle("updated-by-seed.mjs")).getFile();
  const log = await (await ws.getDirectoryHandle("logs")).getFileHandle("grandma-kat.db").then((h) => h.getFile()).catch(() => null);
  const bytes = log ? new Uint8Array(await log.arrayBuffer()) : new Uint8Array();
  let out = ""; for (const b of bytes) out += String.fromCharCode(b);
  const seeded = await (await ws.getFileHandle(".seeded")).getFile().then((f) => f.text()).catch(() => "");
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const record = registry.profiles.find((p) => p.name === "default");
  return JSON.stringify({
    updated: await updated.text(),
    logSize: bytes.length,
    logText: btoa(out),
    seeded,
    lastVersion: record?.seed?.lastVersion,
    bannerHidden: document.getElementById("ws-reseed").hidden,
  });
})()`);
const a = JSON.parse(after);
assert(a.updated.includes("updated: true"), "the seed's new file was applied");
assert(a.logSize === logBefore.size && a.logText === logBefore.text, "the local run log was preserved");
assert(a.logSize !== Buffer.from("SHOULD-NOT-WIN").length || !a.logText.includes(Buffer.from("SHOULD-NOT-WIN").toString("base64").slice(0, 8)), "the seed's log did not overwrite the local one");
assert(a.seeded.startsWith("2027-01-02"), "the freshness stamp follows the applied archive");
assert(a.lastVersion?.version === version, "the pulled version is recorded on the binding");
assert(a.bannerHidden === true, "the banner is gone after applying");
assert(requests.some((r) => r.includes("latest/meta") && r.includes("key=")), "meta was fetched with the read key");

if (exceptions.length) cleanup(1, `runtime exceptions:\n${exceptions.join("\n")}`);
console.log("seed-update smoke: banner, apply, log preservation, version record and re-check all passed");
cleanup(0);
