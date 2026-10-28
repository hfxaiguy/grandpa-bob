/**
 * SQLite Web Worker: owns an in-memory sqlite-wasm engine and persists each
 * database to the origin-private file system with the async API.
 *
 * Ordinary databases run in memory and we import/export the whole file: load
 * on open, write back after every mutation and on close.
 *
 * The KAT run log (`logs/grandma-kat.db`) instead streams through the
 * `opfs-sahpool` VFS: SQLite reads and writes pages of the OPFS file directly,
 * so a large append-only log never has to fit in the wasm heap, and a write
 * costs pages instead of a whole-file export. That VFS holds one sync access
 * handle per file for the life of the connection, so the log is available to
 * exactly one tab — a second tab gets a clear error instead of a split brain.
 *
 * The main thread talks to it over postMessage; see sqlite-wasm.ts.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { parseOpfsPrefix, resolveOpfsDir } from "./opfs-root";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

interface DbRecord {
  db: Any;
  /** Absolute workspace path, e.g. `/workspace/email.db`. */
  path: string;
  /** Open without writing the file back (read-only queries). */
  readOnly: boolean;
  /** In-memory only: never loaded from or persisted to OPFS (tool scratch dbs). */
  scratch: boolean;
  /** Owned by the opfs-sahpool VFS: SQLite persists it directly (no export). */
  stream: boolean;
}

/** The one database that streams instead of loading into memory. */
const RUN_LOG_PATH = /(^|\/)logs\/grandma-kat\.db$/;
/** sqlite-wasm's pool VFS: sync access handles, no SharedArrayBuffer. */
const STREAM_VFS = "opfs-sahpool";
/** OPFS directory (under the active profile) holding the streaming log. */
const STREAM_DIR = ".gpb-runlog";
/** Capacity must cover the db, its journal, and VACUUM's temp database. */
const STREAM_CAPACITY = 6;
/**
 * Files above this size are refused with a readable error before the in-memory
 * engine tries (and fails) to allocate the whole byte array. Anything smaller
 * that still runs out of wasm memory is translated in `loadInto`.
 */
const MAX_MEMORY_DB_BYTES = 192 * 1024 * 1024;

const isRunLogPath = (path: string): boolean => RUN_LOG_PATH.test(String(path).replace(/\\/g, "/"));

/** A file too big for the whole-file (non-streaming) engine. */
class DatabaseTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
  ) {
    super(
      `the database ${path} is too large to open in this browser (${(bytes / (1024 * 1024)).toFixed(1)} MiB)`,
    );
    this.name = "DatabaseTooLargeError";
  }
}

/** The run log could not get its streaming storage (another tab, no OPFS). */
function streamUnavailable(path: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? cause.message : cause == null ? "" : String(cause);
  return new Error(
    `the run log ${path} could not open its streaming storage` +
      (detail ? ` (${detail})` : "") +
      ". If this profile is open in another tab, close it and reload.",
  );
}

let sqlite3: Any = null;
let initPromise: Promise<void> | null = null;
const dbs = new Map<number, DbRecord>();
const stmts = new Map<number, { stmt: Any; dbId: number }>();
let nextDbId = 1;
let nextStmtId = 1;

/** Active profile segments, carried in the worker name by sqlite-wasm.ts. */
const OPFS_PREFIX = parseOpfsPrefix((self as unknown as { name?: string }).name);

function root(): Promise<FileSystemDirectoryHandle> {
  return resolveOpfsDir(OPFS_PREFIX);
}

/**
 * Databases live at their workspace path inside the root, so they are ordinary
 * workspace files: the seed, git, file tools, and SQL all agree on one copy.
 */
function segments(p: string): string[] {
  return String(p).split("/").filter((s) => s.length > 0 && s !== ".");
}

async function fileHandleFor(path: string, create = true): Promise<FileSystemFileHandle> {
  const parts = segments(path);
  const name = parts.pop();
  if (!name) throw new Error(`invalid database path: ${path}`);
  let dir = await root();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir.getFileHandle(name, { create });
}

function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<void> {
  sqlite3 = await (sqlite3InitModule as unknown as (opts?: unknown) => Promise<Any>)({
    print: () => {},
    printErr: (msg: unknown) => console.error("[sqlite-worker]", msg),
  });
}

async function loadInto(db: Any, path: string): Promise<void> {
  let bytes: Uint8Array;
  try {
    const handle = await fileHandleFor(path, false);
    bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return; // no existing database
  }
  if (!bytes.length) return;
  if (bytes.length > MAX_MEMORY_DB_BYTES) throw new DatabaseTooLargeError(path, bytes.length);
  let ptr: Any;
  try {
    ptr = sqlite3.wasm.allocFromTypedArray(bytes);
  } catch (err) {
    // sqlite-wasm's allocator ("Failed to allocate N bytes") — the file is
    // bigger than this tab's wasm heap can take. Say so instead of surfacing
    // the raw allocator error to the model.
    throw new DatabaseTooLargeError(path, bytes.length);
  }
  const flags =
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer,
    "main",
    ptr,
    bytes.length,
    bytes.length,
    flags,
  );
  if (rc) {
    // FREEONCLOSE means SQLite already freed ptr on this failure path (see
    // sqlite3_deserialize's docs) — do not free it again.
    // A torn write (an interrupted OPFS writable can leave a partial file)
    // would otherwise surface much later as a bare "file is not a database".
    throw new Error(`could not load ${path} into memory (sqlite3_deserialize rc=${rc})`);
  }
}

// ── streaming run log (opfs-sahpool) ────────────────────────────────────────

/** The installed pool, kept only after a successful install. */
let pool: Any | null = null;
let poolPromise: Promise<Any | null> | null = null;
/** A failed install is retried no sooner than this (the next log open, usually). */
let poolRetryAt = 0;
const SAH_RETRY_MS = 30_000;

/**
 * Install the run log's pool VFS, retrying a failed install on a later open.
 * The directory is scoped to the active profile (the VFS's root is the OPFS
 * origin root, not our profile subdirectory), so profiles never share sync
 * access handles.
 *
 * Only success is cached: when the browser's OPFS backend wedges (Gecko
 * reports it as a bare `UnknownError: Unknown failure`), the legacy whole-file
 * engine must not be forced for the rest of the worker's life once storage
 * recovers.
 */
async function ensureSahPool(): Promise<Any | null> {
  if (pool) return pool;
  if (poolPromise) return poolPromise;
  if (Date.now() < poolRetryAt) return null;
  poolPromise = (async () => {
    try {
      await ensureInit();
      const directory = [...OPFS_PREFIX, STREAM_DIR].filter(Boolean).join("/");
      pool = await sqlite3.installOpfsSAHPoolVfs({
        name: STREAM_VFS,
        directory,
        initialCapacity: STREAM_CAPACITY,
        // A transient OPFS failure on first try must not poison the profile.
        forceReinitIfPreviouslyFailed: true,
        // 3.53 deletes the whole pool when init fails — never risk the log.
        preserveOnInitFailure: true,
      });
      poolRetryAt = 0;
      return pool;
    } catch (err) {
      poolRetryAt = Date.now() + SAH_RETRY_MS;
      console.error("[sqlite-worker] could not install", STREAM_VFS, ":", err);
      return null;
    } finally {
      poolPromise = null;
    }
  })();
  return poolPromise;
}

/**
 * Move a legacy whole-file log into the streaming VFS, once. The file is read
 * in chunks, so even a log far larger than the wasm heap can be imported; the
 * original is left in place as a backup (nothing reads it any more).
 */
let migratedRunLog: Promise<void> | null = null;

async function migrateRunLog(pool: Any, path: string): Promise<void> {
  if (!migratedRunLog) migratedRunLog = importRunLog(pool, path);
  return migratedRunLog;
}

async function importRunLog(pool: Any, path: string): Promise<void> {
  const names = (pool.getFileNames?.() ?? []) as string[];
  if (names.includes(path)) return;

  let handle: FileSystemFileHandle;
  try {
    handle = await fileHandleFor(path, false);
  } catch {
    return; // first run: no legacy file (the VFS creates the log on demand)
  }
  const file = await handle.getFile();
  if (!file.size) return;

  const CHUNK = 1024 * 1024;
  let offset = 0;
  const nextChunk = async (): Promise<Uint8Array | undefined> => {
    if (offset >= file.size) return undefined;
    const end = Math.min(offset + CHUNK, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    offset = end;
    return bytes;
  };

  try {
    const wrote = await pool.importDb(path, nextChunk);
    console.info(
      `[sqlite-worker] imported the legacy run log into ${STREAM_VFS} ` +
        `(${Number(wrote).toLocaleString()} bytes); the old file stays at ${path}`,
    );
  } catch (err) {
    // Start with a fresh log rather than refuse to run. The legacy file is
    // untouched, so its data is still recoverable by hand.
    console.error("[sqlite-worker] legacy run-log import failed:", err);
  }
}

/** Writes are allowed unless the database was opened read-only. */
function writeAllowed(rec: DbRecord): boolean {
  return !rec.readOnly;
}

async function persist(rec: DbRecord): Promise<void> {
  // A streaming database writes its own pages; a read-only one never persists.
  if (rec.readOnly || rec.scratch || rec.stream) return;
  const bytes = sqlite3.capi.sqlite3_js_db_export(rec.db.pointer) as Uint8Array;
  try {
    const handle = await fileHandleFor(rec.path);
    const writable = await handle.createWritable();
    await writable.write(bytes as Parameters<typeof writable.write>[0]);
    await writable.close();
  } catch (err) {
    // The SQL already ran; only the OPFS write failed. Without this note the
    // caller sees Gecko's bare `UnknownError: Unknown failure` and cannot tell
    // an applied-but-unsaved change from a rejected one.
    throw new Error(
      `the change was applied in memory but could not be saved to ${rec.path}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `The profile's OPFS storage is failing; reload once it recovers.`,
    );
  }
}

/** Does the streaming pool already hold files? (If so, the legacy file is stale.) */
async function poolOccupied(): Promise<boolean> {
  try {
    const dir = await (await root()).getDirectoryHandle(STREAM_DIR);
    // lib.dom does not declare the async iteration methods yet.
    const entries = (dir as unknown as { entries(): AsyncIterator<[string, FileSystemHandle]> }).entries();
    const first = await entries.next();
    return !first.done;
  } catch {
    return false; // no pool directory yet
  }
}

/** Open one database using the right engine for its path. */
async function openRecord(path: string, readOnly: boolean, scratch: boolean): Promise<DbRecord> {
  // The run log streams through OPFS pages instead of being loaded whole.
  if (!scratch && isRunLogPath(path)) {
    const pool = await ensureSahPool();
    if (pool) {
      await migrateRunLog(pool, path);
      let db: Any;
      try {
        db = new sqlite3.oo1.DB(path, "c", STREAM_VFS);
      } catch (err) {
        throw streamUnavailable(path, err);
      }
      return { db, path, readOnly, scratch, stream: true };
    }
    // No streaming storage. If a pool already holds data, the legacy file is
    // stale: reading it would split the log in two, so fail loudly instead.
    if (await poolOccupied()) throw streamUnavailable(path);
    // Never streamed here (e.g. a browser without SAH support): keep working
    // on the legacy whole-file log, subject to the in-memory size guard.
    console.warn("[sqlite-worker] streaming storage unavailable; using the legacy run log");
  }

  const db = new sqlite3.oo1.DB(":memory:");
  if (!scratch) {
    try {
      await loadInto(db, path);
    } catch (err) {
      db.close();
      throw err;
    }
  }
  return { db, path, readOnly, scratch, stream: false };
}

function dbFor(id: number): DbRecord {
  const rec = dbs.get(id);
  if (!rec) throw new Error(`unknown database handle ${id}`);
  return rec;
}

function stmtFor(id: number): { stmt: Any; dbId: number } {
  const rec = stmts.get(id);
  if (!rec) throw new Error(`unknown statement handle ${id}`);
  return rec;
}

function bindParams(stmt: Any, params: unknown[] | undefined): void {
  stmt.bind(params && params.length ? params : undefined);
}

function columnsOf(stmt: Any): Array<{ name: string }> {
  try {
    return ((stmt.getColumnNames() as string[]) ?? []).map((name) => ({ name }));
  } catch {
    return [];
  }
}

/** sqlite3's rc for a failed allocation (the tab's wasm heap, not the browser). */
const SQLITE_NOMEM = 7;

function isOutOfMemory(err: unknown): boolean {
  if ((err as { resultCode?: number } | null)?.resultCode === SQLITE_NOMEM) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_NOMEM|sqlite3_step\(\) rc=\s*7\b|out of memory/i.test(message);
}

/** The record a failed operation belongs to, from a db handle or a statement. */
function recordForMessage(msg: Any): DbRecord | undefined {
  const dbId = Number(msg.dbId);
  if (Number.isFinite(dbId)) {
    const rec = dbs.get(dbId);
    if (rec) return rec;
  }
  const stmtId = Number(msg.stmtId);
  if (Number.isFinite(stmtId)) {
    const owner = stmts.get(stmtId);
    if (owner) return dbs.get(owner.dbId);
  }
  return undefined;
}

/**
 * SQLITE_NOMEM usually reaches the page as a bare rc=7 right after a failed
 * `opfs-sahpool` install, when the whole-file engine has to hold the run log
 * in the tab's fixed wasm heap. Name the cause and the remedy instead of
 * letting "not enough memory" read like a broken query.
 */
function explainError(err: unknown, msg: Any): unknown {
  if (!isOutOfMemory(err)) return err;
  const rec = recordForMessage(msg);
  const path = rec?.path ?? (typeof msg.path === "string" ? msg.path : "");
  const detail = err instanceof Error ? err.message : String(err);
  if (isRunLogPath(path) && (!rec || !rec.stream)) {
    return new Error(
      `the run log ${path} ran out of the tab's WebAssembly memory (SQLITE_NOMEM). ` +
        `Streaming storage (${STREAM_VFS}) is unavailable — see the "could not install ` +
        `${STREAM_VFS}" error — so the whole log has to fit in memory. Close other tabs and ` +
        `reload; if it keeps failing, trim or move ${path} before opening it again. [${detail}]`,
    );
  }
  return new Error(
    `the database ${path || "(unknown)"} ran out of the tab's WebAssembly memory ` +
      `(SQLITE_NOMEM). Close other tabs and reload, or move or trim the file. [${detail}]`,
  );
}

async function handle(op: string, msg: Any): Promise<unknown> {
  await ensureInit();
  try {
    return await dispatch(op, msg);
  } catch (err) {
    throw explainError(err, msg);
  }
}

async function dispatch(op: string, msg: Any): Promise<unknown> {
  switch (op) {
    case "init":
      return true;
    case "open": {
      const rec = await openRecord(String(msg.path), msg.readOnly === true, msg.scratch === true);
      const dbId = nextDbId++;
      dbs.set(dbId, rec);
      return { dbId };
    }
    case "export": {
      // A live connection (the run log's) exports from its own state; anything
      // else is opened transiently just to produce the snapshot.
      const path = String(msg.path);
      const existing = [...dbs.values()].find((rec) => rec.path === path && !rec.scratch);
      if (existing) return sqlite3.capi.sqlite3_js_db_export(existing.db.pointer) as Uint8Array;
      const rec = await openRecord(path, true, false);
      try {
        return sqlite3.capi.sqlite3_js_db_export(rec.db.pointer) as Uint8Array;
      } finally {
        rec.db.close();
      }
    }
    case "prepare": {
      const rec = dbFor(Number(msg.dbId));
      const stmt = rec.db.prepare(String(msg.sql));
      const stmtId = nextStmtId++;
      stmts.set(stmtId, { stmt, dbId: Number(msg.dbId) });
      return { stmtId, columns: columnsOf(stmt) };
    }
    case "stmtAll": {
      const { stmt } = stmtFor(Number(msg.stmtId));
      const rows: unknown[] = [];
      try {
        bindParams(stmt, msg.params);
        while (stmt.step()) rows.push(stmt.get({}));
      } finally {
        stmt.finalize();
        stmts.delete(Number(msg.stmtId));
      }
      return rows;
    }
    case "stmtGet": {
      const { stmt } = stmtFor(Number(msg.stmtId));
      try {
        bindParams(stmt, msg.params);
        return stmt.step() ? stmt.get({}) : undefined;
      } finally {
        stmt.finalize();
        stmts.delete(Number(msg.stmtId));
      }
    }
    case "stmtRun": {
      const { stmt, dbId } = stmtFor(Number(msg.stmtId));
      const rec = dbFor(dbId);
      if (!writeAllowed(rec)) {
        throw new Error(
          rec.readOnly
            ? `database is open read-only: ${rec.path}`
            : `database writes are disabled for ${rec.path} (enable "SQL writes" in the toolbar)`,
        );
      }
      try {
        bindParams(stmt, msg.params);
        stmt.step();
        const result = {
          changes: rec.db.changes(),
          lastInsertRowid: sqlite3.capi.sqlite3_last_insert_rowid(rec.db.pointer),
        };
        await persist(rec);
        return result;
      } finally {
        stmt.finalize();
        stmts.delete(Number(msg.stmtId));
      }
    }
    case "exec": {
      const rec = dbFor(Number(msg.dbId));
      if (!writeAllowed(rec)) {
        throw new Error(
          rec.readOnly
            ? `database is open read-only: ${rec.path}`
            : `database writes are disabled for ${rec.path} (enable "SQL writes" in the toolbar)`,
        );
      }
      rec.db.exec(String(msg.sql));
      await persist(rec);
      return null;
    }
    case "close": {
      const rec = dbs.get(Number(msg.dbId));
      if (rec) {
        await persist(rec);
        rec.db.close();
      }
      dbs.delete(Number(msg.dbId));
      return null;
    }
    default:
      throw new Error(`unknown sqlite op: ${op}`);
  }
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as { id: number; op: string };
  try {
    const result = await handle(msg.op, msg);
    (self as unknown as Worker).postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      error: `sqlite op '${msg.op}' failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};
