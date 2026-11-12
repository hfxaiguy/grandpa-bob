#!/usr/bin/env node
// Unpack the shipped seed archive into the desktop seed profile.
//
// This is the inverse of make-seed.mjs:
//
//   make-seed.mjs   ~/.bobkat/folders/seed  ->  web/public/seed/workspace.json
//   unpack-seed.mjs web/public/seed/workspace.json -> ~/.bobkat/folders/seed
//
// Only app/, patterns/ and lib/ are unpacked: those are the seedable parts of
// the workspace (make-seed's KEEP_DIRS). The run log, models.json, databases
// and assets stay with the target profile. The current app/patterns/lib are
// copied to .seed-backup-<timestamp>/ inside the target before anything is
// overwritten, so a reset is reversible.
//
//   node web/scripts/unpack-seed.mjs --dry-run
//   node web/scripts/unpack-seed.mjs --force
//   node web/scripts/unpack-seed.mjs --archive other/workspace.json --target /tmp/seed --force
//
// Run from the repo root (`npm run seed:unpack -- --force`).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? "";
}

const archivePath = path.resolve(
  expandHome(arg("--archive", path.join(here, "..", "public", "seed", "workspace.json"))),
);
const targetPath = path.resolve(
  expandHome(arg("--target", path.join(os.homedir(), ".bobkat", "folders", "seed"))),
);
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

/** Top-level directories make-seed packs. */
const KEEP = new Set(["app", "patterns", "lib"]);

async function exists(rel) {
  try {
    await fs.access(path.join(targetPath, rel));
    return true;
  } catch {
    return false;
  }
}

async function nonEmpty(rel) {
  try {
    const entries = await fs.readdir(path.join(targetPath, rel));
    return entries.length > 0;
  } catch {
    return false;
  }
}

let archive;
try {
  archive = JSON.parse(await fs.readFile(archivePath, "utf8"));
} catch (err) {
  console.error(`unpack-seed: cannot read ${archivePath}: ${err.message}`);
  process.exit(1);
}
if (!archive || !Array.isArray(archive.files)) {
  console.error(`unpack-seed: ${archivePath} is not a workspace archive`);
  process.exit(1);
}

const files = [];
for (const entry of archive.files) {
  if (!entry || typeof entry.path !== "string" || typeof entry.base64 !== "string") continue;
  const rel = entry.path.startsWith("workspace/") ? entry.path.slice("workspace/".length) : entry.path;
  const top = rel.split("/")[0];
  if (!KEEP.has(top)) continue;
  const full = path.resolve(targetPath, rel);
  if (full !== targetPath && !full.startsWith(targetPath + path.sep)) {
    console.error(`unpack-seed: refusing path outside the target: ${entry.path}`);
    process.exit(1);
  }
  files.push({ rel, bytes: Buffer.from(entry.base64, "base64") });
}

if (!files.length) {
  console.error(`unpack-seed: ${archivePath} contains no app/, patterns/ or lib/ files`);
  process.exit(1);
}

const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
console.log(
  `unpack-seed: ${files.length} files (${(totalBytes / 1024).toFixed(0)} KiB) ` +
    `from ${archivePath} -> ${targetPath}`,
);
if (dryRun) {
  for (const file of files) console.log(`  ${file.rel}`);
  console.log("unpack-seed: dry run; nothing written");
  process.exit(0);
}

if (
  !force &&
  ((await nonEmpty("app")) || (await nonEmpty("patterns")) || (await nonEmpty("lib")))
) {
  console.error(
    `unpack-seed: ${targetPath} already has app/, patterns/ or lib/ content. ` +
      "Re-run with --force to back it up and replace it.",
  );
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(targetPath, `.seed-backup-${stamp}`);
let backedUp = 0;
if ((await exists("app")) || (await exists("patterns")) || (await exists("lib"))) {
  await fs.mkdir(backup, { recursive: true });
  for (const dir of KEEP) {
    if (!(await exists(dir))) continue;
    await fs.cp(path.join(targetPath, dir), path.join(backup, dir), { recursive: true });
    backedUp += 1;
  }
  console.log(`unpack-seed: backed up ${backedUp} director${backedUp === 1 ? "y" : "ies"} -> ${backup}`);
}

for (const file of files) {
  const full = path.join(targetPath, file.rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, file.bytes);
}
console.log(`unpack-seed: wrote ${files.length} files`);
