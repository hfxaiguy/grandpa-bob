// Headless check for workspace profiles: pre-profile OPFS migration, profile
// creation/switching, export scoping and seed-binding persistence.
// Requires a served build (npm run web:standalone or the admin) and Chromium.
//   node scripts/profile-smoke.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// The run gets its OWN origin (a fresh serve port → a fresh OPFS) so repeated
// smoke attempts never inherit another run's profiles/workspace state from a
// browser's earlier tabs (which would make the legacy migration see a fully
// seeded default profile and refuse verification).
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
const SERVE_PORT = await freePort();
const BASE = process.env.WEB_URL ?? `http://127.0.0.1:${SERVE_PORT}`;
const PORT = Number(process.env.CDP_PORT ?? 9225);
const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = path.join(os.tmpdir(), `bob-profile-smoke-${process.pid}`);

const serve = spawn(
  process.execPath,
  [path.join(path.dirname(new URL(import.meta.url).pathname), "serve.mjs")],
  { env: { ...process.env, PORT: String(SERVE_PORT), HOST: "127.0.0.1" }, stdio: "ignore" },
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
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup(code, message) {
  try { chrome.kill("SIGKILL"); } catch {}
  try { serve.kill("SIGKILL"); } catch {}
  try { serve.kill("SIGKILL"); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  if (message) console.error(message);
  process.exit(code);
}
setTimeout(() => cleanup(2, "timeout: profile smoke did not finish"), 480_000).unref();

const getJSON = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
let version;
for (let i = 0; i < 150 && !version; i++) {
  try { version = await getJSON("/json/version"); } catch { await sleep(100); }
}
if (!version) cleanup(1, "chrome devtools unreachable");

let page;
try {
  page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
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
  if (msg.method === "Runtime.consoleAPICalled") {
    const line =
      "[console] " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
    // Seed diagnostics are expected boot output (private shelf fallback,
    // freshness checks); real app exceptions still fail the run.
    if (!/^\[console\] \[(?:seed-bootstrap|seed-check)\]/.test(line)) exceptions.push(line);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result?.result?.value;
}
async function waitFor(expression, label, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch { /* navigation in flight */ }
    await sleep(250);
  }
  const stateDump = await evaluate(
    `(async () => {
      return JSON.stringify({
        status: document.getElementById("status")?.textContent || null,
        lease: window.__leaseState ? window.__leaseState() : "nohook",
        banner: !!document.getElementById("bob-lease-banner"),
        bannerText: document.getElementById("bob-lease-banner")?.textContent || null,
        locks: await navigator.locks.query().then((q) => JSON.stringify(q.held.map((h) => h.name).concat(q.pending.map((p) => "pending:" + p.name))), () => "?"),
      });
    })()`,
  ).catch(() => "n/a");
  throw new Error(`timeout waiting for ${label} (state: ${stateDump})`);
}
const assert = (condition, message) => { if (!condition) throw new Error(`assertion failed: ${message}`); };

await send("Runtime.enable"); await send("Log.enable");
await send("Page.enable");

// 1. Seed a pre-profile OPFS layout from a page with no app code (same origin).
await send("Page.navigate", { url: `${BASE}/seed/meta.json` });
await sleep(800);
await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const ws = await root.getDirectoryHandle("workspace", { create: true });
  const patterns = await ws.getDirectoryHandle("patterns", { create: true });
  const legacy = await patterns.getFileHandle("legacy.mjs", { create: true });
  const w1 = await legacy.createWritable(); await w1.write("export default { legacy: true };"); await w1.close();
  const marker = await ws.getFileHandle(".seeded", { create: true });
  const w2 = await marker.createWritable(); await w2.write("2026-01-01T00:00:00.000Z"); await w2.close();
  return "seeded";
})()`);

// 2. Boot the app; migration must move the legacy workspace into default.
await send("Page.navigate", { url: `${BASE}/` });
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && (document.getElementById("status")?.textContent || "").includes("opfs")`,
  "app boot",
);

const migrated = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  let rootWorkspace = false;
  try { await root.getDirectoryHandle("workspace"); rootWorkspace = true; } catch {}
  const def = await root.getDirectoryHandle("profiles");
  const profile = await def.getDirectoryHandle("default");
  const ws = await profile.getDirectoryHandle("workspace");
  const legacy = await (await (await ws.getDirectoryHandle("patterns")).getFileHandle("legacy.mjs")).getFile();
  const status = document.getElementById("status")?.textContent || "";
  const options = [...document.querySelectorAll("#profile-select option")].map((o) => o.value);
  return JSON.stringify({
    names: registry.profiles.map((p) => p.name),
    rootWorkspace,
    legacy: await legacy.text(),
    status,
    options,
    active: localStorage.getItem("bob:profile"),
  });
})()`);
const m = JSON.parse(migrated);
assert(!m.rootWorkspace, "legacy OPFS root must be empty after migration");
assert(m.names.includes("default"), "registry must contain default");
assert(m.legacy.includes("legacy: true"), "legacy workspace file must survive migration");
assert(m.options.includes("default"), "profile picker lists default");

// 3. Create and switch to a new profile through the UI. Creating a fresh
//    workspace requires an explicit seed pick: the first submit must be
//    refused, then the bundled snapshot is picked.
await evaluate(`(async () => {
  document.getElementById("profile-manage").click();
  document.getElementById("profile-new-name").value = "travel";
  document.getElementById("profile-new-source").value = "blank";
  document.getElementById("profile-new-switch").checked = true;
  document.querySelector("#profile-create button[type=submit]").click();
  return "submitted without a seed";
})()`);
await waitFor(
  `(document.getElementById("status")?.textContent || "").includes("pick a seed")`,
  "the seed pick is mandatory",
);
const refused = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  return registry.profiles.some((p) => p.name === "travel");
})()`);
assert(!refused, "a new profile must not be created without a chosen seed");
await evaluate(`(async () => {
  document.getElementById("profile-new-seed").value = "shipped";
  document.querySelector("#profile-create button[type=submit]").click();
  return "submitted with the bundled snapshot";
})()`);
await waitFor(
  `(document.getElementById("status")?.textContent || "").includes("travel") && !!window.__bobWorkspaceTransfer`,
  "travel profile boot",
);
const travel = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const profiles = await root.getDirectoryHandle("profiles");
  const dir = await profiles.getDirectoryHandle("travel");
  const ws = await dir.getDirectoryHandle("workspace");
  let patternFiles = 0;
  try {
    const patterns = await ws.getDirectoryHandle("patterns");
    for await (const [, handle] of patterns.entries()) { if (handle.kind === "file") patternFiles++; }
  } catch {}
  const seeded = await ws.getFileHandle(".seeded").then(() => true, () => false);
  const archive = await window.__bobWorkspaceTransfer.buildWorkspaceArchive();
  return JSON.stringify({
    names: registry.profiles.map((p) => p.name),
    active: localStorage.getItem("bob:profile"),
    patternFiles,
    seeded,
    files: archive.files.length,
    badPaths: archive.files.filter((f) => !f.path.startsWith("workspace/")).map((f) => f.path),
  });
})()`);
const t = JSON.parse(travel);
assert(t.names.includes("travel"), "registry must contain the new profile");
assert(t.active === "travel", "the new profile becomes active");
assert(t.patternFiles > 0 && t.seeded, "a fresh profile is seeded with a workspace");
assert(t.files > 0 && t.badPaths.length === 0, "export is scoped to the active profile with workspace/ paths");

// 4. Configure a service and a seed binding; both must persist. The two
//    dialog modes must not ask for each other's fields.
await evaluate(`document.getElementById("swap-settings").click()`);
const serviceFields = JSON.parse(await evaluate(`(() => {
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== "none";
  return JSON.stringify({
    account: shown("seed-account-label"),
    readKey: shown("seed-read-key-label"),
    uploadKey: shown("seed-upload-key-label"),
    seedName: shown("seed-name-label"),
    service: shown("seed-service-label"),
  });
})()`));
assert(
  serviceFields.account &&
    serviceFields.readKey &&
    serviceFields.uploadKey &&
    !serviceFields.seedName &&
    !serviceFields.service,
  "the BobSwap service dialog shows account/keys but not the seed name or service picker",
);
await evaluate(`(() => {
  document.getElementById("seed-base-url").value = "https://bobswap.example.com";
  document.getElementById("seed-account").value = "personal";
  document.getElementById("seed-read-key").value = "bsk_live_read";
  document.getElementById("seed-upload-key").value = "bsk_live_upload";
  document.getElementById("seed-save").click();
  document.getElementById("seed-close").click();
  document.getElementById("profile-manage").click();
  return "opened";
})()`);
await waitFor(
  `[...document.querySelectorAll("#profile-list .profile-row")].some((row) => row.textContent.includes("travel"))`,
  "profile manager rows",
);
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#profile-list .profile-row")];
  const travelRow = rows.find((row) => row.textContent.includes("travel"));
  [...travelRow.querySelectorAll("button")].find((b) => b.textContent === "Seed…").click();
  return "opened";
})()`);
const bindingFields = JSON.parse(await evaluate(`(() => {
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== "none";
  return JSON.stringify({
    account: shown("seed-account-label"),
    readKey: shown("seed-read-key-label"),
    uploadKey: shown("seed-upload-key-label"),
    seedName: shown("seed-name-label"),
    service: shown("seed-service-label"),
  });
})()`));
assert(
  bindingFields.seedName &&
    bindingFields.service &&
    !bindingFields.account &&
    !bindingFields.readKey &&
    !bindingFields.uploadKey,
  "the profile seed dialog shows the service picker and seed name only",
);
await evaluate(`(() => {
  document.getElementById("seed-service").value = "https://bobswap.example.com";
  document.getElementById("seed-name").value = "trunk";
  document.getElementById("seed-save").click();
  return "saved";
})()`);
await waitFor(
  `!!JSON.parse(localStorage.getItem("bob:swap") || "{}").services?.["https://bobswap.example.com"]`,
  "service persisted",
);
await sleep(600);
const bound = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const travel = registry.profiles.find((p) => p.name === "travel");
  const swap = JSON.parse(localStorage.getItem("bob:swap") || "{}");
  return JSON.stringify({ seed: travel?.seed, services: Object.keys(swap.services || {}) });
})()`);
const b = JSON.parse(bound);
assert(b.seed?.account === "personal" && b.seed?.seedName === "trunk", "seed binding persists per profile");
assert(b.seed?.baseUrl === "https://bobswap.example.com", "binding records the service URL");
assert(b.services.includes("https://bobswap.example.com"), "service + keys persist in localStorage");

// 5. A profile's "hidden… except:" list is editable from its row and persists.
await evaluate(`document.getElementById("seed-close").click()`);
await evaluate(`(() => {
  const row = [...document.querySelectorAll("#profile-list .profile-row")]
    .find((candidate) => candidate.textContent.includes("travel"));
  [...row.querySelectorAll("button")].find((button) => button.textContent === "Hidden… except:").click();
  return "opened board exceptions";
})()`);
await waitFor(
  `document.querySelectorAll("#hidden-app-list input[type=checkbox]").length > 0`,
  "board-exception app list",
);
await evaluate(`(() => {
  for (const box of document.querySelectorAll("#hidden-app-list input[type=checkbox]")) {
    if (box.value === "email" || box.value === "insight") box.checked = true;
  }
  document.getElementById("hidden-save").click();
  return "saved board exceptions";
})()`);
await waitFor(`!document.getElementById("hidden-dialog").open`, "board-exceptions save");
const exposed = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const travel = registry.profiles.find((profile) => profile.name === "travel");
  return JSON.stringify({ visibleApps: travel?.visibleApps, active: window.__bobProfileVisibleApps });
})()`);
const e = JSON.parse(exposed);
const exceptionNames = (value) => JSON.stringify([...(value || [])].sort());
assert(
  exceptionNames(e.visibleApps) === exceptionNames(["email", "insight"]),
  "the profile's visible exceptions persist in the registry",
);
assert(
  exceptionNames(e.active) === exceptionNames(["email", "insight"]),
  "the active profile publishes its visible exceptions to the chat UI",
);

// 6. Switch back to default through the picker.
await evaluate(`(() => {
  const select = document.getElementById("profile-select");
  select.value = "default";
  select.dispatchEvent(new Event("change"));
  return "switching";
})()`);
await waitFor(
  `(document.getElementById("status")?.textContent || "").includes("opfs") && !(document.getElementById("status")?.textContent || "").includes("travel")`,
  "switch back to default",
);
const back = await evaluate(`localStorage.getItem("bob:profile")`);
assert(back === "default", "profile switch persists");

// 7. A zero-byte profiles.json (Gecko can leave one after a torn write) must
//    not be read as "no profiles": the mirror + directories repair it.
await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle("profiles.json");
  const writable = await handle.createWritable();
  await writable.write("");
  await writable.close();
  return "truncated";
})()`);
await send("Page.navigate", { url: `${BASE}/` });
await waitFor(
  `document.readyState === "complete" && (document.getElementById("status")?.textContent || "").includes("opfs")`,
  "boot after a truncated registry",
);
const repaired = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  let raw = "";
  try { raw = await (await (await root.getFileHandle("profiles.json")).getFile()).text(); } catch (e) { raw = "ERR:" + String(e); }
  const names = [];
  for await (const [name, handle] of root.entries()) names.push(name);
  const options = [...document.querySelectorAll("#profile-select option")].map((o) => o.value);
  return JSON.stringify({ raw, names, options, mirror: localStorage.getItem("bob:profile-registry") });
})()`);
const r = JSON.parse(repaired);
const repairedRegistry = JSON.parse(r.raw || "{}");
assert(
  (repairedRegistry.profiles || []).some((p) => p.name === "travel"),
  `a truncated registry is repaired from the mirror/directories — seen: ${JSON.stringify(repaired).slice(0, 300)}`,
);
assert(
  repairedRegistry.profiles?.find((p) => p.name === "travel")?.seed?.seedName === "trunk",
  "the repaired registry keeps the seed binding",
);
assert(r.options.includes("travel"), "the picker still lists the recovered profile");
assert(!!r.mirror, "the localStorage registry mirror is written");

if (exceptions.length) {
  cleanup(1, `runtime exceptions:\n${exceptions.join("\n")}`);
}
console.log("profile smoke: migration, creation, scoping and seed binding all passed");
cleanup(0);
