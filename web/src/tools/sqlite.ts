// src/tools/sqlite.ts
//
// Two SQLite tools for the agent:
//
//   sql_query  — READ-ONLY. Runs SELECT / WITH / EXPLAIN / PRAGMA and returns
//                structured rows. The database is opened with the read-only
//                flag, so writes are refused at the engine level even if
//                read-only SQL were somehow bypassed.
//
//   sql_write  — READ-WRITE. Explicitly runs INSERT / UPDATE / DELETE / DDL
//                (and any query) and reports affected rows.
//
// The engine comes from the injected `Platform.sqlite` (Node: node:sqlite;
// browser: sqlite-wasm), so this module has no Node dependency.

import type { Platform, SqliteDatabase } from "../platform/types.js";
import type { AppStore } from "../app-store.js";
import { resolveInWorkspace } from "../util/paths.js";
import { markDatabaseDirty } from "../db-sync.js";

const MAX_ROWS = 100;
const MAX_CELL = 200;

/** First keyword of a trimmed SQL statement (uppercased). */
function firstKeyword(sql: string): string {
  return sql.replace(/^[\s*(]+/, "").split(/[\s(]/)[0]?.toUpperCase() ?? "";
}

/** SQL statement kinds that are safe to run read-only. */
const RO_SAFE = new Set(["SELECT", "WITH", "EXPLAIN", "PRAGMA"]);

function truncateCell(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_CELL) {
    return value.slice(0, MAX_CELL) + "…";
  }
  return value;
}

export class SqliteTools {
  private platform: Platform;
  private lockedPath?: string;
  private writers?: Pick<AppStore, "open">;

  /**
   * @param writers The host's app-database store (app-store.ts). When given,
   *   a write to a root-level `<name>.db` reuses its cached writable handle
   *   instead of opening a second connection: one writer per file per worker.
   *   Two connections over the browser's OPFS seam can each hold a different
   *   snapshot of `sqlite_sequence`, so a raw insert and an app insert could
   *   otherwise be handed the SAME row id.
   */
  constructor(platform: Platform, lockedPath?: string, writers?: Pick<AppStore, "open">) {
    this.platform = platform;
    this.lockedPath = lockedPath;
    this.writers = writers;
  }

  private resolveDatabase(pathArg?: string): string {
    if (this.lockedPath) return this.lockedPath;
    if (!pathArg) {
      throw new Error(
        'path is required: no database is locked, so pass a workspace-relative .db file (e.g. "contacts.db")',
      );
    }
    return resolveInWorkspace(this.platform.workspaceRoot, pathArg);
  }

  /**
   * Read-only query (SELECT / WITH / EXPLAIN / PRAGMA). Returns a plain JSON
   * object: { database, sql, columns, rows, rowCount, truncated }.
   */
  async query(sql: string, pathArg?: string): Promise<Record<string, unknown>> {
    const statement = sql.trim();
    if (!statement) throw new Error("no SQL query provided");

    const kind = firstKeyword(statement);
    if (!RO_SAFE.has(kind)) {
      throw new Error(
        `sql_query is read-only: only SELECT / WITH / EXPLAIN / PRAGMA are allowed (got "${kind || "?"}")` +
          ` — use sql_write for writes`,
      );
    }

    const database = this.resolveDatabase(pathArg);
    const db = await this.platform.sqlite.open(database, { readOnly: true });
    try {
      const stmt = await db.prepare(statement);
      const rows = (await stmt.all()).map((r) => {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(r as Record<string, unknown>)) {
          out[k] = truncateCell((r as Record<string, unknown>)[k]);
        }
        return out;
      });
      return {
        database,
        sql: statement,
        columns: (await stmt.columns()).map((c) => c.name),
        rows: rows.slice(0, MAX_ROWS),
        rowCount: rows.length,
        truncated: rows.length > MAX_ROWS,
      };
    } finally {
      await db.close();
    }
  }

  /**
   * Read-write statement (INSERT / UPDATE / DELETE / DDL, or any query).
   * Returns { database, sql, changes, lastInsertRowid } and, when the
   * statement returns rows, columns/rows as well.
   */
  async write(sql: string, pathArg?: string): Promise<Record<string, unknown>> {
    const statement = sql.trim();
    if (!statement) throw new Error("no SQL statement provided");

    const database = this.resolveDatabase(pathArg);
    // A write makes the app DB dirty, so a later cheap commit dumps only it.
    const rel = this.platform.path.relative(this.platform.workspaceRoot, database);
    // One writer per file per worker: a root-level `.db` goes through the
    // host's app store, which caches ONE writable handle for app code and SQL
    // tools alike. Nested/foreign paths keep their own short-lived handle.
    const sharedName =
      this.writers && rel && !rel.startsWith("..") && !rel.includes("/") && !rel.includes("\\") && rel.endsWith(".db")
        ? rel
        : null;
    // Mark even when the store also marks it: a row-returning write goes
    // through `stmt.all()`, which the store's wrapper does not treat as a
    // write. markDatabaseDirty is idempotent and ignores nested paths.
    if (rel && rel !== database) await markDatabaseDirty(this.platform, rel).catch(() => {});
    const db: SqliteDatabase = sharedName
      ? await this.writers!.open(sharedName)
      : await this.platform.sqlite.open(database, { readOnly: false });
    const ownsHandle = sharedName == null;
    try {
      const stmt = await db.prepare(statement);
      const columnNames = (await stmt.columns()).map((c) => c.name);

      if (columnNames.length > 0) {
        const rows = (await stmt.all()).map((r) => {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(r as Record<string, unknown>)) {
            out[k] = truncateCell((r as Record<string, unknown>)[k]);
          }
          return out;
        });
        return {
          database,
          sql: statement,
          columns: columnNames,
          rows: rows.slice(0, MAX_ROWS),
          rowCount: rows.length,
          truncated: rows.length > MAX_ROWS,
          changes: 0,
        };
      }

      const info = await stmt.run();
      return {
        database,
        sql: statement,
        columns: [],
        rows: [],
        changes: Number(info.changes),
        rowCount: Number(info.changes),
        lastInsertRowid: info.lastInsertRowid === undefined ? null : Number(info.lastInsertRowid),
      };
    } finally {
      // The store owns its cached handle — closing it here would drop the
      // shared writer mid-run.
      if (ownsHandle) await db.close();
    }
  }
}
