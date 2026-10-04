// src/db-sync.ts
//
// App-database sync through git, as bounded *text* dumps instead of binary
// blobs. A workspace-root `*.db` is serialized to `db/<name>.db.sql` (schema +
// rows, one INSERT per row, deterministic order) which git tracks and diffs
// cheaply; the `.db` itself stays untracked. On the other end the dump is
// replayed into the database.
//
// This is deliberate **last-writer-wins snapshot sync**, not a merge:
//   - dump before commit/push (writeDatabaseDumps)
//   - apply after pull/fetch (applyDatabaseDumps)
//   - apply refuses to clobber a DB with local changes the dump doesn't have
//     (so an unpushed local edit is never silently lost)
//   - concurrent syncs are serialized in-process, and, where the platform can
//     (Node's real git), by a remote lock ref.
//
// The run log (logs/grandma-kat.db) is intentionally NOT synced here — it is
// append-only and large; it has its own retention.

import type { Platform, SqliteDatabase } from "./platform/types.js";

/** Workspace-relative directory holding the committed dumps. */
export const SYNC_DIR = "db";
/** Workspace-relative path of the advisory git lock file. */
export const LOCK_PATH = `${SYNC_DIR}/.sync-lock.json`;
/** The lock is a lease: a stale lock is broken after this long. */
export const LOCK_TTL_MS = 120_000;

// ── SQL text helpers ────────────────────────────────────────────────────

const quoteIdent = (value: unknown): string => `"${String(value).replace(/"/g, '""')}"`;
const quoteText = (value: string): string => `'${value.replace(/'/g, "''")}'`;

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** A SQL literal that round-trips the JS value SQLite hands back. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return quoteText(value);
  if (value instanceof Uint8Array) return `X'${hexOf(value)}'`;
  if (value instanceof ArrayBuffer) return `X'${hexOf(new Uint8Array(value))}'`;
  return quoteText(String(value));
}

async function all(db: SqliteDatabase, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const stmt = await db.prepare(sql);
  return (await stmt.all(...params)) as Record<string, unknown>[];
}

// ── discovery ───────────────────────────────────────────────────────────

/** Workspace-root SQLite databases (excludes -wal/-shm; honors db/.syncignore). */
export async function listSyncDatabases(platform: Platform): Promise<string[]> {
  const entries = await platform.fs.readdir(platform.workspaceRoot, { withFileTypes: true }).catch(() => []);
  const ignore = new Set<string>();
  try {
    const raw = await platform.fs.readFile(platform.path.join(platform.workspaceRoot, SYNC_DIR, ".syncignore"), "utf8");
    for (const line of raw.split("\n")) {
      const name = line.trim();
      if (name && !name.startsWith("#")) ignore.add(name);
    }
  } catch {
    /* no ignore file */
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".db"))
    .map((e) => e.name)
    .filter((name) => !ignore.has(name))
    .sort();
}

// ── dump ────────────────────────────────────────────────────────────────

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

/**
 * Serialize one database to deterministic SQL: DROP+CREATE for every object,
 * then one INSERT per row (rowid order), then sqlite_sequence. Bounded by the
 * database's content, so git stores ~one generation, not an ever-growing log.
 */
export async function dumpDatabase(platform: Platform, name: string): Promise<string> {
  const abs = platform.path.join(platform.workspaceRoot, name);
  const db = await platform.sqlite.open(abs, { readOnly: true });
  try {
    const objects = (await all(
      db,
      "SELECT type, name, tbl_name, sql FROM sqlite_master " +
        "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 WHEN 'view' THEN 3 ELSE 4 END, name",
    )) as unknown as SchemaRow[];

    const tables = objects
      .filter((o) => o.type === "table" && !/^CREATE\s+VIRTUAL/i.test(o.sql))
      .map((o) => o.name);

    const out: string[] = ["PRAGMA foreign_keys=OFF;", "BEGIN;"];

    // Drop everything first so a dump can be replayed over a populated DB.
    // Views/triggers/indexes before tables (dropping a table drops its index).
    for (const type of ["view", "trigger", "index", "table"]) {
      for (const o of objects) if (o.type === type) out.push(`DROP ${type.toUpperCase()} IF EXISTS ${quoteIdent(o.name)};`);
    }
    for (const o of objects) out.push(`${String(o.sql).replace(/;\s*$/, "")};`);

    for (const table of tables) {
      const cols = (await all(db, `PRAGMA table_info(${quoteIdent(table)})`)).map((c) => String(c.name));
      if (cols.length === 0) continue;
      // rowid order keeps the text stable so git shows only changed lines.
      let rows: Record<string, unknown>[];
      try {
        rows = await all(db, `SELECT * FROM ${quoteIdent(table)} ORDER BY rowid`);
      } catch {
        rows = await all(db, `SELECT * FROM ${quoteIdent(table)}`);
      }
      const columnList = cols.map(quoteIdent).join(", ");
      for (const row of rows) {
        const values = cols.map((c) => sqlLiteral(row[c])).join(", ");
        out.push(`INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${values});`);
      }
    }

    try {
      const seq = await all(db, "SELECT name, seq FROM sqlite_sequence");
      if (seq.length > 0) {
        out.push("DELETE FROM sqlite_sequence;");
        for (const s of seq) {
          out.push(`INSERT INTO sqlite_sequence (name, seq) VALUES (${sqlLiteral(s.name)}, ${sqlLiteral(s.seq)});`);
        }
      }
    } catch {
      /* no AUTOINCREMENT tables */
    }

    out.push("COMMIT;");
    return out.join("\n") + "\n";
  } finally {
    await db.close();
  }
}

/** Dump every app DB to `db/<name>.db.sql`. Returns the DB names written. */
export async function writeDatabaseDumps(platform: Platform): Promise<string[]> {
  const names = await listSyncDatabases(platform);
  const dir = platform.path.join(platform.workspaceRoot, SYNC_DIR);
  await platform.fs.mkdir(dir, { recursive: true }).catch(() => {});
  const written: string[] = [];
  for (const name of names) {
    try {
      const sql = await dumpDatabase(platform, name);
      await platform.fs.writeFile(platform.path.join(dir, `${name}.sql`), sql);
      written.push(name);
    } catch {
      /* a broken/missing DB must not break the commit */
    }
  }
  return written;
}

// ── apply ───────────────────────────────────────────────────────────────

export interface ApplyResult {
  applied: string[];
  /** Dump already matched the DB (no-op). */
  unchanged: string[];
  /** DB has local changes the dump lacks; skipped so nothing is lost. */
  conflicts: string[];
}

/**
 * Replay `db/<name>.db.sql` into `<name>.db`. Unless `force`, a DB whose current
 * content differs from the dump AND has no corresponding committed dump state
 * is left alone (reported in `conflicts`) rather than clobbered.
 */
export async function applyDatabaseDumps(
  platform: Platform,
  opts: { force?: boolean; onlyMissing?: boolean } = {},
): Promise<ApplyResult> {
  const dir = platform.path.join(platform.workspaceRoot, SYNC_DIR);
  const entries = await platform.fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const result: ApplyResult = { applied: [], unchanged: [], conflicts: [] };

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const name = entry.name.slice(0, -".sql".length); // "email.db.sql" -> "email.db"
    if (!name.endsWith(".db")) continue;
    const dbPath = platform.path.join(platform.workspaceRoot, name);
    if (opts.onlyMissing) {
      const exists = await platform.fs.stat(dbPath).then(() => true).catch(() => false);
      if (exists) {
        result.unchanged.push(name);
        continue;
      }
    }
    const path = platform.path.join(dir, entry.name);
    const committed = await platform.fs.readFile(path, "utf8");
    try {
      const current = await dumpDatabase(platform, name);
      if (current === committed) {
        result.unchanged.push(name);
        continue;
      }
      if (!opts.force) {
        result.conflicts.push(name);
        continue;
      }
    } catch {
      /* DB missing → it is safe to create from the dump */
    }
    const db = await platform.sqlite.open(dbPath, { readOnly: false });
    try {
      await db.exec(committed);
      result.applied.push(name);
    } finally {
      await db.close();
    }
  }
  return result;
}

// ── serialization ───────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

/** Serialize sync operations within this process. */
export function withSyncMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/**
 * Run `fn` as the single db-sync writer.
 *
 * - Always serialized within this process (mutex).
 * - Across devices, an atomic remote lock ref is taken when the git backend
 *   supports it (`platform.git.lockRef` — the Node target). The browser's
 *   isomorphic-git has no atomic create-if-absent, so there the safety comes
 *   from git's own non-fast-forward push rejection plus the conflict check in
 *   `applyDatabaseDumps`: pull before pushing, and never clobber a dirty DB.
 */
export async function withSyncLock<T>(
  platform: Platform,
  opts: { remote?: string } = {},
  fn: () => Promise<T>,
): Promise<T> {
  return withSyncMutex(async () => {
    const remote = opts.remote;
    const { lockRef, unlockRef } = platform.git;
    if (!remote || !lockRef || !unlockRef) return fn();

    const owner = platform.crypto.randomUUID();
    const deadline = Date.now() + 30_000;
    let held = false;
    while (!held) {
      if (await lockRef(remote, owner, LOCK_TTL_MS).catch(() => false)) {
        held = true;
        break;
      }
      if (Date.now() > deadline) throw new Error("another device is syncing — try again shortly");
      await new Promise((r) => setTimeout(r, 1000));
    }
    try {
      return await fn();
    } finally {
      await unlockRef(remote, owner).catch(() => {});
    }
  });
}
