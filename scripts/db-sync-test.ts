/**
 * App-database dumps replay on a workspace that has never held the DB.
 *
 * The browser SQLite adapter opens a missing path as an empty in-memory
 * database instead of throwing. A read-only dump of that "DB" is an empty
 * `BEGIN; COMMIT;`, so the conflict guard used to classify a first boot as a
 * conflict and leave `contacts.db` / `comms.db` uncreated. Emulate that
 * adapter here and assert the dump is applied, and that a real local edit is
 * still protected from being clobbered.
 *
 * Run: `npm run test:db-sync`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDatabaseDumps, writeDatabaseDumps } from "../src/db-sync.js";
import { createNodePlatform } from "../src/platform/node.js";
import type { SqliteDatabase } from "../src/platform/types.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-dbsync-"));
const platform = createNodePlatform(workspace);
const dbPath = path.join(workspace, "people.db");
const realOpen = platform.sqlite.open.bind(platform.sqlite);

/** The database file counts rows; useful after a write guarded by FS access. */
async function countPeople(): Promise<number> {
  const db = await realOpen(dbPath, { readOnly: true });
  try {
    const stmt = await db.prepare("SELECT COUNT(*) AS n FROM people");
    const rows = (await stmt.all()) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } finally {
    await db.close();
  }
}

try {
  // A committed dump, then the DB is gone (a fresh browser workspace).
  const db = await realOpen(dbPath, { readOnly: false });
  await db.exec(
    "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);" +
      "INSERT INTO people (name) VALUES ('Ada'), ('Grace');",
  );
  await db.close();
  assert.deepEqual(await writeDatabaseDumps(platform), ["people.db"]);
  await rm(dbPath);

  // Browser-like adapter: opening a missing DB read-only yields an empty one.
  const emptyDb: SqliteDatabase = {
    async prepare() {
      return {
        all: async () => [],
        get: async () => undefined,
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
        columns: async () => [],
      };
    },
    async exec() {},
    async close() {},
  };
  platform.sqlite.open = async (p, opts) => {
    if (opts.readOnly && !existsSync(p)) return emptyDb;
    return realOpen(p, opts);
  };

  const first = await applyDatabaseDumps(platform, { onlyMissing: true });
  assert.deepEqual(first.applied, ["people.db"], "the missing DB is created from its dump");
  assert.deepEqual(first.conflicts, [], "a missing DB is not a conflict");
  assert.equal(await countPeople(), 2, "the dump's rows are present");

  // A DB left behind as an empty file (e.g. a failed write) is healed too.
  await writeFile(dbPath, "");
  const healed = await applyDatabaseDumps(platform, { onlyMissing: true });
  assert.deepEqual(healed.applied, ["people.db"], "an empty DB is recreated from the dump");
  assert.equal(await countPeople(), 2);

  // An initialized DB with local changes still wins: dump replay must not
  // clobber it. (The boot path skips initialized DBs; the regular sync path
  // reports the conflict.)
  const edited = await realOpen(dbPath, { readOnly: false });
  await edited.exec("INSERT INTO people (name) VALUES ('Linus')");
  await edited.close();
  const conflict = await applyDatabaseDumps(platform);
  assert.deepEqual(conflict.conflicts, ["people.db"], "local changes are kept as a conflict");
  assert.deepEqual(conflict.applied, []);
  assert.equal(await countPeople(), 3, "the local row survives");

  console.log("db-sync: dumps create missing/empty DBs, edited DBs are preserved OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
