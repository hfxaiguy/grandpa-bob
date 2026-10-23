/**
 * Publish the packed browser seed to a BobSwap shelf.
 *
 * `make-seed` writes `web/public/seed/workspace.json` + `meta.json`; this
 * script uploads those exact bytes (no re-serialization) so the shipped seed
 * and the shelf copy cannot drift.
 *
 *   BOBSWAP_ACCOUNT=personal BOBSWAP_SEED=trunk \
 *   BOBSWAP_UPLOAD_KEY=bsk_live_… npm run seed:publish
 *
 * Flags (override the env vars):
 *   --url <base>       service origin (default https://bobswap.hfxaiguy.com)
 *   --account <name>   account slug (required)
 *   --seed <name>      seed name (required)
 *   --key <key>        upload/manage-scope API key (required unless --dry-run)
 *   --file <path>      archive to upload (default web/public/seed/workspace.json)
 *   --version <label>  version label (default <sha12>-<compact createdAt>)
 *   --dry-run          validate and print, do not PUT
 *   --help
 *
 * Run: `npm run seed:publish` (or `npm run seed:ship` to pack + publish).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedVersionTag } from "../web/src/profiles.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = "https://bobswap.hfxaiguy.com";
const RESERVED_LABELS = new Set(["latest", "versions", "meta", "link"]);

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

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "Publish the packed browser seed (web/public/seed/workspace.json) to BobSwap.",
      "",
      "  --url <base>       default " + DEFAULT_URL,
      "  --account <name>   required (BOBSWAP_ACCOUNT)",
      "  --seed <name>      required (BOBSWAP_SEED)",
      "  --key <key>        upload/manage key (BOBSWAP_UPLOAD_KEY)",
      "  --file <path>      default web/public/seed/workspace.json",
      "  --version <label>  default <sha12>-<compact createdAt>",
      "  --dry-run          validate and print only",
    ].join("\n"),
  );
  process.exit(0);
}

const account = flag("account") ?? process.env.BOBSWAP_ACCOUNT ?? "";
const seedName = flag("seed") ?? process.env.BOBSWAP_SEED ?? "";
const apiKey = flag("key") ?? process.env.BOBSWAP_UPLOAD_KEY ?? "";
const baseUrl = (flag("url") ?? process.env.BOBSWAP_URL ?? DEFAULT_URL).replace(/\/+$/, "");
const file = path.resolve(
  here,
  "..",
  flag("file") ?? process.env.BOBSWAP_FILE ?? "web/public/seed/workspace.json",
);
const dryRun = argv.includes("--dry-run") || argv.includes("-n");

if (!/^[a-z0-9._-]{1,64}$/.test(account) || RESERVED_LABELS.has(account)) {
  fail("--account must be 1-64 lowercase letters, digits, dot, dash or underscore");
}
if (!/^[a-z0-9._-]{1,64}$/.test(seedName) || RESERVED_LABELS.has(seedName)) {
  fail("--seed must be 1-64 lowercase letters, digits, dot, dash or underscore");
}
if (!/^https?:\/\//i.test(baseUrl)) fail("--url must be an http(s) origin");
if (!dryRun && !apiKey) fail("--key is required (or set BOBSWAP_UPLOAD_KEY; dry-run skips it)");

let bytes: Buffer;
let archive: { version?: unknown; createdAt?: unknown; files?: unknown };
try {
  bytes = await fs.readFile(file);
  archive = JSON.parse(bytes.toString("utf8")) as typeof archive;
} catch (err) {
  fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
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
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as { sha256?: unknown; size?: unknown };
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
console.log(`bytes   : ${bytes.length}`);
console.log(`sha256  : ${sha256}`);
console.log(`target  : ${target}`);

if (dryRun) {
  console.log("dry run : not uploaded");
  process.exit(0);
}

const res = await fetch(target, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  },
  body: bytes,
});

if (res.status === 201) {
  console.log(`published: new version ${version}`);
  process.exit(0);
}
if (res.status === 200) {
  console.log(`unchanged: ${version} already carries these exact bytes`);
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
