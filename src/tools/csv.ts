// src/tools/csv.ts
//
// One agent tool: csv_query — read-only SQL over a single CSV/TSV file.
//
// The file is parsed and materialized into a fresh in-memory SQLite database
// as the table `csv`, then the query runs against that same handle. The engine
// comes from the injected Platform.sqlite (Node: node:sqlite; tab: sqlite-wasm)
// or from an explicit scratch factory — the browser worker passes its wasm
// factory here so CSV work stays in-tab even when workspace storage is the
// desktop bridge (whose per-call handles cannot hold a temp table).
//
// Contract (kept close to the retired DuckDB tool so tree guides port over):
// one read-only statement, `.csv`/`.tsv` only, the relation is named `csv`,
// results carry columns/rows/rowCount/truncated, and at most 100 rows come
// back while aggregates still see every row.

import type { Platform, SqliteFactory } from "../platform/types.js";
import { parseCsv, quoteIdent, quoteValue } from "../platform/csv.js";
import { resolveInWorkspace } from "../util/paths.js";

const MAX_ROWS = 100;
const MAX_CELL = 500;
/** Refuse files big enough to strain a tab before parsing them twice. */
const MAX_BYTES = 32 * 1024 * 1024;
/** Rows per INSERT statement (one message/exec per batch, not per row). */
const BATCH = 500;

const READ_ONLY = /^(SELECT|WITH|EXPLAIN|PRAGMA)\b/i;

function truncateCell(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_CELL) {
    return value.slice(0, MAX_CELL) + "…";
  }
  return value;
}

export class CsvTools {
  private platform: Platform;
  /**
   * Engine used for the scratch database. Defaults to the workspace engine;
   * the tab passes its wasm factory so this works in every storage mode.
   */
  private scratch?: SqliteFactory;

  constructor(platform: Platform, scratch?: SqliteFactory) {
    this.platform = platform;
    this.scratch = scratch;
  }

  /**
   * Run a read-only statement over one CSV/TSV exposed as the `csv` table.
   * Returns { csv, sql, columns, rows, rowCount, truncated }.
   */
  async query(sql: string, pathArg: string): Promise<Record<string, unknown>> {
    const statement = String(sql ?? "").trim().replace(/;\s*$/, "");
    if (!statement) throw new Error("no SQL query provided");
    if (!READ_ONLY.test(statement)) {
      throw new Error(
        "csv_query is read-only: use SELECT, WITH, EXPLAIN, or PRAGMA " +
          "(the CSV is loaded as the table `csv`)",
      );
    }
    if (statement.includes(";")) {
      throw new Error("csv_query accepts one SQL statement at a time");
    }

    const rel = String(pathArg ?? "").trim();
    if (!rel) throw new Error('path is required (a workspace-relative .csv or .tsv file, e.g. "leads.csv")');
    const name = rel.replace(/^.*\//, "");
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (ext !== ".csv" && ext !== ".tsv") {
      throw new Error("csv_query only accepts .csv and .tsv files");
    }

    const abs = resolveInWorkspace(this.platform.workspaceRoot, rel);
    const stat = await this.platform.fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new Error(`file not found: ${rel}`);

    const text = await this.platform.fs.readFile(abs, "utf8");
    if (text.length > MAX_BYTES) {
      throw new Error(
        `file is too large for csv_query (${Math.round(text.length / 1024 / 1024)} MB; limit 32 MB) — ` +
          "split it or work on it on the desktop",
      );
    }

    const { columns, records } = parseCsv(text, { delimiter: ext === ".tsv" ? "\t" : "," });
    if (columns.length === 0) throw new Error(`no header row found in ${rel}`);

    const factory = this.scratch ?? this.platform.sqlite;
    // `scratch` tells the tab's worker to keep this database in memory only —
    // never load or persist an OPFS file for it.
    const db = await factory.open(":memory:", { readOnly: false, scratch: true });
    try {
      await db.exec(
        `CREATE TABLE csv (${columns.map(quoteIdent).join(", ")})`,
      );
      for (let i = 0; i < records.length; i += BATCH) {
        const values = records
          .slice(i, i + BATCH)
          .map((row) => `(${row.map(quoteValue).join(", ")})`)
          .join(", ");
        await db.exec(`INSERT INTO csv VALUES ${values}`);
      }

      const stmt = await db.prepare(statement);
      const resultColumns = (await stmt.columns()).map((c) => c.name);
      const raw = (await stmt.all()) as Array<Record<string, unknown>>;
      const rows = raw.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(row)) out[key] = truncateCell(row[key]);
        return out;
      });
      return {
        csv: rel,
        sql: statement,
        columns: resultColumns,
        rows: rows.slice(0, MAX_ROWS),
        rowCount: rows.length,
        truncated: rows.length > MAX_ROWS,
      };
    } finally {
      await db.close();
    }
  }
}

/** OpenAI tool schema, shared by the Node registry and the browser worker. */
export const CSV_QUERY_DEFINITION = {
  type: "function" as const,
  function: {
    name: "csv_query",
    description:
      "Run read-only SQL over a CSV or TSV file in the workspace. The file is loaded as the table `csv`; " +
      "use PRAGMA table_info(csv) to inspect its columns. Asked-of-a-file work (counts, filters, " +
      "aggregates) is the point: only the first 100 rows are returned, but rowCount reports the full " +
      "match count and truncated says whether rows were withheld. One SELECT/WITH/EXPLAIN/PRAGMA " +
      "statement per call.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Read-only SQL using the `csv` table" },
        path: { type: "string", description: "Relative .csv or .tsv path in the workspace" },
      },
      required: ["query", "path"],
    },
  },
};
