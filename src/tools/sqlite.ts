// src/tools/sqlite.ts
//
// Two SQLite tools for the agent:
//
//   sql_query  — READ-ONLY. Runs SELECT / WITH / EXPLAIN / PRAGMA and returns
//                structured rows. The database is opened with SQLite's
//                readOnly flag, so writes are refused at the engine level even
//                if read-only SQL were somehow bypassed.
//
//   sql_write  — READ-WRITE. Explicitly runs INSERT / UPDATE / DELETE / DDL
//                (and any query) and reports affected rows. Opt-in: the agent
//                only reaches this via a separate tool call, so writes are
//                never an accidental side effect of a "query".
//
// Pointing either tool at a database:
//   1. "Locked" (recommended): construct with `lockedPath` and every query or
//      write runs against that one file, ignoring the `path` argument
//      entirely — the agent can never reach anything else.
//   2. Free: without `lockedPath`, the `path` argument resolves inside the
//      workspace sandbox, so the agent can touch any `.db` it creates.

import { DatabaseSync } from "node:sqlite";
import { resolveInWorkspace } from "../util/paths.js";

const MAX_ROWS = 100;
const MAX_CELL = 200;

export interface SqliteToolsOptions {
  /** Workspace root used to sandbox `path` when `lockedPath` is not set. */
  workspace: string;
  /**
   * Optional absolute path to a single locked database file. When set, the
   * `path` argument is ignored and every query/write runs against this file.
   */
  lockedPath?: string;
}

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

function resolveDatabase(workspace: string, lockedPath: string | undefined, pathArg?: string): string {
  if (lockedPath) return lockedPath;
  if (!pathArg) {
    throw new Error(
      "path is required: no database is locked, so pass a workspace-relative .db file (e.g. \"contacts.db\")",
    );
  }
  return resolveInWorkspace(workspace, pathArg);
}

export class SqliteTools {
  private workspace: string;
  private lockedPath?: string;

  constructor({ workspace, lockedPath }: SqliteToolsOptions) {
    this.workspace = workspace;
    this.lockedPath = lockedPath;
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

    const database = resolveDatabase(this.workspace, this.lockedPath, pathArg);
    const db = new DatabaseSync(database, { readOnly: true });
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

    const database = resolveDatabase(this.workspace, this.lockedPath, pathArg);
    const db = new DatabaseSync(database, { readOnly: false });
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
