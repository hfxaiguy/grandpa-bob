// Pack a grandpa-bob workspace into the browser's WorkspaceArchive JSON so the
// browser target can seed OPFS without a server-side filesystem.
//
//   node scripts/make-seed.mjs [workspaceDir]
//
// Defaults to $WORKSPACE_DIR or ../../workspace. Writes web/public/seed/
// workspace.json, which web/src/main.ts imports into OPFS on first run.
// Paths are prefixed with "workspace/" so they land in the browser workspace.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace =
  process.argv[2] ??
  process.env.WORKSPACE_DIR ??
  path.resolve(here, "..", "..", "workspace");
const out = path.resolve(here, "..", "public", "seed", "workspace.json");

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "tmp", ".commandcode"]);
const SKIP_FILE = /\.(db|db-wal|db-shm|sqlite|sqlite3|log)$/i;
// The run log (logs/grandma-kat.db + its WAL) is workspace data the browser
// target carries so read_runs / logs_review work there too, so logs/ files are
// exempt from the DB/transient skip filter.
const KEEP_DIR = "logs/";

const files = [];
async function walk(dir, rel) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, childRel);
    } else if (entry.isFile()) {
      if (SKIP_FILE.test(childRel) && !childRel.startsWith(KEEP_DIR)) continue;
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

await fs.mkdir(path.dirname(out), { recursive: true });
const archive = { version: 1, createdAt: new Date().toISOString(), files };
const json = JSON.stringify(archive);
await fs.writeFile(out, json);
console.log(`seed: ${files.length} files from ${workspace} -> ${out} (${(json.length / 1024).toFixed(0)} KiB)`);
