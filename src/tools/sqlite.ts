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

import type { Platform } from "../platform/types.js";
import { resolveInWorkspace } from "../util/paths.js";

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

  constructor(platform: Platform, lockedPath?: string) {
    this.platform = platform;
    this.lockedPath = lockedPath;
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
  query(sql: string, pathArg?: string): Record<string, unknown> {
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
    const db = this.platform.sqlite.open(database, { readOnly: true });
    try {
      const stmt = db.prepare(statement);
      const rows = (stmt.all() as Record<string, unknown>[]).map((r) => {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(r)) out[k] = truncateCell(r[k]);
        return out;
      });
      return {
        database,
        sql: statement,
        columns: stmt.columns().map((c) => c.name),
        rows: rows.slice(0, MAX_ROWS),
        rowCount: rows.length,
        truncated: rows.length > MAX_ROWS,
      };
    } finally {
      db.close();
    }
  }

  /**
   * Read-write statement (INSERT / UPDATE / DELETE / DDL, or any query).
   * Returns { database, sql, changes, lastInsertRowid } and, when the
   * statement returns rows, columns/rows as well.
   */
  write(sql: string, pathArg?: string): Record<string, unknown> {
    const statement = sql.trim();
    if (!statement) throw new Error("no SQL statement provided");

    const database = this.resolveDatabase(pathArg);
    const db = this.platform.sqlite.open(database, { readOnly: false });
    try {
      const stmt = db.prepare(statement);
      const columnNames = stmt.columns().map((c) => c.name);

      if (columnNames.length > 0) {
        const rows = (stmt.all() as Record<string, unknown>[]).map((r) => {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(r)) out[k] = truncateCell(r[k]);
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

      const info = stmt.run();
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
      db.close();
    }
  }
}
