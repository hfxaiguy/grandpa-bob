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
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDatabaseDumps, dumpDatabase, writeDatabaseDumps } from "../web/src/db-sync.js";
import { hashBytes } from "../web/src/sync/hashmap.js";
import { createNodePlatform } from "../src/platform/node.js";
import type { SqliteDatabase } from "../web/src/platform/types.js";

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

  // An existing DB is never replayed over on the boot path — even one with no
  // tables. Only a missing file is created.
  await rm(dbPath);
  await writeFile(dbPath, "");
  const untouched = await applyDatabaseDumps(platform, { onlyMissing: true });
  assert.deepEqual(untouched.applied, [], "an existing empty DB is not replaced");
  assert.deepEqual(untouched.unchanged, ["people.db"]);
  assert.equal(statSync(dbPath).size, 0, "the empty DB is left as-is");

  // Remove it again so the next checks run against the dump-created DB.
  await rm(dbPath);
  const recreated = await applyDatabaseDumps(platform, { onlyMissing: true });
  assert.deepEqual(recreated.applied, ["people.db"]);
  assert.equal(await countPeople(), 2);

  // ── a clean DB takes a peer's newer dump ───────────────────────────────
  // The incoming dump is produced by the same dumper in a second workspace,
  // so its text is canonical (the clean check compares the local DB's dump
  // with the replica's baseline).
  const remoteDir = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-dbsync-remote-"));
  const remote = createNodePlatform(remoteDir);
  try {
    const remoteDb = await remote.sqlite.open(path.join(remoteDir, "people.db"), {
      readOnly: false,
    });
    await remoteDb.exec(
      "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);" +
        "INSERT INTO people (name) VALUES ('Ada'), ('Grace'), ('Linus');",
    );
    await remoteDb.close();
    await writeDatabaseDumps(remote);
    const incoming = await readFile(path.join(remoteDir, "db", "people.db.sql"), "utf8");
    await writeFile(path.join(workspace, "db", "people.db.sql"), incoming);

    let storeOpens = 0;
    const handles = new Map<string, SqliteDatabase>();
    const store = {
      async open(name: string): Promise<SqliteDatabase> {
        storeOpens++;
        const db = await realOpen(path.join(workspace, name), { readOnly: false });
        handles.set(name, db);
        return db;
      },
      async close(name?: string): Promise<void> {
        if (!name) return;
        const db = handles.get(name);
        handles.delete(name);
        if (db) await db.close();
      },
    };

    const clean = await applyDatabaseDumps(platform, { store, applyClean: true });
    assert.deepEqual(clean.applied, ["people.db"], "a clean DB takes the incoming dump");
    assert.deepEqual(clean.conflicts, []);
    assert.ok(storeOpens > 0, "the host store owned the replay");
    assert.equal(await countPeople(), 3, "the incoming rows are present");
    assert.equal(
      await dumpDatabase(platform, "people.db"),
      incoming,
      "the applied dump round-trips canonically (the baseline stays valid)",
    );

    // The git path stays conservative: a differing local DB is a conflict,
    // even when it is clean relative to its own last dump. The peer path opts
    // into applying it because the dump file itself already went through LWW.
    const remoteDb2 = await remote.sqlite.open(path.join(remoteDir, "people.db"), {
      readOnly: false,
    });
    await remoteDb2.exec("INSERT INTO people (name) VALUES ('Aiden')");
    await remoteDb2.close();
    await writeDatabaseDumps(remote);
    const incoming2 = await readFile(path.join(remoteDir, "db", "people.db.sql"), "utf8");
    await writeFile(path.join(workspace, "db", "people.db.sql"), incoming2);

    const safe = await applyDatabaseDumps(platform);
    assert.deepEqual(safe.conflicts, ["people.db"], "the git path keeps a differing DB");
    assert.equal(await countPeople(), 3, "the clean local DB is untouched by the safe path");

    // The engine supplies the hash of the dump this delivery replaced; it is
    // the baseline for a replica that has never written its own dump (the
    // first peer delivery after an upgrade). Use only that here, not the
    // persisted baseline.
    await rm(path.join(workspace, "logs/scratch/db-baseline.json"));
    const peer = await applyDatabaseDumps(platform, {
      store,
      applyClean: true,
      previous: {
        "people.db": hashBytes(platform, new TextEncoder().encode(incoming)),
      },
    });
    assert.deepEqual(peer.applied, ["people.db"], "the peer path applies a clean DB's newer dump");
    assert.equal(await countPeople(), 4, "the peer rows are present");

    // A local edit after the apply must beat both paths: it is no longer the
    // clean DB the incoming dump was based on.
    const edited = await realOpen(dbPath, { readOnly: false });
    await edited.exec("INSERT INTO people (name) VALUES ('Margaret')");
    await edited.close();
    const conflict = await applyDatabaseDumps(platform, { store, applyClean: true });
    assert.deepEqual(conflict.conflicts, ["people.db"], "local changes are kept as a conflict");
    assert.deepEqual(conflict.applied, []);
    assert.equal(await countPeople(), 5, "the local row survives");
  } finally {
    await rm(remoteDir, { recursive: true, force: true });
  }

  console.log("db-sync: missing DBs are created, clean DBs take a peer dump, local edits win OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
