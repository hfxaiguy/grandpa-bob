// Minimal headless check that the OPFS storage mode still boots and writes.
// Requires the admin (npm run dev at the repo root) and a Chromium binary.
// It starts the bundled mock LLM (web/mock-llm.mjs) and points the tab's model
// settings at it, so a chat turn reaches the engine without a real provider.
//   node scripts/browser-smoke.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// A taken CDP port silently serves /json/* from an older browser whose OPFS
// still holds its own handles — always drive a fresh one unless pinned.
const PORT = process.env.CDP_PORT
  ? Number(process.env.CDP_PORT)
  : await new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
const TARGET = process.argv[2] ?? process.env.WEB_URL ?? "http://localhost:8080/?storage=browser";
const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = path.join(os.tmpdir(), `bob-browser-smoke-${PORT}-${process.pid}`);
const MOCK_PORT = Number(process.env.MOCK_LLM_PORT ?? 8789);
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
const MODELS_JSON = JSON.stringify({
  strong: { baseURL: MOCK_URL, model: "mock-model", apiKey: "test-key" },
  cheap: { baseURL: MOCK_URL, model: "mock-model", apiKey: "test-key" },
  default: { baseURL: MOCK_URL, model: "mock-model", apiKey: "test-key" },
});

const mockLlm = spawn(process.execPath, [fileURLToPath(new URL("./mock-llm.mjs", import.meta.url))], {
  env: { ...process.env, MOCK_LLM_PORT: String(MOCK_PORT) },
  stdio: "ignore",
});

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

function cleanup(code) {
  try { chrome.kill("SIGKILL"); } catch {}
  try { mockLlm.kill("SIGKILL"); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
setTimeout(() => { console.error("timeout: browser smoke did not finish"); cleanup(2); }, 120_000).unref();

async function getJSON(p) {
  return (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
}
let version;
for (let i = 0; i < 150 && !version; i++) {
  try { version = await getJSON("/json/version"); } catch { await sleep(100); }
}
if (!version) { console.error(`chrome devtools unreachable (is ${CHROME} installed?)`); cleanup(1); }

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
};
function send(method, params = {}) {
  return new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result?.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
// Every document boot (including the reload below) talks to the mock LLM.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try { localStorage.setItem("bob:models-json", ${JSON.stringify(MODELS_JSON)}); } catch (e) {}`,
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${MOCK_URL}/models`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(100);
}
await send("Page.navigate", { url: TARGET });

let status = "";
for (let i = 0; i < 200; i++) {
  status = (await evaluate(`document.getElementById("status")?.textContent ?? ""`).catch(() => "")) || "";
  if (status.startsWith("browser ·")) break;
  await sleep(250);
}
if (!status.startsWith("browser ·")) {
  console.error(`browser mode did not boot (status: ${status})`);
  console.log(exceptions.join("\n"));
  cleanup(3);
}
console.log(`status: ${status}`);

const res = await evaluate(`(async () => {
  const backend = window.__bobBackend;
  await backend.ready;
  const r = await backend.request("POST", "/api/patterns", new URLSearchParams(),
    JSON.stringify({ name: "browser-smoke", content: "export default {};\\n" }));
  const root = await window.__bobWorkspaceTransfer.profileRoot();
  const ws = await root.getDirectoryHandle("workspace");
  const patterns = await ws.getDirectoryHandle("patterns");
  const file = await (await patterns.getFileHandle("browser-smoke.mjs")).getFile();
  return JSON.stringify({ status: r.status, text: await file.text() });
})()`);
const parsed = JSON.parse(res);
if (parsed.status !== 200 || !parsed.text.includes("export default")) {
  console.error("OPFS write failed", parsed);
  cleanup(4);
}
console.log("✓ OPFS mode boots and writes to the sandbox workspace");

// The chat model picker must list the real slots (not only "default") and
// accept a role→slot override; the browser backend used to ignore both.
const modelPick = await evaluate(`(async () => {
  const backend = window.__bobBackend;
  await backend.ready;
  const before = await backend.request("GET", "/api/models/slots", new URLSearchParams(), null);
  const names = (before.body?.slots || []).map((s) => s.name);
  if (!names.length) return JSON.stringify({ names, error: "no slots" });
  const role = names.includes("strong") ? "strong" : names[0];
  const target = names.find((n) => n !== role) || names[0];
  const set = await backend.request(
    "POST", "/api/chat/model", new URLSearchParams(),
    JSON.stringify({ role, slot: target }),
  );
  const after = await backend.request("GET", "/api/models/slots", new URLSearchParams(), null);
  return JSON.stringify({ names, set: set.status, overrides: after.body?.models || {}, role, target });
})()`);
const picked = JSON.parse(modelPick);
if (!picked.names?.length || picked.set !== 200 || picked.overrides?.[picked.role] !== picked.target) {
  console.error("model slots/override failed", picked);
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ model picker lists slots and stores a role→slot override");

// Settings → Test talks to /api/models/test. Standalone must answer it in the
// tab (the admin path forwards the 501 to the real server); shape is
// { ok, models } either way.
const modelProbe = await evaluate(`(async () => {
  const backend = window.__bobBackend;
  await backend.ready;
  const r = await backend.request("POST", "/api/models/test", new URLSearchParams(),
    JSON.stringify({ baseURL: location.origin, model: "smoke-probe" }));
  return JSON.stringify({
    status: r.status,
    hasOk: typeof r.body?.ok === "boolean",
    models: Array.isArray(r.body?.models),
  });
})()`);
const probed = JSON.parse(modelProbe);
if (probed.status !== 200 || !probed.hasOk || !probed.models) {
  console.error("model test endpoint failed", probed);
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ model endpoint test answers from the page");

// Header upload button: picker → folder prompt → file lands in the workspace.
const upload = await evaluate(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.getElementById("workspace-upload-input");
  if (!input) return "no upload input";
  const dt = new DataTransfer();
  dt.items.add(new File(["hello upload\\n"], "upload-smoke.txt", { type: "text/plain" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));

  for (let i = 0; i < 40 && !document.querySelector(".drawer-card"); i++) await wait(100);
  const card = document.querySelector(".drawer-card");
  if (!card) return "folder prompt did not open";
  const field = card.querySelector('input[type="text"]');
  if (!field) return "no folder field";
  field.value = "smoke-uploads";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  const button = Array.from(card.querySelectorAll("button")).find((b) => /^upload/.test(b.textContent.trim()));
  if (!button) return "no upload button";
  button.click();
  for (let i = 0; i < 80 && document.querySelector(".drawer-card"); i++) await wait(100);
  if (document.querySelector(".drawer-card")) return "prompt did not close";

  const root = await window.__bobWorkspaceTransfer.profileRoot();
  const workspace = await root.getDirectoryHandle("workspace");
  const dir = await workspace.getDirectoryHandle("smoke-uploads");
  const file = await (await dir.getFileHandle("upload-smoke.txt")).getFile();
  return "uploaded:" + (await file.text()).trim();
})()`);
if (upload !== "uploaded:hello upload") {
  console.error("upload button failed:", upload);
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ upload button writes into the chosen workspace folder");

// Workspace export/import: the Sync dialog's workspace controls exist in OPFS
// mode, Export downloads a valid archive of the live workspace, and Import
// merges files without dropping what the archive does not carry.
const transfer = await evaluate(`(async () => {
  const hook = window.__bobWorkspaceTransfer;
  if (!hook) return "no workspace-transfer hook";
  const exportButton = document.getElementById("ws-export");
  const importButton = document.getElementById("ws-import");
  const tools = document.getElementById("opfs-tools");
  if (!exportButton || !importButton || !tools) return "workspace controls missing";
  if (tools.hidden) return "workspace tools hidden in browser mode";

  // Capture the download the Export button triggers, then read the blob back.
  const originalClick = HTMLAnchorElement.prototype.click;
  let captured = null;
  HTMLAnchorElement.prototype.click = function () {
    captured = { href: this.href, name: this.download };
    return originalClick.call(this);
  };
  exportButton.click();
  for (let i = 0; i < 100 && !captured; i++) await new Promise((r) => setTimeout(r, 100));
  HTMLAnchorElement.prototype.click = originalClick;
  if (!captured) return "export did not trigger a download";

  const blobText = await (await fetch(captured.href)).text();
  const archive = JSON.parse(blobText);
  if (archive.version !== 1 || !Array.isArray(archive.files)) return "exported archive has the wrong shape";
  const paths = archive.files.map((f) => f.path);
  if (!paths.includes("workspace/patterns/browser-smoke.mjs")) return "export is missing a live workspace file";

  // Merge import: one new file lands, the existing pattern stays.
  const restored = await hook.importWorkspace({
    version: 1,
    createdAt: new Date().toISOString(),
    files: [{ path: "workspace/smoke-import.txt", base64: btoa("imported by smoke") }],
  });
  const root = await hook.profileRoot();
  const ws = await root.getDirectoryHandle("workspace");
  const imported = await (await (await ws.getFileHandle("smoke-import.txt")).getFile()).text();
  const kept = await (await (await ws.getDirectoryHandle("patterns")).getFileHandle("browser-smoke.mjs")).getFile();

  let rejected = false;
  try { hook.validateWorkspaceArchive({ version: 2, createdAt: "", files: [] }); } catch { rejected = true; }

  return JSON.stringify({
    restored,
    imported,
    kept: (await kept.text()).includes("export default"),
    rejected,
    name: captured.name,
    status: document.getElementById("status")?.textContent || "",
  });
})()`);
const moved = JSON.parse(String(transfer));
if (
  moved.restored !== 1 ||
  moved.imported !== "imported by smoke" ||
  !moved.kept ||
  !moved.rejected ||
  !String(moved.name).endsWith(".json") ||
  !String(moved.status).includes("exported")
) {
  console.error("workspace export/import failed", transfer);
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ workspace export downloads an archive and import merges into OPFS");

// Sessions: a turn lands in the workspace KAT log and survives a reload.
const chat = await evaluate(`(async () => {
  const backend = window.__bobBackend;
  await backend.ready;
  const sent = await backend.request("POST", "/api/chat", new URLSearchParams(),
    JSON.stringify({ text: "session persistence smoke" }));
  if (sent.status !== 200) return "chat " + sent.status;
  for (let i = 0; i < 120; i++) {
    const r = await backend.request("GET", "/api/turns", new URLSearchParams(), null);
    const turns = r.body?.turns || [];
    const last = turns[turns.length - 1];
    if (last && (last.status === "done" || last.status === "error")) {
      // A logged row's seq is the ref address; keep one for the reload check.
      const row = (last.events || []).filter((e) => Number.isInteger(e.seq)).pop();
      return JSON.stringify({
        ok: true, turns: turns.length, status: last.status,
        seq: row?.seq ?? null, kind: row?.kind ?? null,
      });
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return "turn timeout";
})()`);
if (!String(chat).startsWith("{\"ok\":true")) {
  console.error("session turn failed:", chat);
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ a turn is written to the workspace KAT log");

await send("Page.reload", { ignoreCache: true });
let rebooted = "";
for (let i = 0; i < 240; i++) {
  rebooted = (await evaluate(`document.getElementById("status")?.textContent ?? ""`).catch(() => "")) || "";
  if (rebooted.startsWith("browser ·")) break;
  await sleep(250);
}
const restored = await evaluate(`(async () => {
  for (let i = 0; i < 100 && !window.__bobBackend; i++) await new Promise((r) => setTimeout(r, 100));
  const backend = window.__bobBackend;
  if (!backend) return "no backend after reload";
  await backend.ready;
  const d = await backend.request("GET", "/api/session", new URLSearchParams(), null);
  const old = (d.body?.sessions || []).find((s) => s.turns > 0 && String(s.label).includes("session persistence"));
  return old ? "restored:" + old.turns : "missing:" + JSON.stringify(d.body?.sessions || []);
})()`);
if (!String(restored).startsWith("restored:")) {
  console.error("session did not survive reload:", restored);
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ sessions survive a reload (workspace KAT log)");

// The paused run must resume after the reload, not re-seed the conversation:
// the browser logger shadowed the checkpoint, and the cold worker restored it
// before choosing knit-vs-resume (the "try again" regression).
const resumed = await evaluate(`(async () => {
  const backend = window.__bobBackend;
  await backend.ready;
  const sent = await backend.request("POST", "/api/chat", new URLSearchParams(),
    JSON.stringify({ text: "continue after reload" }));
  if (sent.status !== 200) return "chat " + sent.status;
  for (let i = 0; i < 120; i++) {
    const r = await backend.request("GET", "/api/turns", new URLSearchParams(), null);
    const turns = r.body?.turns || [];
    const last = turns[turns.length - 1];
    if (last && (last.status === "done" || last.status === "error")) {
      return JSON.stringify({
        status: last.status,
        error: last.error ?? null,
        runMode: last.runMode ?? null,
        contextLost: last.contextLost ?? null,
        turns: turns.length,
      });
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return "turn timeout";
})()`);
let second = null;
try {
  second = JSON.parse(String(resumed));
} catch {
  /* reported below */
}
if (!second || second.status !== "done" || second.runMode !== "restored" || second.contextLost) {
  const probe = await evaluate(
    `fetch("${MOCK_URL}/models").then((r) => "ok:" + r.status).catch((e) => "err:" + e.message)`,
  ).catch((e) => "eval:" + e.message);
  console.error("the reloaded worker did not restore the paused session:", resumed, {
    mockExit: mockLlm.exitCode,
    mockSignal: mockLlm.signalCode,
    probe,
  });
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ the first turn after a reload restores the paused run (runMode restored)");

// Memory rebuilds from the same log after the reload: the page-local tracker
// starts empty, so /api/tree/memory must replay the raw memory-slot rows (the
// sanitized per-turn event window is tail-capped and would lose early writes).
const memory = await evaluate(`(async () => {
  const backend = window.__bobBackend;
  await backend.ready;
  const d = await backend.request("GET", "/api/session", new URLSearchParams(), null);
  const key = d.body?.active;
  const m = await backend.request("GET", "/api/tree/memory",
    new URLSearchParams(key ? { session: key } : {}), null);
  return JSON.stringify({ status: m.status, apps: m.body?.apps || {}, key });
})()`);
const panel = JSON.parse(String(memory));
const trunkPaths = Object.keys(panel.apps?.trunk || {});
if (panel.status !== 200 || !trunkPaths.some((p) => p.endsWith("/conversation"))) {
  console.error("memory did not rebuild after reload:", memory);
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ memory panel rebuilds from the log after reload");

// The reloaded page has no streamed events in memory: /api/ref must read the
// row from the workspace log DB, at the same seq the engine logged.
const logged = JSON.parse(String(chat));
if (Number.isInteger(logged.seq)) {
  const ref = await evaluate(`(async () => {
    const backend = window.__bobBackend;
    await backend.ready;
    const r = await backend.request("GET", "/api/ref",
      new URLSearchParams({ seq: "${logged.seq}" }), null);
    return JSON.stringify({ status: r.status, seq: r.body?.seq, kind: r.body?.kind,
      chars: r.body?.chars, error: r.body?.error });
  })()`);
  const got = JSON.parse(ref);
  if (got.status !== 200 || got.seq !== logged.seq || got.kind !== logged.kind) {
    console.error("ref did not resolve against the workspace log:", { logged, got });
    console.log(exceptions.join("\n"));
    cleanup(5);
  }
  console.log("✓ ref:// resolves against the workspace log after reload");
}

// The Import button itself: a picked archive is validated, confirmed, merged,
// and the tab reloads. The hook check above covered only the OPFS half.
const dispatched = await evaluate(`(() => {
  const input = document.getElementById("ws-import-file");
  if (!input) return "no import input";
  window.confirm = () => true;
  window.__beforeImport = true;
  const archive = {
    version: 1,
    createdAt: new Date().toISOString(),
    files: [{ path: "workspace/smoke-import-ui.txt", base64: btoa("ui import") }],
  };
  const dt = new DataTransfer();
  dt.items.add(new File([JSON.stringify(archive)], "bob-workspace-smoke.json", { type: "application/json" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "dispatched";
})()`);
if (dispatched !== "dispatched") {
  console.error("import button dispatch failed:", dispatched);
  console.log(exceptions.join("\n"));
  cleanup(5);
}
let rebootedAfterImport = false;
for (let i = 0; i < 240 && !rebootedAfterImport; i++) {
  rebootedAfterImport = await evaluate(
    `window.__beforeImport === undefined &&
      (document.getElementById("status")?.textContent || "").startsWith("browser ·")`,
  ).catch(() => false);
  if (!rebootedAfterImport) await sleep(250);
}
const uiImport = await evaluate(`(async () => {
  const root = await window.__bobWorkspaceTransfer.profileRoot();
  const ws = await root.getDirectoryHandle("workspace");
  const text = await (await (await ws.getFileHandle("smoke-import-ui.txt")).getFile()).text();
  const seeded = await ws.getFileHandle(".seeded").then((h) => h.getFile()).then((f) => f.size > 0).catch(() => false);
  return JSON.stringify({ text, seeded });
})()`).catch((err) => String(err));
let ui = null;
try {
  ui = JSON.parse(String(uiImport));
} catch {
  /* the check below reports the raw evaluate result */
}
if (!rebootedAfterImport || !ui || ui.text !== "ui import" || !ui.seeded) {
  console.error("import button failed:", { rebootedAfterImport, uiImport });
  console.log(exceptions.join("\n"));
  cleanup(5);
}
console.log("✓ the Import button merges a picked archive and reloads");

if (exceptions.length) { console.log(exceptions.join("\n")); cleanup(5); }
console.log("browser smoke: all assertions passed");
ws.close();
cleanup(0);
