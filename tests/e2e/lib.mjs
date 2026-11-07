// Shared plumbing for the live, real-browser e2e checks.
//
// These tests are deliberately end-to-end: a real `npm run bob` process
// (static app + mailbox + Node peer), a real Chromium, real OPFS/WebRTC, and
// the app's own Sync…/Profiles dialogs. Nothing is mocked except the desktop
// folder contents the scenario asks for.
//
// Two Chromes are used by the profile-handoff test, each with its own
// user-data-dir, because OPFS and localStorage are per browser profile.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const repo = path.resolve(import.meta.dirname, "../..");

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Build the bundled Node peer (`tsx src/index.ts` loads dist/bridge/bridge.mjs). */
export function buildBridge() {
  execFileSync(process.execPath, [path.join(repo, "scripts/build-bridge.mjs")], {
    cwd: repo,
    stdio: "ignore",
  });
  if (!existsSync(path.join(repo, "web", "dist", "index.html"))) {
    throw new Error("web/dist is missing — run `npm run build:web` before the e2e suite");
  }
}

export async function startBob({ stateDir, workspaceDir, appPort, channelPort }) {
  const child = spawn(path.join(repo, "node_modules/.bin/tsx"), ["src/index.ts"], {
    cwd: repo,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ENV_FILE: "/dev/null",
      BOB_STATE_DIR: stateDir,
      WORKSPACE_DIR: workspaceDir,
      PORT: String(appPort),
      BOB_CHANNEL_PORT: String(channelPort),
    },
  });
  const appUrl = `http://127.0.0.1:${appPort}`;
  const channelUrl = `http://127.0.0.1:${channelPort}`;
  for (let i = 0; i < 300; i++) {
    try {
      const [app, channel] = await Promise.all([
        fetch(`${appUrl}/`, { signal: AbortSignal.timeout(500) }),
        fetch(`${channelUrl}/healthz`, { signal: AbortSignal.timeout(500) }),
      ]);
      if (app.ok && channel.ok) {
        return {
          child,
          appUrl,
          channelUrl,
          stop() {
            killGroup(child);
          },
        };
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  killGroup(child);
  throw new Error("BOB's app/channel server never became healthy");
}

export async function startChrome({ port, profileDir }) {
  const chrome = spawn(
    process.env.CHROME_BIN ?? "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      // Host candidates must be real IPv4s for loopback WebRTC pairing.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );

  let version = null;
  for (let i = 0; i < 200 && !version; i++) {
    try {
      version = await (
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })
      ).json();
    } catch {
      await sleep(100);
    }
  }
  if (!version) {
    killGroup(chrome);
    throw new Error(`Chrome never opened its debug port on 127.0.0.1:${port}`);
  }
  return {
    child: chrome,
    port,
    stop() {
      killGroup(chrome);
    },
  };
}

export function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export async function cleanup(parts, code, message) {
  for (const part of parts) {
    try {
      part?.stop?.();
    } catch {
      /* already gone */
    }
  }
  for (const dir of parts.map((part) => part?.dir).filter(Boolean)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (message) console.error(message);
  process.exit(code);
}

/** One page driven over the browser-level CDP socket. */
export class CdpPage {
  static async open({ port, url }) {
    let target;
    try {
      target = await (
        await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
      ).json();
    } catch {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      target = targets.find((entry) => entry.type === "page") ?? targets[0];
    }
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("Chrome did not create a debuggable page");
    }
    const page = new CdpPage(target.webSocketDebuggerUrl);
    await page.connect();
    if (url) await page.navigate(url);
    return page;
  }

  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text ??
            "unknown page exception",
        );
      }
    };
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.nextId;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const details = response.result?.exceptionDetails;
    if (details) {
      throw new Error(details.exception?.description ?? details.text ?? "page evaluate failed");
    }
    return response.result?.result?.value;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
  }

  async reload() {
    await this.send("Page.reload", { ignoreCache: true });
  }

  async waitFor(expression, label, timeout = 90_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
      } catch {
        /* navigation in flight */
      }
      await sleep(200);
    }
    const state = await this.evaluate(
      `JSON.stringify({
        status: document.getElementById("status")?.textContent ?? "",
        profile: localStorage.getItem("bob:profile"),
        chip: document.getElementById("mirror-status")?.textContent ?? "",
        pair: document.getElementById("pair-status")?.textContent ?? "",
      })`,
    ).catch(() => "state unavailable");
    throw new Error(`timeout waiting for ${label} (${state})`);
  }

  /** Wait for the app UI to finish booting its OPFS profile. */
  async waitForBoot(profile) {
    const profileCheck = profile
      ? `(() => {
          const active = localStorage.getItem("bob:profile");
          return active === ${JSON.stringify(profile)} ||
            (${JSON.stringify(profile)} === "default" && !active);
        })()`
      : "true";
    await this.waitFor(
      `document.readyState === "complete" &&
        (document.getElementById("status")?.textContent || "").includes("opfs") &&
        !!window.__bobWorkspaceTransfer &&
        ${profileCheck}`,
      profile ? `profile ${profile} to boot` : "app boot",
    );
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

export function adminClient({ channelUrl, stateDir }) {
  const keyFile = path.join(stateDir, "admin-key");
  const key = async () => (await readFile(keyFile, "utf8")).trim();
  return async (route, init = {}) => {
    const response = await fetch(`${channelUrl}${route}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", "x-bob-admin": await key() },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `admin HTTP ${response.status}`);
    return data;
  };
}

export async function createPairingCode(admin, options = {}) {
  return admin("/admin/pairing", {
    method: "POST",
    body: {
      profile: options.profile ?? "*",
      mirror: options.mirror,
      exec: options.exec ?? [],
    },
  });
}

/** Drive the real Sync… → Pair… dialog for a desktop/server code. */
export async function startDesktopPairing(page, { channelUrl, code }) {
  await page.evaluate(`(() => {
    // A pairing that goes through the reload path clears this marker; the
    // caller waits for it so it never drives the pre-reload page.
    window.__bobE2EPrePair = true;
    document.getElementById("sync-menu").click();
    document.getElementById("live-pair").click();
    document.getElementById("pair-source-desktop").click();
    document.getElementById("pair-server-url").value = ${JSON.stringify(channelUrl)};
    document.getElementById("pair-code").value = ${JSON.stringify(code)};
    document.getElementById("pair-join-code").click();
    return true;
  })()`);
}

/**
 * Wait for the server's awaiting-approval event, compare its SAS with the
 * browser's, confirm in the tab, and approve on the console — the same order a
 * human uses. Returns the phrase.
 */
export async function approveDesktopPairing(page, admin, pairingId, { timeout = 90_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const view = await admin(`/admin/pairing/${pairingId}/events?after=-1`);
    const awaiting = view.events.find((event) => event.type === "awaiting-approval");
    if (awaiting) {
      const sas = String(awaiting.data?.sas ?? "");
      const browserSas = String(
        await page.waitFor(
          `(document.getElementById("pair-verify")?.textContent || "").trim()`,
          "the browser verification phrase",
          20_000,
        ),
      ).trim();
      if (!sas || browserSas !== sas) {
        throw new Error(`SAS mismatch: browser=${browserSas} server=${sas}`);
      }
      await page.waitFor(
        `!document.getElementById("pair-confirm-wrap")?.hidden &&
          !document.getElementById("pair-phrase-ok")?.disabled`,
        "phrase confirmation",
        20_000,
      );
      await page.evaluate(`document.getElementById("pair-phrase-ok").click()`);
      await admin(`/admin/pairing/${pairingId}/approve`, {
        method: "POST",
        body: { approve: true },
      });
      return sas;
    }
    const failed = view.events.find(
      (event) => event.type === "error" || event.type === "offer-failed",
    );
    if (failed) {
      throw new Error(`desktop pairing failed: ${failed.data?.message ?? failed.data?.error ?? "unknown"}`);
    }
    await sleep(200);
  }
  throw new Error("desktop pairing never reached the approval prompt");
}

/** Wait for the post-pairing reload and the desktop status chip. */
export async function waitForDesktopLink(page, profile) {
  // The desktop join binds the mirror, then reloads ~800ms later. Driving the
  // pre-reload page (its dialogs vanish with the navigation) makes the next
  // Profile-dialog step race the reload.
  await page.waitFor(
    `typeof window.__bobE2EPrePair === "undefined"`,
    "the post-pairing reload",
    30_000,
  );
  await page.waitForBoot(profile);
  await page.waitFor(
    `(() => {
      const chip = document.getElementById("mirror-status");
      return chip && !chip.hidden &&
        (chip.textContent || "").startsWith("desktop:") &&
        !(chip.textContent || "").includes("waiting");
    })()`,
    "desktop link chip",
  );
}

/** Complete a desktop pairing from a booted page, ending on the link chip. */
export async function pairWithDesktop(page, { admin, channelUrl, code, profile, pairingId }) {
  await startDesktopPairing(page, { channelUrl, code });
  await approveDesktopPairing(page, admin, pairingId);
  await waitForDesktopLink(page, profile);
}

export const profileFileExpression = (profileName, relPath) => `(async () => {
  const root = await navigator.storage.getDirectory();
  const profiles = await root.getDirectoryHandle("profiles");
  const dir = await profiles.getDirectoryHandle(${JSON.stringify(profileName)});
  const workspace = await dir.getDirectoryHandle("workspace");
  const parts = ${JSON.stringify(relPath)}.split("/");
  let handle = workspace;
  for (const part of parts.slice(0, -1)) handle = await handle.getDirectoryHandle(part);
  const file = await (await handle.getFileHandle(parts.at(-1))).getFile();
  return await file.text();
})()`;

export const profileFileWriteExpression = (profileName, relPath, content) => `(async () => {
  const root = await navigator.storage.getDirectory();
  const profiles = await root.getDirectoryHandle("profiles");
  const dir = await profiles.getDirectoryHandle(${JSON.stringify(profileName)});
  const workspace = await dir.getDirectoryHandle("workspace");
  const parts = ${JSON.stringify(relPath)}.split("/");
  let handle = workspace;
  for (const part of parts.slice(0, -1)) {
    handle = await handle.getDirectoryHandle(part, { create: true });
  }
  const file = await handle.getFileHandle(parts.at(-1), { create: true });
  const writable = await file.createWritable();
  await writable.write(${JSON.stringify(content)});
  await writable.close();
  return true;
})()`;

export async function readProfileFile(page, profileName, relPath) {
  return page.evaluate(profileFileExpression(profileName, relPath));
}

/** Wait until a file exists in a profile and optionally matches a predicate. */
export async function waitForProfileFile(page, profileName, relPath, timeout = 90_000) {
  return page.waitFor(
    profileFileExpression(profileName, relPath),
    `${profileName}/${relPath}`,
    timeout,
  );
}

export async function writeProfileFile(page, profileName, relPath, content) {
  return page.evaluate(profileFileWriteExpression(profileName, relPath, content));
}

export async function profileRegistry(page) {
  return JSON.parse(
    await page.evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      return await (await (await root.getFileHandle("profiles.json")).getFile()).text();
    })()`),
  );
}

/** Create a fresh profile from the UI, with the bundled seed. */
export async function createProfileFromUi(page, name) {
  await page.evaluate(`(() => {
    document.getElementById("profile-manage").click();
    document.getElementById("profile-new-name").value = ${JSON.stringify(name)};
    document.getElementById("profile-new-source").value = "blank";
    document.getElementById("profile-new-seed").value = "shipped";
    const seed = document.getElementById("profile-new-seed");
    seed.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("profile-new-switch").checked = true;
    document.querySelector("#profile-create button[type=submit]").click();
    return true;
  })()`);
  await page.waitForBoot(name);
}

export async function switchProfile(page, name) {
  await page.evaluate(`(() => {
    const select = document.getElementById("profile-select");
    select.value = ${JSON.stringify(name)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await page.waitForBoot(name);
}

/** Click the Profiles dialog checkbox for a profile (optionally previewing it). */
export async function toggleProfilePeer(page, profileName, checked = true) {
  await page.evaluate(`(() => {
    window.confirm = () => true;
    const dialog = document.getElementById("profile-dialog");
    if (!dialog.open) document.getElementById("profile-manage").click();
    return true;
  })()`);
  const found = await page.waitFor(
    `(() => {
      const block = [...document.querySelectorAll("#profile-list .profile-block")]
        .find((entry) => entry.querySelector(".profile-row")?.textContent?.includes(${JSON.stringify(profileName)}));
      if (!block) return false;
      const box = block.querySelector('.profile-peer input[type="checkbox"]');
      if (!box) return false;
      if (box.checked !== ${checked}) {
        box.checked = ${checked};
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    })()`,
    `the ${profileName} profile row`,
  );
  return found;
}

export async function clickSyncNow(page) {
  await page.evaluate(`(() => {
    const dialog = document.getElementById("sync-dialog");
    if (!dialog.open) document.getElementById("sync-menu").click();
    document.getElementById("live-sync-now").click();
    return true;
  })()`);
}

export async function waitFile(file, timeout = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      return await readFile(file);
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`timeout waiting for ${file}`);
}

export async function waitDirEntry(dir, name, timeout = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const entries = await readdir(dir).catch(() => []);
    if (entries.includes(name)) return entries;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${name} in ${dir}`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
