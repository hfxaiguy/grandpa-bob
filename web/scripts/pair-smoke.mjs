// Live cross-device pairing smoke THROUGH the real BobSwap signaling service.
//
//   device A: tab 1 (its own browser instance) → creates a sync channel
//   device B: tab 2 (another browser instance) → joins with channel + code
//   both     : phrases must render and MATCH; data channel opens
//
// Requires a served build, Chromium, and ~/.bobkat/bobswap.json (the
// upload-scope key is accepted for signaling: read, upload or manage scope).
//   node web/scripts/pair-smoke.mjs
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

// ── the BobSwap service (already saved by publish-seed; readKey = upload key) ─
const keyPath = path.join(os.homedir(), ".bobkat", "bobswap.json");
if (!existsSync(keyPath)) {
  console.log("pair smoke: SKIPPED (no ~/.bobkat/bobswap.json — no signaling credentials to test with)");
  process.exit(0);
}
const cfg = JSON.parse(readFileSync(keyPath, "utf8"));
const SERVICE = { baseUrl: cfg.url ?? cfg.baseUrl, readKey: cfg.uploadKey ?? cfg.readKey, account: cfg.account };
assert(SERVICE.baseUrl && SERVICE.readKey, "bobswap.json must have a url + uploadKey/readKey");

// ── an own origin for the run: fresh serve port → fresh OPFS everywhere ──
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}
const SERVE_PORT = await freePort();
const BASE = process.env.WEB_URL ?? `http://127.0.0.1:${SERVE_PORT}`;
const serve = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "serve.mjs")],
  { env: { ...process.env, PORT: String(SERVE_PORT), HOST: "127.0.0.1" }, stdio: "ignore" });

const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = (i) => path.join(os.tmpdir(), `bob-pair-smoke-${process.pid}-${i}`);
const CDP = (i) => Number(process.env.CDP_PORT ?? 9240) + i;

const procs = [];
function launch(i) {
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP(i)}`, `--user-data-dir=${PROFILE(i)}`, "about:blank",
  ], { stdio: "ignore" });
  procs.push(chrome);
  return chrome;
}
function cleanup(code, message) {
  for (const c of procs) { try { c.kill("SIGKILL"); } catch {} }
  try { serve.kill("SIGKILL"); } catch {}
  try { rmSyncProfiles(); } catch {}
  if (message) console.error(message);
  process.exit(code);
}
const rmSyncProfiles = () => { for (let i = 0; i < 2; i++) try { rmSync(PROFILE(i), { recursive: true, force: true }); } catch {} };

setTimeout(() => cleanup(2, "timeout: pair smoke did not finish"), 420_000).unref();

const getJSON = async (port, p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

async function connect(i, url) {
  const port = CDP(i);
  let version;
  for (let k = 0; k < 150 && !version; k++) { try { version = await getJSON(port, "/json/version"); } catch { await sleep(100); } }
  assert(version, `browser ${i} devtools unreachable`);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
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
  const waitFor = async (expression, label, timeout = 90_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch { /* navigation in flight */ }
      await sleep(250);
    }
    throw new Error(`timeout waiting for ${label} (device ${i})`);
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { send, evaluate, waitFor, close: () => fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}) };
}

const booted = `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && (document.getElementById("status")?.textContent || "").includes("browser")`;

// The service must be in localStorage before the pair dialog can use it; a
// first navigation to the origin, one setItem + one reload does it.
const injectService = (page) => page.evaluate(`localStorage.setItem("bob:swap", JSON.stringify({ active: ${JSON.stringify(SERVICE.baseUrl)}, services: { ${JSON.stringify(SERVICE.baseUrl)}: ${JSON.stringify(SERVICE)} } }))`);

const navAhead = (page, url) => page.send("Page.navigate", { url });

const makeSide = async (i) => {
  launch(i);
  console.error(`   [device ${i}] launching…`);
  const page = await connect(i, `${BASE}/?storage=browser`);
  await page.waitFor(booted, "first boot");
  console.error(`   [device ${i}] booted`);
  await injectService(page);
  console.error(`   [device ${i}] service saved → reload`);
  await navAhead(page, `${BASE}/?storage=browser&fresh=${Date.now()}`);
  await page.waitFor(booted, "boot after the service was saved");
  console.error(`   [device ${i}] rebooted`);
  await page.evaluate(`document.getElementById("sync-menu").click()`);
  await page.waitFor(`document.getElementById("sync-dialog").open`, "sync dialog");
  await page.evaluate(`document.getElementById("live-pair").click()`);
  await page.waitFor(`document.getElementById("pair-dialog").open`, "pair dialog");
  console.error(`   [device ${i}] pair dialog open`);
  return page;
};

try {
  const a = await makeSide(0);
  const b = await makeSide(1);
  console.log("ok  both devices booted with the BobSwap service configured");

  // device A: create the channel
  await a.evaluate(`document.getElementById("pair-swap-offer").click()`);
  const channel = await a.waitFor(`document.getElementById("pair-swap-channel").textContent.startsWith("sc_") && document.getElementById("pair-swap-code").textContent.match(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/) ? document.getElementById("pair-swap-channel").textContent.trim() + "|" + document.getElementById("pair-swap-code").textContent.trim() : false`, "bobswap channel create");
  const [id, code] = channel.split("|");
  console.log(`ok  device A created channel ${id} (pairing code ${code})`);

  // device B: join with channel + code
  await b.evaluate(`document.getElementById("pair-swap-channel-input").value = ${JSON.stringify(id)}`);
  await b.evaluate(`document.getElementById("pair-swap-code-input").value = ${JSON.stringify(code)}`);
  await b.evaluate(`document.getElementById("pair-swap-join").click()`);

  // both sides converge to "connected" with a rendered phrase
  const doneExpr = `(() => {
    const v = document.getElementById("pair-verify").textContent.trim();
    const s = document.getElementById("pair-status").textContent;
    return v && v !== "—" && s.includes("connected") ? v : false;
  })()`;
  const dump = (tag, page) => page.evaluate(
    `(JSON.stringify({ status: document.getElementById("pair-status").textContent, verify: document.getElementById("pair-verify").textContent, channel: document.getElementById("pair-swap-channel").textContent, live: document.getElementById("live-sync-status").textContent }))`,
  ).then((v) => console.error(`   [${tag}] ${v}`)).catch(() => {});
  let phraseA, phraseB;
  try {
    phraseA = await a.waitFor(doneExpr, "device A connected with a phrase", 120_000);
  } catch (err) { await dump("A", a); throw err; }
  try {
    phraseB = await b.waitFor(doneExpr, "device B connected with a phrase", 120_000);
  } catch (err) { await dump("B", b); throw err; }
  console.log(`ok  device A phrase: ${phraseA}`);
  console.log(`ok  device B phrase: ${phraseB}`);
  assert(phraseA === phraseB, "both devices must render the SAME verification phrase");

  const liveA = await a.evaluate(`JSON.stringify({st: document.getElementById("live-sync-status").textContent})`);
  console.log(`ok  live-sync status (A): ${JSON.parse(liveA).st}`);
  console.log("pair smoke: bobswap signaling + data channel + phrase all passed");
  cleanup(0);
} catch (err) {
  cleanup(1, `pair smoke failed: ${err instanceof Error ? err.message : err}`);
}
