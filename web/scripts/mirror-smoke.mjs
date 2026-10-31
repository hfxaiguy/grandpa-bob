// Headless end-to-end check for the desktop mirror: create a mirror-bound
// profile in the real UI, then verify both directions and the conflict rule
// against a real folder served by the storage bridge.
//
// Run: `npm run smoke:mirror` (needs a built web/dist and Chromium).
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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

const repo = path.resolve(import.meta.dirname, "../..");
const SERVE_PORT = await freePort();
const BRIDGE_PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = process.env.WEB_URL ?? `http://127.0.0.1:${SERVE_PORT}`;
const CHROME = process.env.CHROME_BIN ?? "chromium";
const tmp = await mkdtemp(path.join(os.tmpdir(), "bob-mirror-smoke-"));
const HOME = path.join(tmp, "home");
const STATE = path.join(tmp, "state");
const DEFAULT_ROOT = path.join(tmp, "default-workspace");
const PROFILE = path.join(tmp, "chrome");
await mkdir(HOME, { recursive: true });
await mkdir(STATE, { recursive: true });

const serve = spawn(process.execPath, [path.join(repo, "web/scripts/serve.mjs")], {
  env: { ...process.env, PORT: String(SERVE_PORT), HOST: "127.0.0.1" },
  stdio: "ignore",
});
const bridge = spawn(
  process.execPath,
  [path.join(repo, "web/scripts/storage-server.mjs"), DEFAULT_ROOT],
  {
    env: {
      ...process.env,
      HOME,
      BOB_STATE_DIR: STATE,
      STORAGE_PORT: String(BRIDGE_PORT),
    },
    stdio: "ignore",
  },
);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup(code, message) {
  try { chrome.kill("SIGKILL"); } catch {}
  try { bridge.kill("SIGKILL"); } catch {}
  try { serve.kill("SIGKILL"); } catch {}
  rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (message) console.error(message);
  process.exit(code);
}
setTimeout(() => cleanup(2, "timeout: mirror smoke did not finish"), 300_000).unref();

const getJSON = async (p) => (await fetch(`http://127.0.0.1:${CDP_PORT}${p}`)).json();
let version;
for (let i = 0; i < 150 && !version; i++) {
  try { version = await getJSON("/json/version"); } catch { await sleep(100); }
}
if (!version) cleanup(1, "chrome devtools unreachable");

let page;
try {
  page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
} catch {
  const targets = await getJSON("/json/list");
  page = targets.find((t) => t.type === "page") ?? targets[0];
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result?.result?.value;
}
async function waitFor(expression, label, timeout = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch { /* navigation in flight */ }
    await sleep(250);
  }
  const status = await evaluate(
    `(async () => {
      let registry = null;
      try {
        const root = await navigator.storage.getDirectory();
        registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
      } catch (err) { registry = String(err); }
      return JSON.stringify({
        status: document.getElementById("status")?.textContent,
        chip: document.getElementById("mirror-status")?.textContent,
        active: (() => { try { return localStorage.getItem("bob:profile"); } catch { return "?"; } })(),
        select: document.getElementById("profile-select")?.value,
        options: [...document.querySelectorAll("#profile-select option")].map((o) => o.value),
        registry,
      });
    })()`,
  ).catch(() => "n/a");
  throw new Error(`timeout waiting for ${label} (${status})`);
}
async function waitFile(file, expected, timeout = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const text = await readFile(file, "utf8");
      if (expected === undefined || text === expected) return text;
    } catch {
      /* not there yet */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${file}${expected === undefined ? "" : ` = ${expected}`}`);
}
const assert = (condition, message) => { if (!condition) throw new Error(`assertion failed: ${message}`); };
const workspaceFile = (name) => path.join(HOME, ".bobkat/folders/travel", name);

// Wait for both servers.
for (let i = 0; i < 100; i++) {
  const ok = await Promise.all([
    fetch(`${BASE}/`).then((r) => r.ok, () => false),
    fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`).then((r) => r.ok, () => false),
  ]);
  if (ok[0] && ok[1]) break;
  if (i === 99) cleanup(1, "servers never became healthy");
  await sleep(100);
}

await send("Runtime.enable");
await send("Page.enable");

try {
  await send("Page.navigate", { url: `${BASE}/?server=http://127.0.0.1:${BRIDGE_PORT}` });
  await waitFor(
    `document.readyState === "complete" && (document.getElementById("status")?.textContent || "").includes("opfs")`,
    "app boot",
  );

  // Create a mirror-bound profile through the real dialog.
  const created = await evaluate(`(async () => {
    document.getElementById("profile-manage").click();
    document.getElementById("profile-new-name").value = "mirror-test";
    const source = document.getElementById("profile-new-source");
    source.value = "desktop";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("profile-new-folder").value = "travel";
    document.getElementById("profile-create").requestSubmit();
    return true;
  })()`);
  assert(created, "profile form submitted");

  await waitFor(
    `document.readyState === "complete" && (document.getElementById("profile-select")?.value === "mirror-test")`,
    "mirror profile boot",
  );
  await waitFor(
    `(() => {
      const chip = document.getElementById("mirror-status");
      return chip && !chip.hidden && (chip.textContent || "").startsWith("desktop:") &&
        !(chip.textContent || "").includes("syncing");
    })()`,
    "first mirror sync",
  );

  // Desktop → OPFS.
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const ws = await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("mirror-test");
    const workspace = await ws.getDirectoryHandle("workspace", { create: true });
    const h = await workspace.getFileHandle("from-opfs.txt", { create: true });
    const w = await h.createWritable(); await w.write("made in the tab"); await w.close();
    return true;
  })()`);
  const folder = path.join(HOME, ".bobkat/folders/travel");

  // Force a pass from the dialog and check both directions.
  await evaluate(`(async () => {
    document.getElementById("profile-manage").click();
    for (let i = 0; i < 100; i++) {
      const button = [...document.querySelectorAll("#profile-list button")].find((b) => b.textContent === "Sync now");
      if (button) { button.click(); return true; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Sync now button missing");
  })()`);
  const pushed = await waitFile(path.join(folder, "from-opfs.txt"), "made in the tab");
  assert(pushed === "made in the tab", "OPFS file reached the desktop folder");

  // A desktop-side write pulls into OPFS after the next pass.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(folder, "from-desktop.txt"), "made on the desktop");
  await evaluate(`(async () => {
    for (let i = 0; i < 100; i++) {
      const button = [...document.querySelectorAll("#profile-list button")].find((b) => b.textContent === "Sync now");
      if (button) { button.click(); return true; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Sync now button missing");
  })()`);
  await waitFor(
    `(async () => {
      const root = await navigator.storage.getDirectory();
      const ws = await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("mirror-test");
      const workspace = await ws.getDirectoryHandle("workspace");
      const h = await workspace.getFileHandle("from-desktop.txt");
      return (await (await h.getFile()).text()) === "made on the desktop";
    })()`,
    "desktop file pulled into OPFS",
  );

  // Conflict: OPFS wins, the desktop variant is preserved next to it.
  await writeFile(path.join(folder, "clash.txt"), "desktop-1");
  await evaluate(`(async () => {
    const button = [...document.querySelectorAll("#profile-list button")].find((b) => b.textContent === "Sync now");
    if (button) button.click();
    await new Promise((r) => setTimeout(r, 1500));
  })()`);
  await writeFile(path.join(folder, "clash.txt"), "desktop-2");
  await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const ws = await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("mirror-test");
    const workspace = await ws.getDirectoryHandle("workspace");
    const h = await workspace.getFileHandle("clash.txt", { create: true });
    const w = await h.createWritable(); await w.write("opfs-2"); await w.close();
    for (let i = 0; i < 100; i++) {
      const button = [...document.querySelectorAll("#profile-list button")].find((b) => b.textContent === "Sync now");
      if (button) { button.click(); return true; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Sync now button missing");
  })()`);
  const clash = await waitFile(path.join(folder, "clash.txt"), "opfs-2");
  assert(clash === "opfs-2", "OPFS bytes win a conflict");
  const copies = (await readdir(folder)).filter((n) => n.startsWith("clash.txt.conflict-"));
  assert(copies.length >= 1, "the desktop variant is preserved as a conflict copy");

  assert(exceptions.length === 0, `no page exceptions: ${exceptions.join(" | ")}`);
  console.log("mirror smoke: profile, pull, push and conflict handling OK");
} catch (err) {
  const debug = await evaluate(`JSON.stringify({
    chip: document.getElementById("mirror-status")?.textContent,
    title: document.getElementById("mirror-status")?.title,
    status: window.__bobMirror?.status?.(),
    active: localStorage.getItem("bob:profile"),
    flash: document.getElementById("status")?.textContent,
  })`).catch((e) => `debug failed: ${e}`);
  const folder = path.join(HOME, ".bobkat/folders/travel");
  const files = await readdir(folder).catch((e) => String(e));
  cleanup(1, `mirror smoke failed: ${err instanceof Error ? err.message : String(err)}\n${debug}\nfolder ${folder}: ${JSON.stringify(files)}`);
}
cleanup(0);
