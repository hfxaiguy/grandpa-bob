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
 *
 * The writable wrapper resolves its handle by NAME on every call instead of
 * closing over one connection. `close(name)` (used by the dump replay path) can
 * therefore invalidate the handle while app modules still hold the wrapper
 * `open()` returned; their next call reopens from the freshly applied file
 * rather than using a dead handle. One writer per file per store is preserved
 * because `writers` holds at most one promise.
 */
export function createAppStore(platform: Platform): AppStore {
  const writers = new Map<string, Promise<SqliteDatabase>>();

  function assertName(name: string): void {
    if (!name || name.includes("/") || name.includes("\\") || !name.endsWith(".db")) {
      throw new Error(`app database name must be a root-level .db name, got ${JSON.stringify(name)}`);
    }
  }

  function dirty(name: string): Promise<void> {
    return markDatabaseDirty(platform, name);
  }

  /** The cached writable connection for `name`, opened on first use. */
  function openWriter(name: string): Promise<SqliteDatabase> {
    let pending = writers.get(name);
    if (!pending) {
      const abs = platform.path.join(platform.workspaceRoot, name);
      pending = platform.sqlite.open(abs, { readOnly: false });
      writers.set(name, pending);
      pending.catch(() => {
        if (writers.get(name) === pending) writers.delete(name);
      });
    }
    return pending;
  }

  async function closeWriter(name: string): Promise<void> {
    const pending = writers.get(name);
    writers.delete(name);
    if (!pending) return;
    let db: SqliteDatabase;
    try {
      db = await pending;
    } catch {
      return; // the open failed; nothing was cached to close
    }
    // A persist failure here is real: the caller (the dump replay) must not
    // record the baseline as if the applied image had reached disk.
    await db.close();
  }

  function wrapReadOnly(raw: SqliteDatabase): AppDatabase {
    const wrapStatement = (stmt: SqliteStatement): AppStatement => ({
      all: (...params) => stmt.all(...params),
      get: (...params) => stmt.get(...params),
      run: async (...params) => stmt.run(...params),
      columns: () => stmt.columns(),
    });
    return {
      async prepare(sql) {
        return wrapStatement(await raw.prepare(sql));
      },
      async exec(sql) {
        await raw.exec(sql);
      },
      close: () => raw.close(),
    };
  }

  function wrapWriter(name: string): AppDatabase {
    const wrapStatement = (stmt: SqliteStatement): AppStatement => ({
      all: (...params) => stmt.all(...params),
      get: (...params) => stmt.get(...params),
      run: async (...params) => {
        const result = await stmt.run(...params);
        await dirty(name);
        return result;
      },
      columns: () => stmt.columns(),
    });

    return {
      async prepare(sql) {
        return wrapStatement(await (await openWriter(name)).prepare(sql));
      },
      async exec(sql) {
        await (await openWriter(name)).exec(sql);
        await dirty(name);
      },
      close: () => closeWriter(name),
    };
  }

  return {
    async open(name, opts = {}) {
      assertName(name);
      if (opts.readOnly === true) {
        const abs = platform.path.join(platform.workspaceRoot, name);
        return wrapReadOnly(await platform.sqlite.open(abs, { readOnly: true }));
      }
      // Surface an unreadable/corrupt DB here, where the caller expects the
      // open to fail, but hand back a name-resolving wrapper (see above).
      await openWriter(name);
      return wrapWriter(name);
    },

    async close(name?: string) {
      const names = name ? [name] : [...writers.keys()];
      for (const n of names) await closeWriter(n);
    },
  };
}
