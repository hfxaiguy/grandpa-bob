/**
 * Publish the packed browser seed to a BobSwap shelf.
 *
 * `make-seed` writes `web/public/seed/workspace.json` + `meta.json`; this
 * script uploads those exact bytes (no re-serialization) so the shipped seed
 * and the shelf copy cannot drift.
 *
 * First interactive run asks for the account, seed name and upload key, then
 * offers to save them in `~/.grandpa-bob/bobswap.json` (0600) so later runs
 * need no arguments:
 *
 *   npm run seed:ship
 *
 * Non-interactive/CI:
 *
 *   BOBSWAP_ACCOUNT=personal BOBSWAP_SEED=trunk \
 *   BOBSWAP_UPLOAD_KEY=bsk_live_… npm run seed:publish
 *
 * Flags (override env and the saved file):
 *   --pack             run `npm run make-seed` first (seed:ship does this)
 *   --url <base>       service origin (default https://bobswap.hfxaiguy.com)
 *   --account <name>   account slug
 *   --seed <name>      seed name
 *   --key <key>        upload/manage-scope API key
 *   --file <path>      archive to upload (default web/public/seed/workspace.json)
 *   --version <label>  version label (default <sha12>-<compact createdAt>)
 *   --dry-run          validate and print, do not PUT
 *   --no-save          do not offer to remember interactive input
 *   --help
 *
 * Config path: `BOBSWAP_CONFIG` (default `~/.grandpa-bob/bobswap.json`).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedVersionTag } from "../web/src/profiles.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const DEFAULT_URL = "https://bobswap.hfxaiguy.com";
const RESERVED_LABELS = new Set(["latest", "versions", "meta", "link"]);
const configPath = process.env.BOBSWAP_CONFIG ?? path.join(os.homedir(), ".grandpa-bob", "bobswap.json");
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1) {
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) return next;
  }
  return undefined;
}

function fail(message: string): never {
  console.error(`seed:publish: ${message}`);
  process.exit(1);
}

interface SavedConfig {
  url?: string;
  account?: string;
  seed?: string;
  uploadKey?: string;
}

async function loadConfig(): Promise<SavedConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return raw as SavedConfig;
  } catch {
    return {};
  }
}

async function saveConfig(config: SavedConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600).catch(() => undefined);
}

// ── line input: queue piped lines; raw-mode editing for real typing ──────

const lineQueue: string[] = [];
let inputEnded = false;
let rawActive = false;
let pendingBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (rawActive) return; // the raw-mode reader owns the input stream
  pendingBuffer += chunk;
  flushLines();
});
process.stdin.on("end", () => {
  if (!rawActive && pendingBuffer) {
    // A last answer without a trailing newline still counts.
    lineQueue.push(pendingBuffer.replace(/\r$/, ""));
    pendingBuffer = "";
  }
  inputEnded = true;
});

function flushLines(): void {
  let index: number;
  while ((index = pendingBuffer.indexOf("\n")) !== -1) {
    lineQueue.push(pendingBuffer.slice(0, index).replace(/\r$/, ""));
    pendingBuffer = pendingBuffer.slice(index + 1);
  }
}

/**
 * One raw-mode line, echo controlled (secrets read with `echo = false`).
 * Handles backspace, Ctrl+U (clear), Ctrl+D (empty-line EOF) and Ctrl+C.
 */
function readRawLine(question: string, echo: boolean): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    rawActive = true;
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const finish = (result: string): void => {
      stdin.setRawMode?.(false);
      rawActive = false;
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === "\n" || char === "\r") {
          // Anything after this newline belongs to later questions — keep it,
          // do not drop it (a pty can deliver several answers in one chunk).
          pendingBuffer = text.slice(i + 1);
          rawActive = false;
          flushLines();
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode?.(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u0004") {
          if (!value) {
            pendingBuffer = text.slice(i + 1);
            rawActive = false;
            flushLines();
            stdin.setRawMode?.(false);
            stdin.pause();
            stdin.off("data", onData);
            process.stdout.write("\n");
            resolve("");
            return;
          }
          continue;
        }
        if (char === "\u0015") {
          value = "";
          if (echo) process.stdout.write("\r\x1b[K");
          continue;
        }
        if (char === "\u007f" || char === "\b") {
          if (value) {
            value = value.slice(0, -1);
            if (echo) process.stdout.write("\b \b");
          }
          continue;
        }
        if (char < " ") continue;
        value += char;
        if (echo) process.stdout.write(char);
      }
    };
    stdin.on("data", onData);
  });
}

/** Ask a question: queued piped lines first, typed input otherwise. */
async function ask(question: string, fallback = ""): Promise<string> {
  if (lineQueue.length) return lineQueue.shift()!.trim();
  if (inputEnded) return fallback;
  // Interactive typing (or an open pipe): print the prompt, then read a line.
  return readRawLine(question, true);
}

/** Ask for a secret: queued piped lines first, hidden typing otherwise. */
async function askSecret(question: string): Promise<string> {
  if (lineQueue.length) return lineQueue.shift()!.trim();
  if (inputEnded) return "";
  return readRawLine(question, false);
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "Publish the packed browser seed (web/public/seed/workspace.json) to BobSwap.",
      "",
      "  --pack             run make-seed first",
      `  --url <base>       default ${DEFAULT_URL}`,
      "  --account <name>   account slug (BOBSWAP_ACCOUNT)",
      "  --seed <name>      seed name (BOBSWAP_SEED)",
      "  --key <key>        upload/manage key (BOBSWAP_UPLOAD_KEY)",
      "  --file <path>      default web/public/seed/workspace.json",
      "  --version <label>  default <sha12>-<compact createdAt>",
      "  --dry-run          validate and print only",
      "  --no-save          do not offer to remember interactive input",
      "",
      `Interactive runs remember settings in ${configPath} (0600).`,
      "Set BOBSWAP_CONFIG to use another file.",
    ].join("\n"),
  );
  process.exit(0);
}

if (argv.includes("--pack")) {
  console.log("seed:publish: packing first (npm run make-seed)…");
  const result = spawnSync("npm", ["run", "make-seed"], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) fail("make-seed failed");
}

const dryRun = argv.includes("--dry-run") || argv.includes("-n");
const config = await loadConfig();

let account = flag("account") ?? process.env.BOBSWAP_ACCOUNT ?? config.account ?? "";
let seedName = flag("seed") ?? process.env.BOBSWAP_SEED ?? config.seed ?? "";
let baseUrl = flag("url") ?? process.env.BOBSWAP_URL ?? config.url ?? DEFAULT_URL;
let apiKey = flag("key") ?? process.env.BOBSWAP_UPLOAD_KEY ?? config.uploadKey ?? "";
let asked = false;

if (!account && interactive) {
  account = (await ask("BobSwap account [personal]: ")) || "personal";
  asked = true;
}
if (!account) {
  fail(
    "no account configured — pass --account, set BOBSWAP_ACCOUNT, or run interactively " +
      `(settings are saved in ${configPath})`,
  );
}
if (!seedName && interactive) {
  seedName = (await ask("Seed name [trunk]: ")) || "trunk";
  asked = true;
}
if (!seedName) {
  fail("no seed name configured — pass --seed or set BOBSWAP_SEED");
}
if (!dryRun && !apiKey) {
  if (!interactive) {
    fail(
      "no upload key configured — pass --key or set BOBSWAP_UPLOAD_KEY " +
        `(interactive runs save it in ${configPath})`,
    );
  }
  apiKey = await askSecret("BobSwap upload key (input hidden): ");
  asked = true;
}

baseUrl = baseUrl.replace(/\/+$/, "");
if (!/^[a-z0-9._-]{1,64}$/.test(account) || RESERVED_LABELS.has(account)) {
  fail("--account must be 1-64 lowercase letters, digits, dot, dash or underscore");
}
if (!/^[a-z0-9._-]{1,64}$/.test(seedName) || RESERVED_LABELS.has(seedName)) {
  fail("--seed must be 1-64 lowercase letters, digits, dot, dash or underscore");
}
if (!/^https?:\/\//i.test(baseUrl)) fail("--url must be an http(s) origin");
if (!dryRun && !apiKey.trim()) fail("the upload key is empty");

const file = path.resolve(
  repoRoot,
  flag("file") ?? process.env.BOBSWAP_FILE ?? "web/public/seed/workspace.json",
);

let bytes: Buffer;
let archive: { version?: unknown; createdAt?: unknown; files?: unknown };
try {
  bytes = await fs.readFile(file);
  archive = JSON.parse(bytes.toString("utf8")) as typeof archive;
} catch (err) {
  fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)} — run make-seed first`);
}
if (archive.version !== 1) fail(`${file}: archive version must be 1`);
if (typeof archive.createdAt !== "string" || Number.isNaN(Date.parse(archive.createdAt))) {
  fail(`${file}: archive createdAt is missing or not a timestamp`);
}
if (!Array.isArray(archive.files)) fail(`${file}: archive is missing the files list`);

const sha256 = createHash("sha256").update(bytes).digest("hex");
const version = flag("version") ?? process.env.BOBSWAP_VERSION ?? seedVersionTag(sha256, archive.createdAt);
if (!/^[A-Za-z0-9._-]{1,100}$/.test(version) || RESERVED_LABELS.has(version)) {
  fail("--version must be 1-100 letters (either case), digits, dot, dash or underscore");
}

// make-seed writes both files together; a stale sidecar means the pair drifted.
try {
  const metaPath = path.join(path.dirname(file), "meta.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as { sha256?: unknown };
  if (meta.sha256 && String(meta.sha256).toLowerCase() !== sha256) {
    console.warn(
      `seed:publish: warning — ${metaPath} records sha ${String(meta.sha256).slice(0, 12)}…, ` +
        `archive is ${sha256.slice(0, 12)}… (stale sidecar; re-run make-seed)`,
    );
  }
} catch {
  /* meta.json is optional */
}

const target =
  `${baseUrl}/api/v1/${encodeURIComponent(account)}/${encodeURIComponent(seedName)}/` +
  encodeURIComponent(version);

console.log(`archive : ${file}`);
console.log(`account : ${account}/${seedName}`);
console.log(`bytes   : ${bytes.length}`);
console.log(`sha256  : ${sha256}`);
console.log(`target  : ${target}`);

let verified = false; // a key is only persisted after the service accepted it

async function rememberSettings(): Promise<void> {
  if (!interactive || !asked || argv.includes("--no-save")) return;
  const answer = (await ask(`Save these settings to ${configPath}? [Y/n] `)).toLowerCase();
  if (answer && answer !== "y" && answer !== "yes") return;
  const next: SavedConfig = { ...config, url: baseUrl, account, seed: seedName };
  // Secrets are only remembered once the service accepted them; a dry run
  // never stores a key it did not verify.
  if (verified && apiKey) next.uploadKey = apiKey;
  await saveConfig(next);
  console.log(`saved   : ${configPath} (0600${verified ? ", key included" : ", without key"})`);
}

if (dryRun) {
  console.log("dry run : not uploaded");
  await rememberSettings();
  process.exit(0);
}

const res = await fetch(target, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  },
  body: new Uint8Array(bytes),
});

if (res.status === 201) {
  verified = true;
  console.log(`published: new version ${version}`);
  await rememberSettings();
  process.exit(0);
}
if (res.status === 200) {
  verified = true;
  console.log(`unchanged: ${version} already carries these exact bytes`);
  await rememberSettings();
  process.exit(0);
}

let detail = "";
try {
  const body = (await res.json()) as { error?: unknown };
  if (typeof body.error === "string") detail = ` — ${body.error}`;
} catch {
  /* non-JSON error */
}
if (res.status === 409) {
  fail(
    `conflict: a different archive already exists at ${version}${detail}; ` +
      "bump --version or let the content-addressed default pick a new label",
  );
}
if (res.status === 401 || res.status === 403) {
  fail(`key rejected (${res.status})${detail}; it needs upload or manage scope on this account`);
}
if (res.status === 413) fail("archive exceeds the service's 200 MiB limit");
if (res.status === 429) {
  fail(`rate limited${detail}; retry after ${res.headers.get("retry-after") ?? "a minute"}`);
}
fail(`upload failed (${res.status})${detail}`);
