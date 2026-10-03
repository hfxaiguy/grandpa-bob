// Headless-browser smoke runner for the browser target.
//
// Loads the app in a real Chromium, waits for the page's `#out` element to
// report OK/ERROR, and prints the output plus any console errors. Requires a
// Chromium/Chrome binary and the dev server (npm run dev).
//
//   node smoke.mjs [url]        # default http://localhost:5173/
//   CHROME_BIN=/path/to/chrome node smoke.mjs
//
// Zero dependencies (global fetch + WebSocket on Node 22+).
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.CDP_PORT ?? 9222);
const TARGET = process.argv[2] ?? process.env.WEB_URL ?? "http://localhost:5173/";
const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = path.join(os.tmpdir(), `bob-web-smoke-${PORT}-${process.pid}`);

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

const logs = [];
function cleanup(code) {
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
setTimeout(() => { console.error("timeout: chrome did not finish"); cleanup(2); }, 120_000).unref();

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
let loaded = false;
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Page.loadEventFired") loaded = true;
  if (msg.method === "Runtime.consoleAPICalled") {
    logs.push(`[console.${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.exception?.description ?? d.text}`);
  }
};
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: TARGET });
for (let i = 0; i < 60 && !loaded; i++) await sleep(100);

let out = "";
for (let i = 0; i < 280; i++) {
  const r = await send("Runtime.evaluate", {
    expression: "document.getElementById('out')?.textContent ?? document.body?.innerText ?? ''",
    returnByValue: true,
  });
  out = r.result?.result?.value ?? "";
  if (out.includes("SMOKE_DONE") || /ERROR:/.test(out)) break;
  await sleep(250);
}

console.log("=== PAGE OUTPUT ===");
console.log(out.trim() || "(empty)");

// Drive the chat UI if present.
let chatOk = true;
const hasChat = await send("Runtime.evaluate", {
  expression: "!!document.getElementById('chat-input') && !document.getElementById('chat-send').disabled",
  returnByValue: true,
});
if (hasChat.result?.result?.value) {
  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.getElementById('chat-input');
      const send = document.getElementById('chat-send');
      input.disabled = false; send.disabled = false;
      input.value = 'smoke ping';
      document.getElementById('chat-form').requestSubmit();
      return true;
    })()`,
    returnByValue: true,
  });
  let reply = "";
  for (let i = 0; i < 80; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "Array.from(document.querySelectorAll('.msg-assistant')).map((e) => e.textContent).pop() ?? ''",
      returnByValue: true,
    });
    reply = r.result?.result?.value ?? "";
    if (reply) break;
    await sleep(250);
  }
  console.log("=== CHAT REPLY ===");
  console.log(reply || "(none)");
  chatOk = reply.startsWith("llm-says");
} else {
  console.log("=== CHAT REPLY ===\n(chat not ready)");
}

// Click the git Sync button only when the URL explicitly configures a remote.
let syncOk = true;
const wantsSync = TARGET.includes("gitremote=");
const syncReady = await send("Runtime.evaluate", {
  expression: "!!document.getElementById('git-sync') && !!document.getElementById('git-remote')?.value",
  returnByValue: true,
});
if (wantsSync && syncReady.result?.result?.value) {
  await send("Runtime.evaluate", {
    expression: "document.getElementById('git-sync').click(); true",
    returnByValue: true,
  });
  let syncMsg = "";
  for (let i = 0; i < 80; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "Array.from(document.querySelectorAll('.msg-assistant')).map((e) => e.textContent).pop() ?? ''",
      returnByValue: true,
    });
    syncMsg = r.result?.result?.value ?? "";
    if (/pushed|sync failed|committed/.test(syncMsg)) break;
    await sleep(250);
  }
  console.log("=== SYNC RESULT ===");
  console.log(syncMsg || "(none)");
  syncOk = /pushed/.test(syncMsg) && !/sync failed/.test(syncMsg);
}

if (logs.length) {
  console.log("=== CONSOLE ===");
  console.log(logs.join("\n"));
}
ws.close();
cleanup(out.includes("SMOKE_DONE") && !/ERROR:/.test(out) && chatOk && syncOk ? 0 : 3);
