// Headless check for bound-seed updates: a fake BobSwap service serves
// /latest/meta + /latest; the browser must offer, apply (keeping the run log),
// and then stop offering the update. Later phases repeat the flow with NO read
// key against a public version, then lock the newest version again.
// Requires a served build (npm run web:standalone or the admin) and Chromium.
//   node scripts/seed-update-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8080";
const SERVICE_PORT = 8799;
const CDP = Number(process.env.CDP_PORT ?? 9226);
const PROFILE = path.join(os.tmpdir(), `bob-seed-smoke-${process.pid}`);
const READ_KEY = "bsk_live_read";

// A published seed carries the workspace's real trunk tree; reuse the bundled
// snapshot's entry so boot's "trunk is on disk" check passes exactly as it
// would for any real publish.
const bundled = JSON.parse(
  readFileSync(new URL("../public/seed/workspace.json", import.meta.url), "utf8"),
);
const trunkFile = bundled.files.find((f) => f.path === "workspace/patterns/trunk.prod.mjs") ?? {
  path: "workspace/patterns/trunk.prod.mjs",
  base64: Buffer.from("export default { name: 'trunk' };").toString("base64"),
};

const archive = {
  version: 1,
  createdAt: "2027-01-02T03:04:05.000Z",
  files: [
    trunkFile,
    {
      path: "workspace/patterns/updated-by-seed.mjs",
      base64: Buffer.from("export default { updated: true };").toString("base64"),
    },
    {
      path: "workspace/logs/grandma-kat.db",
      base64: Buffer.from("SHOULD-NOT-WIN").toString("base64"),
    },
  ],
};
// Phase 2 re-packs the seed with the SAME createdAt but different bytes: only
// the content hash can tell the browser this is a new build.
const archive2 = {
  ...archive,
  files: [
    ...archive.files,
    {
      path: "workspace/patterns/updated-again.mjs",
      base64: Buffer.from("export default { updated: 'again' };").toString("base64"),
    },
  ],
};
// Phase 4 re-packs once more so the keyless (public) path has a real update to
// apply; phase 5 keeps these bytes but makes the newest version private again.
const archive3 = {
  ...archive2,
  files: [
    ...archive2.files,
    {
      path: "workspace/patterns/public-only.mjs",
      base64: Buffer.from("export default { public: true };").toString("base64"),
    },
  ],
};
let phase = 1;
/** Whether an anonymous GET /latest is allowed (the service's public toggle). */
let publicLatest = false;
/** Anonymous 304s served, proving the unchanged check avoids a download. */
let notModified = 0;
function current() {
  const value = phase === 1 || phase === 3 ? archive : phase === 2 ? archive2 : archive3;
  const body = JSON.stringify(value);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    archive: value,
    body,
    sha256,
    version: `${sha256.slice(0, 12)}-20270102T030405Z`,
  };
}
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${SERVICE_PORT}`);
  requests.push(url.pathname + url.search);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-expose-headers", "etag, x-seed-version");
  if (req.method === "OPTIONS") {
    // `If-None-Match` is not CORS-safelisted: a cross-origin 304 check needs
    // this preflight (the real service advertises the same header).
    res.setHeader("access-control-allow-headers", "authorization, content-type, if-none-match");
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.statusCode = 204;
    res.end();
    return;
  }
  const now = current();
  if (url.pathname === "/api/v1/personal/seeds") {
    if (url.searchParams.get("key") !== READ_KEY) {
      res.statusCode = 401;
      res.end('{"error":"key required"}');
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        account: "personal",
        seeds: [{ name: "trunk", latest: now.version, versions: [now.version] }],
      }),
    );
    return;
  }
  if (url.pathname === "/api/v1/personal/trunk/latest/meta") {
    if (url.searchParams.get("key") !== READ_KEY) {
      res.statusCode = 401;
      res.end('{"error":"key required"}');
      return;
    }
    res.setHeader("content-type", "application/json");
    if (phase === 3) {
      // Malformed metadata: missing createdAt/sha256. The client must surface
      // this as a failure, not read it as "current".
      res.end(JSON.stringify({ version: 1 }));
      return;
    }
    res.end(
      JSON.stringify({
        version: 1,
        createdAt: now.archive.createdAt,
        fileCount: now.archive.files.length,
        size: Buffer.byteLength(now.body),
        sha256: now.sha256,
        seed_id_and_version: now.version,
      }),
    );
    return;
  }
  if (url.pathname === "/api/v1/personal/trunk/latest") {
    const keyed = url.searchParams.get("key") === READ_KEY;
    if (!keyed && !publicLatest) {
      res.statusCode = 401;
      res.end('{"error":"key required"}');
      return;
    }
    if (!keyed) res.setHeader("cache-control", "public, max-age=60, must-revalidate");
    const inm = String(req.headers["if-none-match"] ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
    if (inm && inm === now.sha256) {
      notModified++;
      res.statusCode = 304;
      res.setHeader("etag", `"${now.sha256}"`);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("etag", `"${now.sha256}"`);
    res.setHeader("x-seed-version", now.version);
    res.end(now.body);
    return;
  }
  res.statusCode = 404;
  res.end('{"error":"not found"}');
});
await new Promise((resolve) => server.listen(SERVICE_PORT, "127.0.0.1", resolve));
const firstVersion = current().version;

const chrome = spawn(
  "chromium",
  [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup(code, message) {
  try { chrome.kill("SIGKILL"); } catch {}
  try { server.close(); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  if (message) console.error(message);
  process.exit(code);
}
setTimeout(() => cleanup(2, "timeout: seed-update smoke did not finish"), 180_000).unref();

const getJSON = async (p) => (await fetch(`http://127.0.0.1:${CDP}${p}`)).json();
let v; for (let i = 0; i < 150 && !v; i++) { try { v = await getJSON("/json/version"); } catch { await sleep(100); } }
if (!v) cleanup(1, "chrome devtools unreachable");
const page = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0; const pending = new Map(); const exceptions = [];
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Page.javascriptDialogOpening") {
    send("Page.handleJavaScriptDialog", { accept: true });
  }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
};
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result?.result?.value;
}
async function waitFor(expression, label, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const value = await evaluate(expression); if (value) return value; } catch {}
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}
const assert = (condition, message) => { if (!condition) throw new Error(`assertion failed: ${message}`); };
await send("Runtime.enable");
await send("Page.enable");

// Fresh boot (no legacy data). A 1 s poll keeps the update checks testable
// without reloading the tab.
await send("Page.navigate", { url: `${BASE}/?seedpoll=1000` });
await waitFor(`document.readyState === "complete" && !!window.__bobWorkspaceTransfer`, "app boot");

// Configure the service and bind the default profile to its seed.
await evaluate(`(() => {
  document.getElementById("swap-settings").click();
  document.getElementById("seed-base-url").value = "http://127.0.0.1:${SERVICE_PORT}";
  document.getElementById("seed-account").value = "personal";
  document.getElementById("seed-read-key").value = "${READ_KEY}";
  document.getElementById("seed-save").click();
  document.getElementById("seed-close").click();
  document.getElementById("profile-manage").click();
  return "opened";
})()`);
await waitFor(
  `!!document.querySelector("#profile-list .profile-row")`,
  "profile manager rows",
);
await evaluate(`(() => {
  const row = document.querySelector("#profile-list .profile-row");
  [...row.querySelectorAll("button")].find((b) => b.textContent === "Seed…").click();
  document.getElementById("seed-name").value = "trunk";
  document.getElementById("seed-save").click();
  return "saved";
})()`);
await waitFor(
  `!!JSON.parse(localStorage.getItem("bob:swap") || "{}").services?.["http://127.0.0.1:${SERVICE_PORT}"]`,
  "service saved",
);
await sleep(500);

// Reload: boot must now offer the update.
await send("Page.navigate", { url: `${BASE}/?seedpoll=1000` });
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && !document.getElementById("ws-reseed").hidden`,
  "seed update banner",
);
const label = await evaluate(`document.getElementById("ws-reseed").textContent`);
assert(String(label).includes("Seed update: trunk"), `banner names the seed (got: ${label})`);

// Keep the run log across the update: read it before applying.
const before = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const ws = await (await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default")).getDirectoryHandle("workspace");
  const log = await (await ws.getDirectoryHandle("logs")).getFileHandle("grandma-kat.db").then((h) => h.getFile()).catch(() => null);
  const bytes = log ? new Uint8Array(await log.arrayBuffer()) : new Uint8Array();
  let out = ""; for (const b of bytes) out += String.fromCharCode(b);
  return JSON.stringify({ size: bytes.length, text: btoa(out) });
})()`);
const logBefore = JSON.parse(before);

// Apply through the app's own dialog (native confirms can be suppressed in
// embedded browsers, so make confirm() return false as those do). The marker
// disappears with the old document, so the wait cannot pass before the reload.
await evaluate(`window.confirm = () => false; window.__smokeBeforeReload = true; document.getElementById("ws-reseed").click()`);
await waitFor(`document.getElementById("confirm-dialog")?.open === true`, "update confirmation");
await evaluate(`document.getElementById("confirm-ok").click()`);
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && !window.__smokeBeforeReload`,
  "reload after applying the seed",
);
await sleep(800);

const after = await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const profile = await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("default");
  const ws = await profile.getDirectoryHandle("workspace");
  const updated = await (await (await ws.getDirectoryHandle("patterns")).getFileHandle("updated-by-seed.mjs")).getFile();
  const log = await (await ws.getDirectoryHandle("logs")).getFileHandle("grandma-kat.db").then((h) => h.getFile()).catch(() => null);
  const bytes = log ? new Uint8Array(await log.arrayBuffer()) : new Uint8Array();
  let out = ""; for (const b of bytes) out += String.fromCharCode(b);
  const seeded = await (await ws.getFileHandle(".seeded")).getFile().then((f) => f.text()).catch(() => "");
  const seedSha = await (await ws.getFileHandle(".seed-sha")).getFile().then((f) => f.text()).catch(() => "");
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const record = registry.profiles.find((p) => p.name === "default");
  return JSON.stringify({
    updated: await updated.text(),
    logSize: bytes.length,
    logText: btoa(out),
    seeded,
    seedSha,
    lastVersion: record?.seed?.lastVersion,
    bannerHidden: document.getElementById("ws-reseed").hidden,
  });
})()`);
const a = JSON.parse(after);
assert(a.updated.includes("updated: true"), "the seed's new file was applied");
assert(a.logSize === logBefore.size && a.logText === logBefore.text, "the local run log was preserved");
assert(a.logSize !== Buffer.from("SHOULD-NOT-WIN").length || !a.logText.includes(Buffer.from("SHOULD-NOT-WIN").toString("base64").slice(0, 8)), "the seed's log did not overwrite the local one");
assert(a.seeded.startsWith("2027-01-02"), "the freshness stamp follows the applied archive");
assert(a.seedSha === current().sha256, "the applied archive's content hash is recorded");
assert(a.lastVersion?.version === firstVersion, "the pulled version is recorded on the binding");
assert(a.bannerHidden === true, "the banner is gone after applying");
assert(requests.some((r) => r.includes("latest/meta") && r.includes("key=")), "meta was fetched with the read key");

// Phase 2: a re-pack with the SAME createdAt but different bytes. Without the
// content hash this would look current; the hash must still offer an update.
// The tab stays open: the periodic watcher (not a reload) has to notice it.
phase = 2;
assert(current().archive.createdAt === a.seeded, "phase 2 reuses the applied timestamp");
await waitFor(
  `!!document.getElementById("ws-reseed") && !document.getElementById("ws-reseed").hidden`,
  "same-timestamp seed update banner from the watcher",
);
const label2 = await evaluate(`document.getElementById("ws-reseed").textContent`);
assert(String(label2).includes("Seed update: trunk"), `hash-only banner names the seed (got: ${label2})`);

// Phase 2b: a new workspace is created from a listed seed. The picker must
// offer the shelf listing, the archive is pulled at creation, and the new
// profile boots with the seed's files — the bundled snapshot must not overlay
// it on first boot.
await evaluate(`(() => {
  document.getElementById("profile-manage").click();
  document.getElementById("profile-new-name").value = "fromseed";
  document.getElementById("profile-new-source").value = "blank";
  document.getElementById("profile-new-source").dispatchEvent(new Event("change"));
  return "opened";
})()`);
await waitFor(
  `[...document.querySelectorAll("#profile-new-seed option")].some((o) => o.value.endsWith("|personal|trunk"))`,
  "the listed seed appears in the new-workspace picker",
);
await evaluate(`(() => {
  window.__smokeBeforeReload = true;
  const select = document.getElementById("profile-new-seed");
  select.value = [...select.options].find((o) => o.value.endsWith("|personal|trunk")).value;
  document.querySelector("#profile-create button[type=submit]").click();
  return "submitting";
})()`);
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && !window.__smokeBeforeReload && localStorage.getItem("bob:profile") === "fromseed"`,
  "boot of the seed-created profile",
  90_000,
);
const created = JSON.parse(await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const record = registry.profiles.find((p) => p.name === "fromseed");
  const ws = await (await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("fromseed")).getDirectoryHandle("workspace");
  const patterns = await ws.getDirectoryHandle("patterns");
  const pulled = await (await (await patterns.getFileHandle("updated-again.mjs")).getFile()).text();
  const shipped = await (async () => {
    try {
      await (await ws.getDirectoryHandle("app")).getFileHandle("README.md");
      return true;
    } catch {
      return false;
    }
  })();
  const seeded = await (await ws.getFileHandle(".seeded")).getFile().then((f) => f.text()).catch(() => "");
  const seedSha = await (await ws.getFileHandle(".seed-sha")).getFile().then((f) => f.text()).catch(() => "");
  return JSON.stringify({ seed: record?.seed, pulled, shipped, seeded, seedSha });
})()`));
assert(created.pulled.includes("updated: 'again'"), "the chosen seed's files are on disk at creation");
assert(!created.shipped, "the bundled snapshot must not overlay a seed-created workspace");
assert(created.seeded === current().archive.createdAt, "the new profile records the seed's createdAt");
assert(created.seedSha === current().sha256, "the new profile records the seed's content hash");
assert(created.seed?.account === "personal" && created.seed?.seedName === "trunk", "the binding is stored with the profile");
assert(created.seed?.lastVersion?.sha256 === current().sha256, "the pulled version is recorded on the binding");
assert(requests.some((r) => r.includes("/api/v1/personal/seeds") && r.includes("key=")), "the shelf listing was fetched with the read key");

// Phase 3: malformed shelf metadata must surface a failure, not "current".
phase = 3;
await send("Page.navigate", { url: `${BASE}/?seedpoll=1000` });
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer`,
  "app boot after malformed metadata",
);
await sleep(2500); // at least two poll cycles
const bannerHidden = await evaluate(`document.getElementById("ws-reseed").hidden`);
assert(bannerHidden === true, "malformed metadata does not show an update banner");
await evaluate(`(() => {
  document.getElementById("profile-manage").click();
  return "opened";
})()`);
await waitFor(`!!document.querySelector("#profile-list .profile-row")`, "profile manager rows");
await evaluate(`(() => {
  const row = document.querySelector("#profile-list .profile-row");
  [...row.querySelectorAll("button")].find((b) => b.textContent === "Seed…").click();
  return "seed dialog";
})()`);
await waitFor(`document.getElementById("seed-dialog").open === true`, "seed dialog open");
await evaluate(`document.getElementById("seed-check").click()`);
await waitFor(
  `(document.getElementById("seed-status")?.textContent ?? "").includes("check failed")`,
  "malformed metadata reported by Check now",
);

// The read key is no longer needed for a public newest version. Remove it from
// the saved service and repeat the offer/apply flow keylessly.
phase = 4;
publicLatest = true;
const keylessMark = requests.length;
await evaluate(`(() => {
  document.getElementById("seed-close").click();
  document.getElementById("sync-menu").click();
  document.getElementById("swap-settings").click();
  document.getElementById("seed-read-key").value = "";
  document.getElementById("seed-save").click();
  document.getElementById("seed-close").click();
  return "read key removed";
})()`);
await waitFor(
  `(() => {
    const saved = JSON.parse(localStorage.getItem("bob:swap") || "{}");
    const service = saved.services?.["http://127.0.0.1:${SERVICE_PORT}"];
    return !!service && !service.readKey;
  })()`,
  "service saved without a read key",
);

await send("Page.navigate", { url: `${BASE}/?seedpoll=1000` });
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && !document.getElementById("ws-reseed").hidden`,
  "public seed update banner without a read key",
);
const publicLabel = await evaluate(`document.getElementById("ws-reseed").textContent`);
assert(String(publicLabel).includes("Seed update: trunk"), `keyless banner names the seed (got: ${publicLabel})`);

await evaluate(`window.confirm = () => false; window.__smokeBeforeReload = true; document.getElementById("ws-reseed").click()`);
await waitFor(`document.getElementById("confirm-dialog")?.open === true`, "keyless update confirmation");
await evaluate(`document.getElementById("confirm-ok").click()`);
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer && !window.__smokeBeforeReload`,
  "reload after applying the public seed",
);
await sleep(2500); // let the watcher hit the unchanged (304) path

const publicApplied = JSON.parse(await evaluate(`(async () => {
  const root = await navigator.storage.getDirectory();
  const ws = await (await (await root.getDirectoryHandle("profiles")).getDirectoryHandle("fromseed")).getDirectoryHandle("workspace");
  const pulled = await (await (await (await ws.getDirectoryHandle("patterns")).getFileHandle("public-only.mjs")).getFile()).text();
  const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
  const record = registry.profiles.find((p) => p.name === "fromseed");
  return JSON.stringify({ pulled, lastVersion: record?.seed?.lastVersion });
})()`));
assert(publicApplied.pulled.includes("public: true"), "the public seed's file was applied without a key");
assert(publicApplied.lastVersion?.sha256 === current().sha256, "the keyless pull records the content hash");
assert(publicApplied.lastVersion?.version === current().version, "the keyless pull records the version label");
const keylessRequests = requests.slice(keylessMark);
assert(
  keylessRequests.some((r) => r === "/api/v1/personal/trunk/latest"),
  "the public archive was fetched without a key",
);
assert(
  !keylessRequests.some((r) => r.includes("latest/meta")),
  "the keyless path never relies on the key-gated metadata endpoint",
);
assert(notModified > 0, "an unchanged public seed is re-checked with a 304, not a download");

// Phase 5: a private newest version locks the seed again for keyless clients.
phase = 5;
publicLatest = false;
await send("Page.navigate", { url: `${BASE}/?seedpoll=1000` });
await waitFor(
  `document.readyState === "complete" && !!window.__bobWorkspaceTransfer`,
  "app boot after the public version was made private",
);
await sleep(2500);
assert(
  await evaluate(`document.getElementById("ws-reseed").hidden`),
  "a private newest version offers nothing to a keyless client",
);
await evaluate(`(() => {
  document.getElementById("profile-manage").click();
  return "opened";
})()`);
await waitFor(`!!document.querySelector("#profile-list .profile-row")`, "profile manager rows");
await evaluate(`(() => {
  const row = [...document.querySelectorAll("#profile-list .profile-row")]
    .find((r) => r.querySelector("strong")?.textContent === "fromseed");
  [...row.querySelectorAll("button")].find((b) => b.textContent === "Seed…").click();
  return "seed dialog";
})()`);
await waitFor(`document.getElementById("seed-dialog").open === true`, "seed dialog open");
await evaluate(`document.getElementById("seed-check").click()`);
await waitFor(
  `(document.getElementById("seed-status")?.textContent ?? "").includes("isn't public")`,
  "Check now explains the private newest version",
);

if (exceptions.length) cleanup(1, `runtime exceptions:\n${exceptions.join("\n")}`);
console.log(
  "seed-update smoke: banner, apply, log preservation, version record, hash-only re-pack, " +
    "watcher offer, new-workspace creation from the listed seed, malformed-metadata reporting, " +
    "keyless public download + 304 re-check and private-again locking all passed",
);
cleanup(0);
