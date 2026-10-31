// Headless check for the single-host lease: two real tabs on one workspace.
//
//   tab 1 boots first            → primary, no lease banner
//   tab 2 boots on same profile  → read-only, banner shown, /api/chat → 503
//   tab 1 closes                 → tab 2 auto-promotes, banner disappears
//
// Requires a served build (npm run web:standalone) and Chromium.
//   node scripts/lease-smoke.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8080";
const PORT = Number(process.env.CDP_PORT ?? 9226);
const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = path.join(os.tmpdir(), `bob-lease-smoke-${process.pid}`);

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
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  if (message) console.error(message);
  process.exit(code);
}
setTimeout(() => cleanup(2, "timeout: lease smoke did not finish"), 180_000).unref();

const getJSON = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

/** One CDP page connection with the harness helpers. */
async function connect(url) {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result?.result?.value;
  };
  const waitFor = async (expression, label, timeout = 60_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch { /* navigation in flight */ }
      await sleep(250);
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { target, send, evaluate, waitFor, close: () => fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {}) };
}

const booted = `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && (document.getElementById("status")?.textContent || "").includes("opfs")`;
/** A secondary tab never wires the transfer UI (it is read-only), so its
 *  boot predicate must not require that hook. */
const bootedReadOnly = `document.readyState === "complete" && (document.getElementById("status")?.textContent || "").includes("opfs")`;

let version;
for (let i = 0; i < 150 && !version; i++) {
  try { version = await getJSON("/json/version"); } catch { await sleep(100); }
}
if (!version) cleanup(1, "chrome devtools unreachable");

try {
  // ── tab 1: the workspace host ────────────────────────────────────────
  const one = await connect(`${BASE}/`);
  await one.waitFor(booted, "tab 1 boot");
  await one.waitFor(`!document.getElementById("bob-lease-banner")`, "tab 1 holds the lease without a banner");
  console.log("ok  tab 1 is the primary host");

  // ── tab 2: same profile → read-only ──────────────────────────────────
  const two = await connect(`${BASE}/?fresh=${Date.now()}`);
  await two.waitFor(bootedReadOnly, "tab 2 boot");
  await two.waitFor(`!!document.getElementById("bob-lease-banner")`, "tab 2 shows the read-only banner");
  const gate = await two.evaluate(`(async () => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "lease smoke should not run this" }),
    });
    return JSON.stringify({ status: res.status, body: await res.json().catch(() => ({})) });
  })()`);
  const gateResult = JSON.parse(gate);
  assert(gateResult.status === 503, `a secondary tab's turn is refused (got ${gateResult.status})`);
  assert(/another tab/.test(gateResult.body?.error ?? ""), "the refusal names the other tab");
  console.log("ok  tab 2 is read-only and its turns are refused (503)");

  // ── close tab 1 → tab 2 takes over ───────────────────────────────────
  await one.close();
  await two.waitFor(`!document.getElementById("bob-lease-banner")`, "tab 2 promotes after tab 1 closes", 30_000);
  console.log("ok  tab 2 auto-promotes when the host closes");

  await two.close();
  console.log("lease smoke: all checks passed");
  cleanup(0);
} catch (err) {
  cleanup(1, `lease smoke failed: ${err instanceof Error ? err.message : err}`);
}
