// Real-Chrome check of the WebRTC pairing phrase (short authentication string).
//
// The page runs a genuine two-peer offer/answer exchange and compares the six
// words each side derives. Two properties are asserted:
//   - both peers of one connection show the SAME phrase (the SAS works);
//   - swapping a certificate fingerprint (a signaling relay substituting its
//     own certificate) changes the phrase (the SAS detects it).
//
// The page is served by a throwaway Vite dev server (it imports the source
// module directly), so no app build is required.
//   node scripts/pairing-smoke.mjs
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const WEB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CHROME = process.env.CHROME_BIN ?? "chromium";
const CDP_PORT = Number(process.env.CDP_PORT ?? 9228);
const PROFILE = path.join(os.tmpdir(), `bob-pairing-smoke-${process.pid}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

const viteBin = path.join(WEB_ROOT, "node_modules", ".bin", "vite");
if (!existsSync(viteBin)) {
  console.error("pairing smoke: vite is missing — run `npm install` in web/ first");
  process.exit(1);
}

const vitePort = await freePort();
const vite = spawn(
  viteBin,
  ["--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"],
  { cwd: WEB_ROOT, stdio: "ignore", detached: true },
);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore", detached: true },
);

/** Kill the whole process group (zygote/renderer children outlive SIGKILL on the root). */
function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function cleanup(code, message) {
  killGroup(chrome);
  killGroup(vite);
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
  if (message) console.error(message);
  process.exit(code);
}

setTimeout(() => cleanup(2, "timeout: pairing smoke did not finish"), 180_000).unref();

const pageUrl = `http://127.0.0.1:${vitePort}/smoke/pairing.html`;

async function waitForVite() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const res = await fetch(pageUrl, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`vite dev server never answered on ${pageUrl}`);
}

async function connect() {
  const getJSON = async (pathname) =>
    (await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`)).json();
  let version;
  for (let attempt = 0; attempt < 150 && !version; attempt++) {
    try {
      version = await getJSON("/json/version");
    } catch {
      await sleep(100);
    }
  }
  if (!version) throw new Error("chrome devtools unreachable");

  const page = await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      errors.push(
        msg.params.exceptionDetails.exception?.description ??
          msg.params.exceptionDetails.text ??
          "unknown page exception",
      );
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, errors };
}

async function main() {
  await waitForVite();
  const { send, errors } = await connect();
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: pageUrl });

  let result = null;
  for (let attempt = 0; attempt < 80 && !result; attempt++) {
    await sleep(250);
    const response = await send("Runtime.evaluate", {
      expression: "window.__sas ?? null",
      returnByValue: true,
    });
    const value = response.result?.result?.value;
    if (value) result = JSON.parse(value);
  }

  if (!result) {
    cleanup(1, `pairing smoke: page never produced a result\n${errors.slice(-4).join("\n")}`);
  }
  if (!result.ok || !result.symmetric) {
    cleanup(1, `pairing smoke: the two sides did not agree\n${JSON.stringify(result, null, 2)}`);
  }
  if (!result.tamperChanges) {
    cleanup(1, `pairing smoke: a substituted certificate did not change the phrase\n${JSON.stringify(result, null, 2)}`);
  }

  console.log(
    `pairing smoke: both sides agree on “${result.phrase}”, and a swapped certificate changes it`,
  );
  cleanup(0);
}

main().catch((err) => cleanup(1, err?.stack ?? String(err)));
