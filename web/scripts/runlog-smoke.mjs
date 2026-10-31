// Browser check for the streaming run log (opfs-sahpool) and its migration:
//   1. boot the app on a fresh profile (seeds an empty legacy log),
//   2. replace the legacy log with a prepared one that carries a marker row,
//   3. drop the streaming pool directory so the next boot must import it,
//   4. reload and prove the imported session is visible and writable.
//
// Requires the standalone server (`npm run web:standalone`) and Chromium.
//   node scripts/runlog-smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// The CDP port must be fresh per run: Chromium cannot rebind a taken port
// and defers silently, so a leftover browser squatting on a fixed default
// would serve /json/* instead — the smoke would then drive THAT browser,
// whose OPFS still holds sync access handles from its own session
// (removeEntry -> NoModificationAllowedError forever).
import net from "node:net";
const PORT = process.env.CDP_PORT
  ? Number(process.env.CDP_PORT)
  : await new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
const TARGET = process.argv[2] ?? process.env.WEB_URL ?? "http://localhost:8080/";
const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = path.join(os.tmpdir(), `bob-runlog-smoke-${PORT}-${process.pid}`);
const SESSION = "web:migrate-smoke";
const INPUT = "migration-smoke";

// ── the legacy log we will plant ────────────────────────────────────────────
const tmp = mkdtempSync(path.join(os.tmpdir(), "bob-runlog-legacy-"));
const legacyFile = path.join(tmp, "grandma-kat.db");
const now = Date.now();
const legacy = new DatabaseSync(legacyFile);
legacy.exec(`
CREATE TABLE calls (
  run_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_path TEXT,
  iteration INTEGER,
  scope_id INTEGER,
  kind TEXT NOT NULL,
  content TEXT
);
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  resume_positions TEXT NOT NULL
);`);
legacy
  .prepare(
    "INSERT INTO calls (run_id, definition_id, seq, branch_path, iteration, scope_id, kind, content) VALUES (?, 'web', 1, NULL, 0, NULL, 'web_turn_end', ?)",
  )
  .run(
    SESSION,
    JSON.stringify({
      key: SESSION,
      turnId: randomUUID(),
      runId: null,
      fromSeq: null,
      toSeq: null,
      input: INPUT,
      inputApp: "trunk",
      startedAt: now - 1000,
      endedAt: now,
      status: "done",
      output: "imported from the legacy run log",
      emits: null,
      levels: null,
      emitApps: null,
      buttons: null,
      awaiting: null,
      ts: now,
    }),
  );
legacy.close();
// A few megabytes of engine rows make the import run across several chunks,
// proving the migration never needs the whole file in the wasm heap.
const bulk = new DatabaseSync(legacyFile);
const bulkStmt = bulk.prepare(
  "INSERT INTO calls (run_id, definition_id, seq, branch_path, iteration, scope_id, kind, content) VALUES (?, 'trunk:deadbeef', ?, '', 0, 0, 'llm_call', ?)",
);
for (let i = 0; i < 4; i += 1) {
  bulkStmt.run("2026-10-20_00-00-00-0", 10 + i, JSON.stringify({ text: "x".repeat(1024 * 1024) }));
}
bulk.close();
const legacyBytes = readFileSync(legacyFile);
const legacyB64 = legacyBytes.toString("base64");
const legacySize = statSync(legacyFile).size;

// ── Chromium + CDP ──────────────────────────────────────────────────────────
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
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
setTimeout(() => { console.error("timeout: runlog smoke did not finish"); cleanup(2); }, 180_000).unref();

async function getJSON(p) {
  return (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
}
let version;
for (let i = 0; i < 150 && !version; i++) {
  try { version = await getJSON("/json/version"); } catch { await sleep(100); }
}
if (!version) { console.error(`chrome devtools unreachable (is ${CHROME} installed?)`); cleanup(1); }

const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
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
async function evaluate(expression, attempts = 1) {
  for (let i = 0; i < attempts; i++) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (!r.result?.exceptionDetails) return r.result?.result?.value;
    if (i === attempts - 1) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
    await sleep(250);
  }
  return undefined;
}
async function waitForBoot() {
  for (let i = 0; i < 240; i++) {
    const status = (await evaluate(`document.getElementById("status")?.textContent ?? ""`).catch(() => "")) || "";
    if (status.startsWith("browser ·")) return status;
    await sleep(250);
  }
  return "";
}
async function sessionState() {
  return JSON.parse(
    await evaluate(`(async () => {
      const b = window.__bobBackend;
      await b.ready;
      const r = await b.request("GET", "/api/session", new URLSearchParams(), null);
      return JSON.stringify({ status: r.status, body: r.body });
    })()`),
  );
}

await send("Runtime.enable");
await send("Page.enable");

// ── 1. first boot: seeds the workspace and opens the streaming log ──────────
await send("Page.navigate", { url: TARGET });
if (!(await waitForBoot())) { console.error("app did not boot"); console.log(exceptions.join("\n")); cleanup(3); }
const first = await sessionState();
if (first.status !== 200) { console.error("session endpoint failed on first boot", first); cleanup(4); }
console.log("✓ first boot opens the streaming run log");

// ── 2. plant the legacy log and clear the pool ──────────────────────────────
// Navigate the app tab to about:blank (same origin, no worker) so the pool's
// sync access handles are released before we remove its directory.
await evaluate(`location.href = "about:blank"; "navigating"`).catch(() => {});
await sleep(800);
const planted = await evaluate(
  `(async () => {
    const root = await navigator.storage.getDirectory();
    const profiles = await root.getDirectoryHandle("profiles");
    const profile = await profiles.getDirectoryHandle("default");
    const workspace = await profile.getDirectoryHandle("workspace");
    const logs = await workspace.getDirectoryHandle("logs", { create: true });
    const handle = await logs.getFileHandle("grandma-kat.db", { create: true });
    const writable = await handle.createWritable();
    const bin = atob("${legacyB64}");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await writable.write(bytes);
    await writable.close();
    let removed = false;
    for (let i = 0; i < 20 && !removed; i++) {
      try { await profile.removeEntry(".gpb-runlog", { recursive: true }); removed = true; }
      catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    return JSON.stringify({ removed });
  })()`,
  20,
);
if (JSON.parse(planted).removed !== true) {
  console.error("could not clear the streaming pool directory", planted);
  cleanup(5);
}
console.log("✓ planted a legacy log and cleared the pool");

// ── 3. second boot: migration must import the legacy rows ───────────────────
await send("Page.navigate", { url: TARGET });
if (!(await waitForBoot())) { console.error("app did not boot after migration"); console.log(exceptions.join("\n")); cleanup(6); }
const second = await sessionState();
const sessions = second.body?.sessions ?? [];
const imported = sessions.find((s) => s.key === SESSION);
if (!imported) {
  console.error("legacy session was not imported", JSON.stringify(sessions));
  console.log(exceptions.join("\n"));
  cleanup(7);
}
if (!(imported.turns >= 1)) {
  console.error("imported session has no turns", imported);
  cleanup(7);
}
console.log(`✓ migrated legacy session visible (${imported.turns} turn)`);

// ── 4. writes go to the pool, not the legacy file ───────────────────────────
const legacyBefore = (await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const profile = await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default");
  const logs = await (await profile.getDirectoryHandle("workspace")).getDirectoryHandle("logs");
  return (await (await logs.getFileHandle("grandma-kat.db")).getFile()).size;
})()`));
const label = await evaluate(`(async () => {
  const b = window.__bobBackend;
  await b.ready;
  const r = await b.request("POST", "/api/session", new URLSearchParams(),
    JSON.stringify({ key: "${SESSION}", label: "migrated label" }));
  return JSON.stringify({ status: r.status, sessions: r.body?.sessions ?? [] });
})()`);
const labelled = JSON.parse(label);
const renamed = labelled.sessions.find((s) => s.key === SESSION);
if (labelled.status !== 200 || renamed?.label !== "migrated label") {
  console.error("could not write/read the migrated log", label);
  cleanup(8);
}
const legacyAfter = (await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const profile = await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default");
  const logs = await (await profile.getDirectoryHandle("workspace")).getDirectoryHandle("logs");
  return (await (await logs.getFileHandle("grandma-kat.db")).getFile()).size;
})()`));
if (Number(legacyAfter) !== Number(legacyBefore) || Number(legacyAfter) !== legacySize) {
  console.error("the legacy file was written after migration", { legacyBefore, legacyAfter, legacySize });
  cleanup(9);
}
console.log("✓ marker write+read served by the pool; legacy file untouched");

// ── 5. the export carries a logical log snapshot, never the VFS files ──────
const archiveCheck = JSON.parse(
  await evaluate(`(async () => {
    const hook = window.__bobWorkspaceTransfer;
    const archive = await hook.buildWorkspaceArchive();
    const paths = archive.files.map((f) => f.path);
    const log = archive.files.find((f) => f.path === "workspace/logs/grandma-kat.db");
    const head = log ? atob(log.base64.slice(0, 24)) : "";
    return JSON.stringify({
      hasLog: !!log,
      header: head.slice(0, 15),
      pool: paths.filter((p) => p.startsWith(".gpb-runlog")).length,
    });
  })()`),
);
if (!archiveCheck.hasLog || archiveCheck.header !== "SQLite format 3" || archiveCheck.pool !== 0) {
  console.error("export did not carry a clean log snapshot", archiveCheck);
  cleanup(11);
}
console.log("✓ export carries a logical log snapshot and no VFS files");

const pool = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const profile = await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default");
  const dir = await profile.getDirectoryHandle(".gpb-runlog");
  const names = [];
  for await (const [name] of dir.entries()) names.push(name);
  return JSON.stringify(names);
})()`);
if (!JSON.parse(pool).length) { console.error("streaming pool directory is empty"); cleanup(10); }
console.log(`✓ streaming pool holds ${JSON.parse(pool).length} file(s)`);

// ── 6. import round-trip: the staged snapshot is restored on the next boot ─
await evaluate(`(async () => {
  const hook = window.__bobWorkspaceTransfer;
  const archive = await hook.buildWorkspaceArchive();
  await hook.importWorkspace(archive);
  const root = await hook.profileRoot();
  const logs = await (await root.getDirectoryHandle("workspace")).getDirectoryHandle("logs");
  const handle = await logs.getFileHandle(".runlog-restore", { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Date().toISOString());
  await writable.close();
})()`);
await send("Page.navigate", { url: TARGET });
if (!(await waitForBoot())) { console.error("app did not boot after restore"); cleanup(12); }
const restoredState = await sessionState();
const restored = (restoredState.body?.sessions ?? []).find((s) => s.key === SESSION);
if (!restored || restored.label !== "migrated label") {
  console.error("imported log snapshot was not restored", JSON.stringify(restoredState.body?.sessions));
  console.log(exceptions.join("\n"));
  cleanup(12);
}
console.log("✓ imported log snapshot restored after reload");

cleanup(0);
