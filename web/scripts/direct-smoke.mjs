// End-to-end check for "Desktop (direct folder)" in a real Chromium.
//
// The OS folder picker cannot be automated, so this test points
// `showDirectoryPicker()` at a real OPFS subdirectory. Everything after the
// picker — IndexedDB handle persistence, permission re-grant, the shared
// handle filesystem, isomorphic-git, and the sqlite worker reading/writing the
// file in place — is the production code path.
//
// Requires a dev server (`npx vite --port 5173`) and a Chromium binary.
//   node scripts/direct-smoke.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.CDP_PORT ?? 9223);
const TARGET = process.argv[2] ?? process.env.WEB_URL ?? "http://localhost:5173/?storage=direct";
const CHROME = process.env.CHROME_BIN ?? "chromium";
const PROFILE = path.join(os.tmpdir(), `bob-direct-smoke-${PORT}-${process.pid}`);

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
  try {
    chrome.kill("SIGKILL");
  } catch {}
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}
setTimeout(() => {
  console.error("timeout: direct smoke did not finish");
  cleanup(2);
}, 180_000).unref();

async function getJSON(p) {
  return (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
}

let version;
for (let i = 0; i < 150 && !version; i++) {
  try {
    version = await getJSON("/json/version");
  } catch {
    await sleep(100);
  }
}
if (!version) {
  console.error(`chrome devtools unreachable (is ${CHROME} installed?)`);
  cleanup(1);
}

let page;
try {
  page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
} catch {
  const targets = await getJSON("/json/list");
  page = targets.find((t) => t.type === "page") ?? targets[0];
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    logs.push(
      `[console.${msg.params.type}] ` +
        msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "),
    );
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
async function evaluate(expression, awaitPromise = true) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.error) throw new Error(r.error.message ?? "evaluate failed");
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return r.result?.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
// Replace the OS folder picker with a real OPFS directory handle.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const pick = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle("direct-smoke", { create: true });
    };
    Object.defineProperty(window, "showDirectoryPicker", { value: pick, configurable: true });
  })();`,
});

await send("Page.navigate", { url: TARGET });

// Wait for the folder gate, then click its button (the user gesture that would
// normally show the picker). It picks, saves the handle, and reloads.
let clicked = false;
for (let i = 0; i < 120 && !clicked; i++) {
  clicked = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((b) => /Choose folder|Grant access/.test(b.textContent || ""));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) await sleep(250);
}
if (!clicked) {
  console.error("folder gate button never appeared");
  console.log(logs.join("\n"));
  cleanup(3);
}

// After the reload the saved handle loads from IndexedDB and boots direct mode.
// A second click may be needed to grant permission to the persisted handle.
let status = "";
let directSeen = 0;
for (let i = 0; i < 300; i++) {
  status = (await evaluate(`document.getElementById("status")?.textContent ?? ""`).catch(() => "")) || "";
  if (status.startsWith("direct ·")) {
    // Require a few consecutive reads so a pending reload cannot cut in later.
    directSeen++;
    if (directSeen >= 4) break;
    await sleep(500);
    continue;
  }
  directSeen = 0;
  // Gate shown: click it (the user gesture a real picker would need).
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((b) => /Choose folder|Grant access/.test(b.textContent || ""));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`).catch(() => false);
  await sleep(500);
}
if (!status.startsWith("direct ·")) {
  console.error(`direct mode did not boot (status: ${status})`);
  console.log(logs.join("\n"));
  cleanup(3);
}
console.log(`status: ${status}`);

// File tools via the in-browser backend now hit the picked handle.
const wrote = await (async () => {
  try {
    return await evaluate(`(async () => {
  try {
    const backend = window.__bobBackend;
    if (!backend) return "no backend";
    await backend.ready;
    const res = await backend.request(
      "POST", "/api/patterns", new URLSearchParams(),
      JSON.stringify({ name: "direct-smoke", content: "export default {};\\n" }),
    );
    return JSON.stringify({ status: res?.status, body: res?.body });
  } catch (err) {
    return "threw: " + (err && err.message ? err.message : String(err));
  }
})()`);
  } catch (err) {
    return `evaluate threw: ${err instanceof Error ? err.message : String(err)}`;
  }
})();
const parsed = typeof wrote === "string" ? (() => { try { return JSON.parse(wrote); } catch { return wrote; } })() : wrote;
if (typeof parsed !== "object" || parsed?.status !== 200) {
  console.error(`file write through the adapter failed:`, parsed);
  console.log(logs.join("\n"));
  cleanup(4);
}
const onDisk = await evaluate(`(async () => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("direct-smoke");
  const patterns = await root.getDirectoryHandle("patterns");
  const file = await (await patterns.getFileHandle("direct-smoke.mjs")).getFile();
  return file.text();
})()`);
if (!onDisk.includes("export default")) {
  console.error("the file was not written to the picked directory");
  cleanup(4);
}
console.log("✓ file tools write to the picked folder");

// Header upload button lands in the picked folder, not the browser sandbox.
const upload = await evaluate(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.getElementById("workspace-upload-input");
  if (!input) return "no upload input";
  const dt = new DataTransfer();
  dt.items.add(new File(["direct upload\\n"], "direct-upload.txt", { type: "text/plain" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  for (let i = 0; i < 40 && !document.querySelector(".drawer-card"); i++) await wait(100);
  const card = document.querySelector(".drawer-card");
  if (!card) return "folder prompt did not open";
  const field = card.querySelector('input[type="text"]');
  field.value = "uploads";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  const button = Array.from(card.querySelectorAll("button")).find((b) => /^upload/.test(b.textContent.trim()));
  button.click();
  for (let i = 0; i < 80 && document.querySelector(".drawer-card"); i++) await wait(100);
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("direct-smoke");
  const dir = await root.getDirectoryHandle("uploads");
  const file = await (await dir.getFileHandle("direct-upload.txt")).getFile();
  return "uploaded:" + (await file.text()).trim();
})()`);
if (upload !== "uploaded:direct upload") {
  console.error("upload button failed in direct mode:", upload);
  console.log(logs.join("\n"));
  cleanup(4);
}
console.log("✓ upload button writes into the picked folder");

// SQLite: read-only by default, write-back after opting in.
const sql = await evaluate(`(async () => {
  const { initSqlite, createSqliteWasm } = await import("/src/platform/sqlite-wasm.ts");
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("direct-smoke");

  await initSqlite(root, { writeBack: false });
  const factory = createSqliteWasm();
  let readOnlyBlocked = false;
  try {
    const db = await factory.open("/smoke.db", { readOnly: false });
    await db.exec("CREATE TABLE t(x INTEGER);");
    await db.close();
  } catch {
    readOnlyBlocked = true;
  }

  await initSqlite(root, { writeBack: true });
  const db = await factory.open("/smoke.db", { readOnly: false });
  await db.exec("CREATE TABLE IF NOT EXISTS t(x INTEGER); INSERT INTO t VALUES (7);");
  const stmt = await db.prepare("SELECT x FROM t");
  const rows = await stmt.all();
  await db.close();

  const file = await (await root.getFileHandle("smoke.db")).getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const magic = new TextDecoder().decode(bytes.slice(0, 6));
  return { readOnlyBlocked, rows, magic, size: bytes.length };
})()`);
if (!sql || sql.magic !== "SQLite" || sql.size === 0) {
  console.error("sqlite did not write the real .db file", sql);
  console.log(logs.join("\n"));
  cleanup(5);
}
if (!sql.readOnlyBlocked) {
  console.error("sqlite writes were not blocked while write-back was off");
  cleanup(5);
}
if (sql.rows?.[0]?.x !== 7) {
  console.error("sqlite round-trip failed", sql);
  cleanup(5);
}
console.log("✓ sqlite: read-only default, opt-in write-back to the real file");

if (logs.some((line) => line.startsWith("[exception]"))) {
  console.log(logs.join("\n"));
  cleanup(6);
}
console.log("direct smoke: all assertions passed");
ws.close();
cleanup(0);
