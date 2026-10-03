// Pack a grandpa-bob workspace into the browser's WorkspaceArchive JSON so the
// browser target can seed OPFS without a server-side filesystem.
//
//   node scripts/make-seed.mjs [workspaceDir]
//
// Defaults to $WORKSPACE_DIR or ../../workspace. Writes web/public/seed/
// workspace.json, which web/src/main.ts imports into OPFS on first run.
// Paths are prefixed with "workspace/" so they land in the browser workspace.
//
// The run log (logs/) is not copied: it is the desktop's history, and it is
// large. Instead we seed an EMPTY logs/grandma-kat.db with the logger's schema,
// so the browser's own read_runs / logs_review have a working log to write to.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace =
  process.argv[2] ??
  process.env.WORKSPACE_DIR ??
  path.resolve(here, "..", "..", "workspace");
const out = path.resolve(here, "..", "public", "seed", "workspace.json");

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "tmp", "logs", ".commandcode"]);
const SKIP_FILE = /\.(db|db-wal|db-shm|sqlite|sqlite3|log)$/i;

// Mirrors grandma-kat's SqliteLogger schema (src/logger.mjs CREATE_TABLES).
const RUN_LOG_DDL = `
CREATE TABLE IF NOT EXISTS calls (
  run_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_path TEXT,
  iteration INTEGER,
  scope_id INTEGER,
  kind TEXT NOT NULL,
  content TEXT
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  resume_positions TEXT NOT NULL
)`;

/** Bytes of an empty run log (schema only), as base64. */
async function emptyRunLogBase64() {
  const tmp = path.join(os.tmpdir(), `gpb-empty-runlog-${process.pid}-${Date.now()}.db`);
  const db = new DatabaseSync(tmp);
  try {
    db.exec(RUN_LOG_DDL);
  } finally {
    db.close();
  }
  const bytes = await fs.readFile(tmp);
  await fs.rm(tmp, { force: true });
  return bytes.toString("base64");
}

const files = [];
async function walk(dir, rel) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, childRel);
    } else if (entry.isFile()) {
      if (SKIP_FILE.test(childRel)) continue;
      const bytes = await fs.readFile(full);
      files.push({ path: `workspace/${childRel}`, base64: bytes.toString("base64") });
    }
  }
}

try {
  await walk(workspace, "");
} catch (err) {
  console.error(`cannot read workspace at ${workspace}: ${err.message}`);
  process.exit(1);
}

// The browser gets a fresh, empty run log it can write to.
files.push({ path: "workspace/logs/grandma-kat.db", base64: await emptyRunLogBase64() });

await fs.mkdir(path.dirname(out), { recursive: true });
const archive = { version: 1, createdAt: new Date().toISOString(), files };
const json = JSON.stringify(archive);
await fs.writeFile(out, json);
console.log(`seed: ${files.length} files from ${workspace} -> ${out} (${(json.length / 1024).toFixed(0)} KiB)`);
