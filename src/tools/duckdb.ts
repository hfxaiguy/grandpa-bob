import fs from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { resolveInWorkspace } from "../util/paths.js";

const MAX_ROWS = 100;
const MAX_CELL = 500;
const READ_ONLY = /^(SELECT|WITH|DESCRIBE|EXPLAIN|PRAGMA)\b/i;

function truncate(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > MAX_CELL) {
    return value.slice(0, MAX_CELL) + "…";
  }
  return value;
}

function sqlPath(absPath: string): string {
  return absPath.replaceAll("'", "''");
}

export class DuckdbTools {
  constructor(private workspace: string) {}

  /**
   * Run read-only SQL against one CSV file exposed as the `csv` relation.
   * The relation is recreated for each call, so queries cannot retain state
   * or access another workspace file through the DuckDB connection.
   */
  async query(sql: string, csvPath: string): Promise<Record<string, unknown>> {
    const statement = sql.trim().replace(/;\s*$/, "");
    if (!statement) throw new Error("no SQL query provided");
    if (!READ_ONLY.test(statement)) {
      throw new Error("duckdb_query is read-only: use SELECT, WITH, DESCRIBE, EXPLAIN, or PRAGMA");
    }
    if (statement.includes(";")) {
      throw new Error("duckdb_query accepts one SQL statement at a time");
    }

    const absolutePath = resolveInWorkspace(this.workspace, csvPath);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`CSV file not found: ${csvPath}`);
    if (!/\.(csv|tsv)$/i.test(path.basename(absolutePath))) {
      throw new Error("duckdb_query only accepts .csv and .tsv files");
    }

    // Use a fresh in-memory database per call so the materialized CSV and the
    // external-access restriction cannot leak between concurrent tree calls.
    const instance = await DuckDBInstance.create(":memory:", { enable_external_access: "true" });
    const connection = await instance.connect();
    try {
      const delimiter = path.extname(absolutePath).toLowerCase() === ".tsv" ? "\t" : ",";
      const readExpr = `read_csv_auto('${sqlPath(absolutePath)}', delim = '${delimiter}')`;
      // Materialize the file before disabling DuckDB's external access. A view
      // would defer CSV reading until the user's query runs.
      //
      // Header sanitization: exporters sometimes embed a BOM (or stray
      // padding) mid-header, and node-api strips leading U+FEFF from every
      // VARCHAR it returns — so duckdb_columns() reports the clean name
      // while the binder still demands the dirty one. Round-trips are
      // impossible unless the stored names match the reported ones: alias
      // such columns to their sanitized names at creation time.
      const probe = await connection.runAndReadAll(`SELECT * FROM ${readExpr} LIMIT 0`);
      const rawNames = probe.columnNames().map(String);
      const cleanNames = rawNames.map((n) => n.replace(/^\uFEFF+/, "").trim());
      const needsRename = rawNames.some((n, i) => n !== cleanNames[i]);
      const unique = new Set(cleanNames).size === cleanNames.length;
      const projection =
        needsRename && unique
          ? rawNames
              .map((orig, i) => `"${orig.replaceAll('"', '""')}" AS "${cleanNames[i].replaceAll('"', '""')}"`)
              .join(", ")
          : "*";
      await connection.run(`CREATE OR REPLACE TEMP TABLE csv AS SELECT ${projection} FROM ${readExpr}`);
      await connection.run("SET enable_external_access = false");
      const reader = await connection.runAndReadAll(statement);
      await reader.readAll();
      const rawRows = reader.getRowObjectsJS();
      const rows = rawRows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) out[key] = truncate(value);
        return out;
      });
      return {
        csv: csvPath,
        sql: statement,
        columns: reader.columnNames(),
        rows: rows.slice(0, MAX_ROWS),
        rowCount: rows.length,
        truncated: rows.length > MAX_ROWS,
      };
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }
}
