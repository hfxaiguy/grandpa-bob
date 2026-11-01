// Headless end-to-end check for the unified peer model:
//   npm run bob (mailbox + Node peer)  ◀── WebRTC ──▶  tab
// Creates a pairing session, joins from the real dialog, approves the SAS,
// reloads, verifies the engine pushes the OPFS workspace to the mirror folder,
// then reloads again to exercise silent reconnect.
//
// Run: `npm run smoke:peer` (needs a built web/dist and Chromium).
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const APP_PORT = await freePort();
const CHANNEL_PORT = await freePort();
const CDP_PORT = await freePort();
const tmp = await mkdtemp(path.join(os.tmpdir(), "bob-peer-smoke-"));
const STATE = path.join(tmp, "state");
const WS = path.join(tmp, "workspace");
const PROFILE = path.join(tmp, "chrome");
await mkdir(STATE, { recursive: true });
await mkdir(WS, { recursive: true });

// The smoke runs src/index.ts directly, so build the Node peer bundle first.
execFileSync(process.execPath, [path.join(repo, "scripts/build-bridge.mjs")], {
  cwd: repo,
  stdio: "ignore",
});

const bob = spawn(path.join(repo, "node_modules/.bin/tsx"), ["src/index.ts"], {
  cwd: repo,
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    ENV_FILE: "/dev/null",
    BOB_STATE_DIR: STATE,
    WORKSPACE_DIR: WS,
    PORT: String(APP_PORT),
    BOB_CHANNEL_PORT: String(CHANNEL_PORT),
  },
});
const chrome = spawn(
  process.env.CHROME_BIN ?? "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup(code, message) {
  try { process.kill(-bob.pid, "SIGKILL"); } catch { /* gone */ }
  try { chrome.kill("SIGKILL"); } catch { /* gone */ }
  rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (message) console.error(message);
  process.exit(code);
}
setTimeout(() => cleanup(2, "timeout: peer smoke did not finish"), 300_000).unref();

const adminKey = async () => (await readFile(path.join(STATE, "admin-key"), "utf8")).trim();
const admin = async (route, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${CHANNEL_PORT}${route}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-bob-admin": await adminKey() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `admin HTTP ${res.status}`);
  return data;
};

const getJSON = async (p) => (await fetch(`http://127.0.0.1:${CDP_PORT}${p}`)).json();
let version;
for (let i = 0; i < 200 && !version; i++) {
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
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
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
    `JSON.stringify({ status: document.getElementById("status")?.textContent, chip: document.getElementById("mirror-status")?.textContent, pair: document.getElementById("pair-status")?.textContent })`,
  ).catch(() => "n/a");
  throw new Error(`timeout waiting for ${label} (${status})`);
}
async function waitDirEntry(dir, name, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const entries = await readdir(dir).catch(() => []);
    if (entries.includes(name)) return entries;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${name} in ${dir}`);
}
async function waitFile(file, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { return await readFile(file); } catch { await sleep(200); }
  }
  throw new Error(`timeout waiting for ${file}`);
}
const assert = (condition, message) => { if (!condition) throw new Error(`assertion failed: ${message}`); };

// Wait for the channel process.
for (let i = 0; i < 200; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${CHANNEL_PORT}/healthz`)).ok) break;
  } catch { /* not up */ }
  if (i === 199) cleanup(1, "channel process never became healthy");
  await sleep(100);
}

await send("Runtime.enable");
await send("Page.enable");

try {
  if (process.env.BOOTSTRAP === "1") {
    await mkdir(path.join(STATE, "folders/default"), { recursive: true });
    await writeFile(path.join(STATE, "folders/default/desktop-only.txt"), "from the desktop");
  }
  const pairing = await admin("/admin/pairing", {
    method: "POST",
    body: { profile: "default", mirror: "default", exec: ["git", "sh"] },
  });
  console.log("pairing code", pairing.code);

  await send("Page.navigate", { url: `http://127.0.0.1:${APP_PORT}` });
  await waitFor(
    `document.readyState === "complete" && (document.getElementById("status")?.textContent || "").includes("opfs")`,
    "app boot",
  );
  await evaluate(`(() => {
    document.getElementById("live-pair").click();
    document.getElementById("pair-source-desktop").click();
    document.getElementById("pair-server-url").value = "http://127.0.0.1:${CHANNEL_PORT}";
    document.getElementById("pair-code").value = ${JSON.stringify(pairing.code)};
    document.getElementById("pair-join-code").click();
    return true;
  })()`);

  // Observe the console approval prompt and approve it, like `npm run pair`.
  let approved = false;
  for (let i = 0; i < 200; i++) {
    const view = await admin(`/admin/pairing/${pairing.id}/events?after=-1`);
    if (view.events.some((event) => event.type === "awaiting-approval")) {
      const sas = view.events.find((event) => event.type === "awaiting-approval")?.data?.sas;
      const browserSas = await evaluate(`document.getElementById("pair-verify")?.textContent || ""`);
      console.log("SAS browser:", browserSas, "server:", sas);
      assert(browserSas === sas, "the browser and server SAS match");
      await admin(`/admin/pairing/${pairing.id}/approve`, { method: "POST", body: { approve: true } });
      approved = true;
      break;
    }
    await sleep(200);
  }
  assert(approved, "pairing reached the approval step");

  // The tab binds the mirror and reloads; the resume path takes over.
  await waitFor(
    `!!localStorage.getItem("bob:server:default") && (document.getElementById("status")?.textContent || "").includes("opfs")`,
    "post-pairing boot",
    90_000,
  );
  await waitFor(
    `(() => {
      const chip = document.getElementById("mirror-status");
      return chip && !chip.hidden && (chip.textContent || "").startsWith("desktop:") &&
        !(chip.textContent || "").includes("waiting");
    })()`,
    "desktop chip",
    60_000,
  );

  if (process.env.BOOTSTRAP === "1") {
    // A non-empty desktop folder replaces the tab's seeded workspace.
    await waitFor(
      `(async () => {
        const root = await navigator.storage.getDirectory();
        const profiles = await root.getDirectoryHandle("profiles");
        const dir = await profiles.getDirectoryHandle("default");
        const workspace = await dir.getDirectoryHandle("workspace");
        const file = await workspace.getFileHandle("desktop-only.txt");
        return (await (await file.getFile()).text()) === "from the desktop";
      })()`,
      "bootstrap copied the desktop workspace",
      60_000,
    );
    const seeded = await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const profiles = await root.getDirectoryHandle("profiles");
      const dir = await profiles.getDirectoryHandle("default");
      const workspace = await dir.getDirectoryHandle("workspace");
      return workspace.getFileHandle("models.json").then(() => true, () => false);
    })()`);
    assert(!seeded, "the old seeded workspace was replaced");
    const files = await readdir(path.join(STATE, "folders/default"));
    assert(!files.includes("app"), "the tab did not push its seed over the desktop copy");
    console.log("bootstrap: desktop copy replaced the workspace");
  } else {
    // OPFS → mirror: the seeded workspace arrives in the folder.
    const seeded = await waitFile(path.join(STATE, "folders/default/models.json"), 60_000);
    assert(seeded.length > 0, "the workspace reached the mirror folder");
    const files = await waitDirEntry(path.join(STATE, "folders/default"), "app", 30_000);
    assert(files.includes("patterns"), "workspace trees reached the mirror");
    console.log("mirror folder:", files.slice(0, 8).join(", "));
  }

  await waitFor(`!!window.__bobServer`, "desktop ops link", 60_000);
  const ops = await evaluate(`window.__bobServer.run("git", ["--version"])`);
  assert(String(ops?.output ?? "").includes("git version"), "an allowlisted op reached the desktop");
  const workerOps = await evaluate(`window.__bobOpsProbe("git", ["--version"])`);
  assert(String(workerOps ?? "").includes("git version"), "the worker routed an allowlisted op");
  const wrote = await evaluate(`window.__bobServer.run("sh", ["-c", "echo made-by-op > from-op.txt"])`);
  assert(!wrote?.error, `desktop op failed: ${wrote?.error ?? ""}`);
  assert(
    Array.isArray(wrote?.changed) && wrote.changed.includes("from-op.txt"),
    "the op reported the file it wrote",
  );
  await waitFor(
    `(async () => {
      const root = await navigator.storage.getDirectory();
      const profiles = await root.getDirectoryHandle("profiles");
      const dir = await profiles.getDirectoryHandle("default");
      const workspace = await dir.getDirectoryHandle("workspace");
      const file = await workspace.getFileHandle("from-op.txt");
      return (await (await file.getFile()).text()).includes("made-by-op");
    })()`,
    "op output converged into OPFS",
    30_000,
  );

  const peers = JSON.parse(await readFile(path.join(STATE, "peers.json"), "utf8"));
  assert(peers.peers?.default?.capabilities?.mirror === "default", "the server recorded the paired profile");
  const registry = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    return JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  })()`);
  assert(registry.profiles.find((p) => p.name === "default")?.kind === "desktop", "the tab stored the mirror binding");

  // Silent reconnect after a reload.
  const before = (await admin("/admin/peers")).peers.length;
  await send("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.readyState === "complete" && (document.getElementById("status")?.textContent || "").includes("opfs")`,
    "boot after reload",
  );
  await waitFor(
    `(() => {
      const chip = document.getElementById("mirror-status");
      return chip && !chip.hidden && (chip.textContent || "").startsWith("desktop:") &&
        !(chip.textContent || "").includes("waiting");
    })()`,
    "reconnect chip",
    60_000,
  );
  const after = (await admin("/admin/peers")).peers.length;
  assert(before === after, "reconnect did not create a new pairing");
  console.log("reconnect: silent");

  // Desktop → OPFS: a file written on the server side reaches the tab.
  await writeFile(path.join(STATE, "folders/default/from-desktop.txt"), "written on the desktop");
  await waitFor(
    `(async () => {
      const root = await navigator.storage.getDirectory();
      const profiles = await root.getDirectoryHandle("profiles");
      const dir = await profiles.getDirectoryHandle("default");
      const workspace = await dir.getDirectoryHandle("workspace");
      const file = await workspace.getFileHandle("from-desktop.txt");
      return (await (await file.getFile()).text()) === "written on the desktop";
    })()`,
    "desktop file pulled into OPFS",
    60_000,
  );
  console.log("desktop → OPFS: propagated");
  assert(exceptions.length === 0, `no page exceptions: ${exceptions.join(" | ")}`);
  console.log("peer smoke: pairing, SAS, mirror propagation and silent reconnect OK");
} catch (err) {
  const debug = await evaluate(`JSON.stringify({
    status: document.getElementById("status")?.textContent,
    chip: document.getElementById("mirror-status")?.textContent,
    chipTitle: document.getElementById("mirror-status")?.title,
    chipHidden: document.getElementById("mirror-status")?.hidden,
    link: localStorage.getItem("bob:server:default"),
    active: localStorage.getItem("bob:profile"),
    pairStatus: document.getElementById("pair-status")?.textContent,
  })`).catch((e) => `debug failed: ${e}`);
  const mirror = path.join(STATE, "folders/default");
  const files = await readdir(mirror).catch((e) => String(e));
  cleanup(1, `peer smoke failed: ${err instanceof Error ? err.message : String(err)}\n${debug}\nmirror ${mirror}: ${JSON.stringify(files)}`);
}
cleanup(0);
