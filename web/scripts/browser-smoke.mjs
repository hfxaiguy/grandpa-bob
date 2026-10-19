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
if (exceptions.length) { console.log(exceptions.join("\n")); cleanup(5); }
console.log("browser smoke: all assertions passed");
ws.close();
cleanup(0);
