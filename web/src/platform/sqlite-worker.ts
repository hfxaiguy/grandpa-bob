/**
 * SQLite Web Worker: owns an in-memory sqlite-wasm engine and persists each
 * database to the Origin Private File System with the async API.
 *
 * The OPFS sync-access-handle VFS only works in workers and proved fragile to
 * initialize here, so instead the engine runs in memory and we import/export
 * the whole database to OPFS: load on open, write back after every mutation and
 * on close. The main thread talks to it over postMessage; see sqlite-wasm.ts.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

interface DbRecord {
  db: Any;
  name: string;
}

let sqlite3: Any = null;
let initPromise: Promise<void> | null = null;
const dbs = new Map<number, DbRecord>();
const stmts = new Map<number, { stmt: Any; dbId: number }>();
let nextDbId = 1;
let nextStmtId = 1;

function sanitize(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "db.sqlite3";
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

async function opfsDir(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function loadInto(db: Any, name: string): Promise<void> {
  let bytes: Uint8Array;
  try {
    const handle = await (await opfsDir()).getFileHandle(name);
    bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return; // no existing database
  }
  if (!bytes.length) return;
  const ptr = sqlite3.wasm.allocFromTypedArray(bytes);
  const flags =
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  sqlite3.capi.sqlite3_deserialize(db.pointer, "main", ptr, bytes.length, bytes.length, flags);
}

async function persist(rec: DbRecord): Promise<void> {
  const bytes = sqlite3.capi.sqlite3_js_db_export(rec.db.pointer) as Uint8Array;
  const handle = await (await opfsDir()).getFileHandle(rec.name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes as Parameters<typeof writable.write>[0]);
  await writable.close();
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

async function handle(op: string, msg: Any): Promise<unknown> {
  await ensureInit();
  switch (op) {
    case "init":
      return true;
    case "open": {
      const name = sanitize(String(msg.path));
      const db = new sqlite3.oo1.DB(":memory:");
      await loadInto(db, name);
      const dbId = nextDbId++;
      dbs.set(dbId, { db, name });
      return { dbId };
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
