#!/usr/bin/env node
// Ensure the web build has a seed to ship.
//
// `vite build` copies everything under public/, including public/seed/. That
// directory is gitignored and generated locally by `npm run make-seed`, so a
// clean checkout (the hosted deployment) has no archive and the app's
// "Update from shipped seed" action gets a 404.
//
// This prebuild step fills that gap:
//   1. a valid local public/seed/workspace.json wins (make-seed's output);
//   2. otherwise fetch the newest public archive named by
//      public/seed-bootstrap.json;
//   3. BOB_SEED_ARCHIVE=<file> can pin a local artifact for an offline build;
//      BOB_SEED_URL=<url> overrides the shelf's /latest URL.
//
// A build that cannot produce a seed fails instead of silently shipping a
// bundle whose shipped-seed button is dead. Forks without a shelf can set
// BOB_SKIP_SEED_BUNDLE=1.
import fs from "node:fs/promises";
import path from "node:path";
import {
  archivePath,
  bootstrapPath,
  formatBytes,
  metaPath,
  parseSeedArchive,
  readJson,
  seedDir,
  seedMeta,
} from "./seed-bundle.mjs";

const force = process.argv.includes("--force");
const skipped = process.env.BOB_SKIP_SEED_BUNDLE === "1";
const DEFAULT_BASE_URL = "https://bobswap.hfxaiguy.com";
const FETCH_TIMEOUT_MS = 30_000;

function log(message) {
  console.log(`seed: ${message}`);
}

function normalizeBaseUrl(raw) {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return DEFAULT_BASE_URL;
  const scheme = /^https?:\/\//i.test(value);
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(value);
  const candidate = scheme ? value : `${isLocal ? "http" : "https"}://${value}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported seed service URL: ${candidate}`);
  }
  return candidate;
}

function validName(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9._-]{1,64}$/.test(value) &&
    value !== "." &&
    value !== ".." &&
    value !== "latest"
  );
}

/**
 * Use the archive make-seed wrote, repairing a missing/stale meta.json from the
 * archive's exact bytes. Without --force a corrupt local archive is an error:
 * silently replacing it would hide a failed pack from the person who just ran
 * make-seed.
 */
async function localSeed() {
  let bytes;
  try {
    bytes = await fs.readFile(archivePath);
  } catch {
    return null;
  }
  let archive;
  try {
    archive = parseSeedArchive(bytes, archivePath);
  } catch (err) {
    if (force) {
      log(`ignoring ${archivePath}: ${err.message}`);
      return null;
    }
    throw new Error(
      `${err.message}\n` +
        "  re-run `npm run make-seed` (or `npm run seed:fetch` to use the public shelf)",
    );
  }
  const meta = seedMeta(archive, bytes);
  let current = null;
  try {
    current = await readJson(metaPath);
  } catch {
    /* missing or malformed; rewrite below */
  }
  if (
    !current ||
    current.version !== meta.version ||
    current.sha256 !== meta.sha256 ||
    current.size !== meta.size ||
    current.fileCount !== meta.fileCount ||
    current.createdAt !== meta.createdAt
  ) {
    await fs.mkdir(seedDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(meta));
    log(`rewrote stale meta.json for ${archivePath}`);
  }
  return { bytes, meta, label: archivePath };
}

async function fetchSeed(url, label) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`cannot download ${label}: ${err.message}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    throw new Error(
      `cannot download ${label}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}` +
        (res.status === 401 || res.status === 403
          ? "\n  the seed's newest version must be public for a keyless build"
          : ""),
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const archive = parseSeedArchive(bytes, label);
  const meta = seedMeta(archive, bytes);
  const etag = res.headers
    .get("etag")
    ?.replace(/^W\//, "")
    .replace(/^"|"$/g, "")
    .toLowerCase();
  if (etag && /^[0-9a-f]{64}$/.test(etag) && etag !== meta.sha256) {
    log(`warning: ETag ${etag.slice(0, 12)}… differs from the archive sha ${meta.sha256.slice(0, 12)}…`);
  }
  return { bytes, meta, label };
}

/** An explicit artifact or URL, then the deployment's open-seed shelf. */
async function remoteSeed() {
  const pinned = process.env.BOB_SEED_ARCHIVE?.trim();
  if (pinned) {
    // npm runs the build from web/; INIT_CWD keeps a relative pin anchored at
    // the directory the person actually invoked the command from.
    const file = path.resolve(process.env.INIT_CWD?.trim() || process.cwd(), pinned);
    const bytes = await fs.readFile(file).catch((err) => {
      throw new Error(`cannot read BOB_SEED_ARCHIVE ${file}: ${err.message}`);
    });
    const archive = parseSeedArchive(bytes, file);
    return { bytes, meta: seedMeta(archive, bytes), label: file };
  }

  const explicit = process.env.BOB_SEED_URL?.trim();
  if (explicit) return fetchSeed(explicit, "BOB_SEED_URL");

  let bootstrap;
  try {
    bootstrap = await readJson(bootstrapPath);
  } catch (err) {
    throw new Error(
      `no local seed and ${bootstrapPath} is missing or unreadable: ${err.message}\n` +
        "  run `npm run make-seed`, set BOB_SEED_ARCHIVE / BOB_SEED_URL, " +
        "or set BOB_SKIP_SEED_BUNDLE=1 to build without a seed",
    );
  }
  const account = String(bootstrap?.account ?? "").trim();
  const seedName = String(bootstrap?.seedName ?? "").trim();
  if (!validName(account) || !validName(seedName)) {
    throw new Error(`${bootstrapPath} has no valid account/seedName`);
  }
  const baseUrl = normalizeBaseUrl(bootstrap?.baseUrl);
  const url = `${baseUrl}/api/v1/${encodeURIComponent(account)}/${encodeURIComponent(seedName)}/latest`;
  return fetchSeed(url, `${account}/${seedName}`);
}

async function main() {
  if (skipped) {
    log("BOB_SKIP_SEED_BUNDLE=1 — the bundle will not carry a seed");
    return;
  }

  if (force) log("--force — fetching a fresh copy instead of the local archive");
  const local = force ? null : await localSeed();
  if (local) {
    log(`using ${local.label} (${local.meta.fileCount} files, ${formatBytes(local.meta.size)}, ${local.meta.sha256.slice(0, 12)}…)`);
    return;
  }

  const remote = await remoteSeed();
  await fs.mkdir(seedDir, { recursive: true });
  // Write the exact downloaded bytes: meta.sha256 and the service ETag both
  // describe the archive, so re-serializing it would make them disagree.
  await fs.writeFile(archivePath, remote.bytes);
  await fs.writeFile(metaPath, JSON.stringify(remote.meta));
  log(
    `fetched ${remote.label} → ${archivePath} ` +
      `(${remote.meta.fileCount} files, ${formatBytes(remote.meta.size)}, ${remote.meta.sha256.slice(0, 12)}…)`,
  );
}

main().catch((err) => {
  console.error(`seed: ${err.message}`);
  process.exit(1);
});
