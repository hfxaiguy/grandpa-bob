#!/usr/bin/env node
/**
 * Open BOB in the preferred desktop browser, with the local Chrome/CDP helper
 * the browser tools drive.
 *
 * The worker can only talk CDP over the browser-level WebSocket, and it can
 * neither launch Chrome (no processes) nor discover the socket (the /json/*
 * HTTP endpoints are CORS-gated). So this script:
 *
 *   1. reuses a Chrome already listening on the debug port, or launches one
 *      detached with the dedicated profile and --remote-allow-origins;
 *   2. reads the browser WebSocket URL from /json/version (Node has no CORS);
 *   3. opens the app in the desktop browser — FireDragon by default — with
 *      ?cdp=<that url>, which the page persists and hands to the agent worker.
 *
 * FireDragon is Firefox-based and has no CDP endpoint, so it is only the
 * *display* browser; the automation Chrome stays in the background (no window
 * until a tool opens a page). Set BOB_NO_CDP=1 to skip Chrome entirely — then
 * the four browser_* tools report that no CDP endpoint is configured.
 *
 * Environment:
 *   CDP_PORT=9222               debug port
 *   CHROME_BIN=/path/to/chrome  explicit Chrome/Chromium binary (automation)
 *   BOB_BROWSER_BIN=…           app browser (default: firedragon, else xdg-open)
 *   BROWSER_PROFILE_DIR=…       dedicated profile (~/.grandma-browser/chrome-profile)
 *   BROWSER_STATE_DIR=…         bookkeeping dir (~/.grandma-browser)
 *   BROWSER_HEADLESS=1          run the automation Chrome without a window
 *   BROWSER_CHROME_ARGS="…"     extra Chrome flags
 *   BROWSER_LAUNCH_TIMEOUT_MS=20000
 *   BOB_APP_URL=…               the app to open (default: the admin on ADMIN_PORT)
 *   BOB_CDP_ALLOW_ORIGINS=*     origins allowed to open the CDP socket
 *   BOB_NO_CDP=1                do not launch/require Chrome; app opens tool-less
 *   BOB_NO_OPEN=1               print the URL instead of opening a browser
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.CDP_PORT || 9222);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const STATE_DIR = process.env.BROWSER_STATE_DIR || path.join(os.homedir(), ".grandma-browser");
const PROFILE_DIR =
  process.env.BROWSER_PROFILE_DIR || path.join(os.homedir(), ".grandma-browser", "chrome-profile");
const STATE_PATH = path.join(STATE_DIR, "chrome.json");
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8080);
/** The admin is the only way bob-web is served now (no standalone dev server). */
const APP_CANDIDATES = [`http://127.0.0.1:${ADMIN_PORT}`];
const ALLOW_ORIGINS = process.env.BOB_CDP_ALLOW_ORIGINS || "*";
const HEADLESS = process.env.BROWSER_HEADLESS === "1";
const EXTRA_ARGS = process.env.BROWSER_CHROME_ARGS || "";
const LAUNCH_TIMEOUT_MS = Number(process.env.BROWSER_LAUNCH_TIMEOUT_MS || 20000);
const NO_OPEN = process.env.BOB_NO_OPEN === "1";
const NO_CDP = process.env.BOB_NO_CDP === "1";
const APP_BROWSER = process.env.BOB_BROWSER_BIN || "";
/** Display browsers, in preference order. FireDragon is the default here. */
const APP_BROWSER_DEFAULTS = [
  "/usr/bin/firedragon",
  "/usr/bin/firedragon-bin",
  "/usr/bin/firefox",
  "/usr/bin/firefox-esr",
];

const CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

function findChrome() {
  const override = process.env.CHROME_BIN || "";
  if (override) return fs.existsSync(override) ? override : null;
  return CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** The browser that shows BOB (not the CDP automation browser). */
function findAppBrowser() {
  if (APP_BROWSER) return APP_BROWSER;
  return APP_BROWSER_DEFAULTS.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** GET /json/version — Chrome is up when this answers. */
async function version() {
  try {
    const res = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The app to open: BOB_APP_URL, or the first candidate that answers. */
async function findApp() {
  const candidates = process.env.BOB_APP_URL ? [process.env.BOB_APP_URL] : APP_CANDIDATES;
  for (const base of candidates) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(1200) });
      if (res.ok) return base;
    } catch {
      // try the next one
    }
  }
  return null;
}

async function launch() {
  const bin = findChrome();
  if (!bin) {
    throw new Error("no Chrome/Chromium binary found — set CHROME_BIN to its path");
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    // The worker's WebSocket carries the app origin; Chrome 111+ rejects
    // upgrades from origins it was not started with. This is the dedicated
    // automation profile, so the default is permissive (override with
    // BOB_CDP_ALLOW_ORIGINS=http://127.0.0.1:8080,…).
    `--remote-allow-origins=${ALLOW_ORIGINS}`,
    // Never talk to the OS keyring: Chrome would block on an unlock dialog
    // (or fail) when it cannot get one, and this profile is its own store.
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--disable-popup-blocking",
    ...(HEADLESS ? ["--headless=new"] : []),
    ...EXTRA_ARGS.split(/\s+/).filter(Boolean),
    // Start with no browser window: the automation window should appear when
    // a tool actually opens a page, not as an empty about:blank up front.
    ...(HEADLESS ? [] : ["--no-startup-window"]),
  ];
  const child = spawn(bin, args, { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        pid: child.pid,
        port: PORT,
        profileDir: PROFILE_DIR,
        allowOrigins: ALLOW_ORIGINS,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`launched ${bin} on port ${PORT} (profile ${PROFILE_DIR})`);

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await version();
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Chrome did not open its debug port on ${BASE} within ${LAUNCH_TIMEOUT_MS}ms. ` +
      "If Chrome is already running with this profile, quit it and run `npm run chrome` again.",
  );
}

function openUrl(url) {
  // FireDragon/Firefox first: the app is just a page. CDP automation stays in
  // Chrome, launched separately. BOB_BROWSER_BIN overrides the choice.
  const browser = findAppBrowser();
  if (NO_OPEN) {
    console.log(`open: ${url}${browser ? ` via ${path.basename(browser)}` : " via the OS opener"}`);
    return;
  }
  if (browser) {
    try {
      const child = spawn(browser, [url], { detached: true, stdio: "ignore" });
      child.on("error", () => console.log(`open manually: ${url}`));
      child.on("spawn", () => console.log(`opened ${url} in ${path.basename(browser)}`));
      child.unref();
      return;
    } catch {
      /* fall back to the OS opener */
    }
  }
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => console.log(`open manually: ${url}`));
    child.unref();
    console.log(`opened ${url}`);
  } catch {
    console.log(`open manually: ${url}`);
  }
}

const app = await findApp();
if (!app) {
  console.error(
    `no bob app answered at ${APP_CANDIDATES.join(", ")} — start the admin ` +
      "(`npm run dev`), the standalone server (`npm run web:standalone`), or set BOB_APP_URL.",
  );
  process.exit(1);
}

const url = new URL(app);

if (NO_CDP) {
  // Tool-less open: clear any persisted ?cdp so a stale socket is not reused.
  url.searchParams.set("cdp", "");
  console.log(`app:  ${app}`);
  console.log("cdp:  disabled (BOB_NO_CDP=1)");
  console.log(`bob:  ${url.toString()}`);
  openUrl(url.toString());
} else {
  const existing = await version();
  if (existing) {
    console.log(
      `reusing Chrome already on port ${PORT} — if bob cannot connect, quit that Chrome ` +
        "and run `npm run chrome` again (it needs --remote-allow-origins).",
    );
  }
  const info = existing ?? (await launch());
  const wsUrl = info.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error(`Chrome answered on ${BASE} but reported no webSocketDebuggerUrl`);
  }
  url.searchParams.set("cdp", wsUrl);
  console.log(`app:  ${app}`);
  console.log(`cdp:  ${wsUrl}`);
  console.log(`bob:  ${url.toString()}`);
  openUrl(url.toString());
}
