// src/app-store.ts
//
// The host-owned database seam for workspace app code.
//
// Apps own their schema and their queries, but they no longer open a private
// `node:sqlite` connection. They ask this store for a database by workspace
// name and get the same async `SqliteDatabase` seam the built-in tools use:
//
//   const db = await store.open("contacts.db");
//   const stmt = await db.prepare("SELECT …");
//   await stmt.all();
//
// Node and browser therefore run the same app code. Writes are marked dirty so
// `db/<name>.db.sql` is re-dumped and committed by the existing sync path.
//
// The browser agent worker sets `globalThis.__BOB_STORE__` before loading app
// modules; the Node entry point does the same before `loadAppTools`. Tests and
// CLIs without a host fall back to the app's local Node store (see
// `app/contacts/src/store.js`) so they keep working standalone.

import { markDatabaseDirty } from "./db-sync.js";
import type { Platform, SqliteDatabase, SqliteStatement } from "./platform/types.js";

export interface AppStatement {
  all(...params: unknown[]): Promise<unknown[]>;
  get(...params: unknown[]): Promise<unknown>;
  run(...params: unknown[]): Promise<{ changes: number | bigint; lastInsertRowid: number | bigint }>;
  columns(): Promise<{ name: string }[]>;
}

export interface AppDatabase {
  prepare(sql: string): Promise<AppStatement>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface AppStore {
  /** Open `<workspace>/<name>`; `name` is a root-level `.db` name. */
  open(name: string, opts?: { readOnly?: boolean }): Promise<AppDatabase>;
  /** Close one cached writable handle by name (no-op when absent). */
  close(name: string): Promise<void>;
  /** Close every cached writable handle (a new open reopens lazily). */
  close(): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __BOB_STORE__: AppStore | undefined;
}

/**
 * A store over a target's `Platform.sqlite`. Writable handles are cached by
 * name; a read-only handle is opened per request and closed by the caller.
 */
export function createAppStore(platform: Platform): AppStore {
  const writers = new Map<string, Promise<SqliteDatabase>>();

  function assertName(name: string): void {
    if (!name || name.includes("/") || name.includes("\\") || !name.endsWith(".db")) {
      throw new Error(`app database name must be a root-level .db name, got ${JSON.stringify(name)}`);
    }
  }

  function wrap(name: string, raw: SqliteDatabase, readOnly: boolean): AppDatabase {
    const dirty = async (): Promise<void> => {
      if (!readOnly) await markDatabaseDirty(platform, name);
    };

    const wrapStatement = (stmt: SqliteStatement): AppStatement => ({
      all: (...params) => stmt.all(...params),
      get: (...params) => stmt.get(...params),
      run: async (...params) => {
        const result = await stmt.run(...params);
        await dirty();
        return result;
      },
      columns: () => stmt.columns(),
    });

    return {
      async prepare(sql) {
        return wrapStatement(await raw.prepare(sql));
      },
      async exec(sql) {
        await raw.exec(sql);
        await dirty();
      },
      close: () => raw.close(),
    };
  }

  return {
    async open(name, opts = {}) {
      assertName(name);
      const readOnly = opts.readOnly === true;
      if (readOnly) {
        const abs = platform.path.join(platform.workspaceRoot, name);
        return wrap(name, await platform.sqlite.open(abs, { readOnly: true }), true);
      }
      let pending = writers.get(name);
      if (!pending) {
        const abs = platform.path.join(platform.workspaceRoot, name);
        pending = platform.sqlite.open(abs, { readOnly: false });
        writers.set(name, pending);
      }
      try {
        return wrap(name, await pending, false);
      } catch (err) {
        writers.delete(name);
        throw err;
      }
    },

    async close(name?: string) {
      const names = name ? [name] : [...writers.keys()];
      const pending = names.map((n) => {
        const p = writers.get(n);
        writers.delete(n);
        return p;
      });
      for (const p of pending) {
        if (!p) continue;
        try {
          await (await p).close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
