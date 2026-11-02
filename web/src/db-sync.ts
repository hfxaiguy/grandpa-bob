// src/db-sync.ts
//
// App-database sync as bounded *text* dumps instead of binary blobs. A
// workspace-root `*.db` is serialized to `db/<name>.db.sql` (schema + rows,
// one INSERT per row, deterministic order) which git tracks and diffs cheaply
// and the peer sync engine also carries as an ordinary workspace file.
//
// The binary `.db` never travels between replicas (web/src/sync/hashmap.ts
// excludes it): the browser's whole-file sqlite-wasm engine exports the whole
// image after each commit, so a raw copy can race that persist or catch a
// transaction mid-flight, and the receiver has no journal to repair it. The
// dump is the transport; a local DB still lives as a whole file on each
// replica, which is an implementation detail of the browser adapter.
//
// This is deliberate **last-writer-wins snapshot sync**, not a merge:
//   - dump after local writes (writeDatabaseDumps / flushDirtyDumps)
//   - apply after pull/fetch or after a peer delivers a dump
//   - apply refuses to clobber a DB with local changes the dump doesn't have
//     (the replica's baseline is the last dump it wrote or applied)
//   - concurrent syncs are serialized in-process, and, where the platform can
//     (Node's real git), by a remote lock ref.
//
// The run log (logs/grandma-kat.db) is intentionally NOT synced here — it is
// append-only and large; it has its own retention. A paired desktop receives
// its rows over the peer control channel instead (web/src/peer-log.ts →
// src/bridge/peer-log.ts).

import type { Platform, SqliteDatabase } from "./platform/types.js";
import { hashBytes } from "./sync/hashmap.js";

/** Workspace-relative directory holding the committed dumps. */
export const SYNC_DIR = "db";
/**
 * Workspace-relative marker listing app DBs changed since the last dump.
 * Kept under logs/scratch (already gitignored) so it is never committed.
 */
export const DIRTY_PATH = "logs/scratch/db-dirty";
/**
 * Per-replica hash of the last dump this replica wrote or applied. It is what
 * lets apply distinguish "the local DB is clean, so take the incoming dump"
 * from "the local DB has edits the incoming dump lacks". Kept under
 * logs/scratch so it is per-replica and never synced or committed.
 */
export const BASELINE_PATH = "logs/scratch/db-baseline.json";
/** Workspace-relative path of the advisory git lock file. */
export const LOCK_PATH = `${SYNC_DIR}/.sync-lock.json`;
/** The lock is a lease: a stale lock is broken after this long. */
export const LOCK_TTL_MS = 120_000;
/** Wait this long after a DB write before dumping (the turn may still batch). */
export const DUMP_DEBOUNCE_MS = 1_500;

/**
 * The one-writer store the host uses for workspace-root app DBs
 * (app-store.ts). Structural on purpose: db-sync must not import app-store at
 * runtime (app-store imports markDatabaseDirty from this module).
 */
export interface DatabaseWriter {
  open(
    name: string,
    opts?: { readOnly?: boolean },
  ): Promise<Pick<SqliteDatabase, "exec" | "close">>;
  close(name?: string): Promise<void>;
}

/** A peer-delivered dump path (`db/contacts.db.sql`). */
export function isDatabaseDumpPath(rel: string): boolean {
  return /^db\/[^/]+\.db\.sql$/.test(String(rel).replace(/\\/g, "/"));
}

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

// ── baselines / dump notifications ─────────────────────────────────────

type DumpListener = (paths: string[]) => void;
let dumpListener: DumpListener | null = null;

/** Observe dumps written to disk (the agent worker forwards them to sync). */
export function onDatabaseDumpsWritten(listener: DumpListener | null): void {
  dumpListener = listener;
}

function emitDumpsWritten(paths: string[]): void {
  if (!paths.length || !dumpListener) return;
  try {
    dumpListener([...paths]);
  } catch {
    /* an observer must not break a dump */
  }
}

type Baselines = Record<string, string>;

const dumpHash = (platform: Platform, sql: string): string =>
  // Same binary hash the sync map uses, so the engine's `previous` hash for a
  // replaced dump is directly comparable to a stored baseline.
  hashBytes(platform, new TextEncoder().encode(sql));

async function readBaselines(platform: Platform): Promise<Baselines> {
  try {
    const raw = JSON.parse(
      await platform.fs.readFile(
        platform.path.join(platform.workspaceRoot, BASELINE_PATH),
        "utf8",
      ),
    ) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Baselines = {};
    for (const [name, hash] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof hash === "string") out[name] = hash;
    }
    return out;
  } catch {
    return {};
  }
}

/** Serialize read-modify-write of the per-replica baseline file. */
let baselineChain: Promise<unknown> = Promise.resolve();

function recordBaselines(
  platform: Platform,
  additions: Record<string, string | undefined>,
): Promise<void> {
  const names = Object.keys(additions);
  if (!names.length) return Promise.resolve();
  const run = baselineChain.then(async () => {
    const current = await readBaselines(platform);
    let changed = false;
    for (const name of names) {
      const hash = additions[name];
      if (hash && current[name] !== hash) {
        current[name] = hash;
        changed = true;
      }
    }
    if (!changed) return;
    const abs = platform.path.join(platform.workspaceRoot, BASELINE_PATH);
    await platform.fs.mkdir(platform.path.dirname(abs), { recursive: true }).catch(() => {});
    await platform.fs.writeFile(abs, JSON.stringify(current) + "\n");
  });
  baselineChain = run.catch(() => {});
  return run;
}

const dumpTimers = new WeakMap<Platform, ReturnType<typeof setTimeout>>();

/** Dump dirty DBs shortly after the last write. Never dumps mid-transaction:
 *  the sqlite worker only writes the file when autocommit is back on. */
function scheduleDatabaseDump(platform: Platform): void {
  if (dumpTimers.has(platform)) return;
  const timer = setTimeout(() => {
    dumpTimers.delete(platform);
    void flushDirtyDumps(platform).catch(() => {});
  }, DUMP_DEBOUNCE_MS);
  (timer as { unref?: () => void }).unref?.();
  dumpTimers.set(platform, timer);
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
  const baselines: Baselines = {};
  for (const name of names) {
    try {
      const sql = await dumpDatabase(platform, name);
      await platform.fs.writeFile(platform.path.join(dir, `${name}.sql`), sql);
      written.push(name);
      baselines[name] = dumpHash(platform, sql);
    } catch {
      /* a broken/missing DB must not break the commit */
    }
  }
  await clearDirty(platform, written);
  await recordBaselines(platform, baselines).catch(() => {});
  emitDumpsWritten(written.map((name) => `${SYNC_DIR}/${name}.sql`));
  return written;
}

// ── dirty tracking ──────────────────────────────────────────────────────
// A DB is "dirty" once something writes to it (SqliteTools.write marks it).
// Cheap commit paths (per-file auto-commits, the auto-sync tick) then dump
// only what changed instead of regenerating every dump.

/** App DB names recorded as changed since the last dump. */
export async function readDirtyNames(platform: Platform): Promise<string[]> {
  try {
    const raw = await platform.fs.readFile(platform.path.join(platform.workspaceRoot, DIRTY_PATH), "utf8");
    return [...new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Record that a workspace-root app DB changed. Best-effort, never throws. */
export async function markDatabaseDirty(platform: Platform, name: string): Promise<void> {
  // Only root-level app DBs are synced; ignore nested paths and non-.db files.
  if (!name || name.includes("/") || name.includes("\\") || !name.endsWith(".db")) return;
  try {
    const current = await readDirtyNames(platform);
    if (!current.includes(name)) {
      current.push(name);
      const abs = platform.path.join(platform.workspaceRoot, DIRTY_PATH);
      await platform.fs.mkdir(platform.path.dirname(abs), { recursive: true }).catch(() => {});
      await platform.fs.writeFile(abs, current.join("\n") + "\n");
    }
  } catch {
    /* best-effort */
  }
  // The event-driven git paths flush dirty dumps on their next commit; the
  // peer transport has no such tick, so a quiet app still has to produce its
  // dump. Debounced, and the worker only persists a committed DB image.
  scheduleDatabaseDump(platform);
}

/**
 * Dump only the DBs marked dirty and return their dump paths (workspace-
 * relative, ready to stage). No-op when nothing is dirty. Names appended while
 * dumping are kept for the next flush.
 */
export async function flushDirtyDumps(platform: Platform): Promise<string[]> {
  const dirty = await readDirtyNames(platform);
  if (dirty.length === 0) return [];
  const available = new Set(await listSyncDatabases(platform));
  const names = dirty.filter((n) => available.has(n));
  const dir = platform.path.join(platform.workspaceRoot, SYNC_DIR);
  await platform.fs.mkdir(dir, { recursive: true }).catch(() => {});
  const written: string[] = [];
  const dumped: string[] = [];
  const baselines: Baselines = {};
  for (const name of names) {
    try {
      const sql = await dumpDatabase(platform, name);
      await platform.fs.writeFile(platform.path.join(dir, `${name}.sql`), sql);
      written.push(`${SYNC_DIR}/${name}.sql`);
      dumped.push(name);
      baselines[name] = dumpHash(platform, sql);
    } catch {
      /* skip a broken DB; keep it dirty for the next flush */
    }
  }
  await clearDirty(platform, dumped);
  await recordBaselines(platform, baselines).catch(() => {});
  emitDumpsWritten(written);
  return written;
}

/** Remove `names` from the dirty marker (keep anything appended meanwhile). */
async function clearDirty(platform: Platform, names: string[]): Promise<void> {
  if (!names.length) return;
  try {
    const remaining = (await readDirtyNames(platform)).filter((n) => !names.includes(n));
    const abs = platform.path.join(platform.workspaceRoot, DIRTY_PATH);
    if (remaining.length) await platform.fs.writeFile(abs, remaining.join("\n") + "\n");
    else await platform.fs.rm(abs);
  } catch {
    /* best-effort */
  }
}

// ── apply ───────────────────────────────────────────────────────────────

export interface ApplyResult {
  applied: string[];
  /** Dump already matched the DB (no-op). */
  unchanged: string[];
  /** DB has local changes the dump lacks; skipped so nothing is lost. */
  conflicts: string[];
}

export interface ApplyOptions {
  force?: boolean;
  onlyMissing?: boolean;
  /**
   * Apply a differing dump when the local DB still matches its baseline (the
   * peer path, where the dump file itself already went through LWW). The git
   * path leaves this off: a local DB that differs from the pulled dump stays
   * a conflict, so an unpushed edit is never silently lost.
   */
  applyClean?: boolean;
  /**
   * Route the replay through the host's one-writer store (the browser agent
   * worker's AppStore). Without it, apply opens its own connection, which in
   * the browser is a second in-memory copy of the same file.
   */
  store?: DatabaseWriter;
  /**
   * Hash of the dump file this delivery replaced (by DB name). It is the
   * clean-replica baseline for a replica that has not written its own dump
   * yet, so the first peer delivery after an upgrade is not a false conflict.
   */
  previous?: Record<string, string>;
}

/**
 * Replay `db/<name>.db.sql` into `<name>.db`.
 *
 * A database file that does not exist has no local state to protect and is
 * always created from the dump. An existing DB is only replaced when it is
 * CLEAN (`applyClean`): its current dump equals the baseline this replica last
 * wrote or applied, or the hash of the dump file the peer just replaced.
 * Otherwise the local DB has edits the incoming dump lacks, and it is reported
 * in `conflicts` rather than clobbered. `force` bypasses the guard entirely
 * (the admin import path); the git path leaves `applyClean` off, so its
 * behavior is the conservative "never replace a differing local DB".
 *
 * This must not rely on opening a missing DB throwing: in the browser it does
 * not, and the empty dump used to look like a conflict, so OPFS workspaces
 * never got their app databases.
 */
export async function applyDatabaseDumps(
  platform: Platform,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const dir = platform.path.join(platform.workspaceRoot, SYNC_DIR);
  const entries = await platform.fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const result: ApplyResult = { applied: [], unchanged: [], conflicts: [] };
  const baselines = await readBaselines(platform);
  const nextBaselines: Baselines = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const name = entry.name.slice(0, -".sql".length); // "email.db.sql" -> "email.db"
    if (!name.endsWith(".db")) continue;
    const dbPath = platform.path.join(platform.workspaceRoot, name);
    const exists = await platform.fs.stat(dbPath).then(() => true).catch(() => false);
    if (opts.onlyMissing && exists) {
      result.unchanged.push(name);
      continue;
    }
    const path = platform.path.join(dir, entry.name);
    const committed = await platform.fs.readFile(path, "utf8");
    if (exists) {
      try {
        const current = await dumpDatabase(platform, name);
        if (current === committed) {
          result.unchanged.push(name);
          nextBaselines[name] = dumpHash(platform, committed);
          continue;
        }
        if (!opts.force) {
          if (!opts.applyClean) {
            result.conflicts.push(name);
            continue;
          }
          const baseline = opts.previous?.[name] ?? baselines[name];
          if (!baseline || baseline !== dumpHash(platform, current)) {
            result.conflicts.push(name);
            continue;
          }
        }
      } catch {
        /* unreadable DB → fall through and replay the dump */
      }
    }
    // Drop any cached writer first: one in-memory copy per file per worker.
    if (opts.store) await opts.store.close(name).catch(() => {});
    const db = opts.store
      ? await opts.store.open(name)
      : await platform.sqlite.open(dbPath, { readOnly: false });
    try {
      await db.exec(committed);
    } catch (err) {
      // A dump runs inside BEGIN/COMMIT; on error the worker leaves the file
      // at its previous committed image (it skips the export mid-transaction),
      // and closing the store rolls the open transaction back.
      if (opts.store) await opts.store.close(name).catch(() => {});
      else await db.close().catch(() => {});
      throw err;
    }
    if (opts.store) await opts.store.close(name);
    else await db.close();
    result.applied.push(name);
    nextBaselines[name] = dumpHash(platform, committed);
    // The DB now equals the dump: no local change is waiting to be dumped.
    await clearDirty(platform, [name]);
  }
  await recordBaselines(platform, nextBaselines).catch(() => {});
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
      // lockRef throws (e.g. unreachable remote) rather than reporting "held".
      if (await lockRef(remote, owner, LOCK_TTL_MS)) {
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
