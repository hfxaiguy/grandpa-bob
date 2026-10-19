// Minimal headless check that the OPFS storage mode still boots and writes.
// Requires a dev server (`npx vite --port 5173`) and a Chromium binary.
//   node scripts/browser-smoke.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.CDP_PORT ?? 9224);
const TARGET = process.argv[2] ?? process.env.WEB_URL ?? "http://localhost:5173/?storage=browser";
const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = path.join(os.tmpdir(), `bob-browser-smoke-${PORT}-${process.pid}`);

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
  const root = await navigator.storage.getDirectory();
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

  const root = await navigator.storage.getDirectory();
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
    if (turns.some((t) => t.status === "done" || t.status === "error")) {
      return JSON.stringify({ ok: true, turns: turns.length, status: turns[turns.length - 1].status });
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

if (exceptions.length) { console.log(exceptions.join("\n")); cleanup(5); }
console.log("browser smoke: all assertions passed");
ws.close();
cleanup(0);
