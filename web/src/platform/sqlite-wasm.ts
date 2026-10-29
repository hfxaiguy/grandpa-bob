/**
 * Browser SQLite client: talks to sqlite-worker.ts, which owns sqlite-wasm and
 * the OPFS VFS. Exposes the shared, async `SqliteFactory` interface.
 *
 * Call `initSqlite()` once before opening (it boots the worker).
 */
import type { SqliteColumn, SqliteDatabase, SqliteFactory, SqliteStatement } from "./types";
import { encodeOpfsPrefix } from "./opfs-root";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

/** Active profile segments, forwarded to the worker via its constructor name. */
let opfsPrefix: string[] = [];

export function setSqliteOpfsPrefix(parts: readonly string[]): void {
  opfsPrefix = [...parts];
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
    type: "module",
    name: encodeOpfsPrefix(opfsPrefix),
  });
  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { id: number; ok: boolean; result?: unknown; error?: string };
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "sqlite worker error"));
  };
  worker.onerror = (ev) => {
    const err = new Error(`sqlite worker failed: ${ev.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

function call<T = unknown>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    ensureWorker().postMessage({ id, op, ...payload });
  });
}

/**
 * Boot the sqlite worker. Idempotent.
 *
 * Ordinary databases live under the origin-private file system; the worker
 * loads a file into its in-memory engine on open and writes it back after
 * mutations. The KAT run log (`logs/grandma-kat.db`) is the exception: it
 * streams through the `opfs-sahpool` VFS, so its size is not bounded by the
 * wasm heap. `prefix` selects the active profile directory (empty = origin
 * root).
 */
export async function initSqlite(prefix?: readonly string[]): Promise<void> {
  if (prefix) setSqliteOpfsPrefix(prefix);
  await call("init", {});
}

export function createSqliteWasm(): SqliteFactory {
  return {
    async open(path: string, opts?: { readOnly?: boolean; scratch?: boolean }): Promise<SqliteDatabase> {
      const { dbId } = await call<{ dbId: number }>("open", {
        path,
        readOnly: opts?.readOnly === true,
        scratch: opts?.scratch === true,
      });
      return {
        async prepare(sql: string): Promise<SqliteStatement> {
          const { stmtId, columns } = await call<{ stmtId: number; columns: SqliteColumn[] }>("prepare", {
            dbId,
            sql,
          });
          return {
            all: (...params: unknown[]) => call<unknown[]>("stmtAll", { stmtId, params }),
            get: (...params: unknown[]) => call<unknown>("stmtGet", { stmtId, params }),
            run: (...params: unknown[]) =>
              call<{ changes: number | bigint; lastInsertRowid: number | bigint }>("stmtRun", { stmtId, params }),
            columns: async () => columns,
          };
        },
        exec: async (sql: string) => {
          await call("exec", { dbId, sql });
        },
        close: async () => {
          await call("close", { dbId });
        },
      };
    },
    async exportBytes(path: string): Promise<Uint8Array> {
      const bytes = await call<Uint8Array>("export", { path });
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    },
  };
}
