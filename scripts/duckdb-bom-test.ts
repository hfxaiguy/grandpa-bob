/**
 * DuckDB header round-trip guard (@duckdb/node-api BOM bug).
 *
 * node-api strips leading U+FEFF from every VARCHAR value it hands back,
 * while DuckDB's binder matches identifiers against the *stored* column
 * name. A CSV header with a mid-file BOM (exporters write these after
 * merging sheets) therefore poisons the profile: duckdb_columns() reports
 * "first_name", quoting that in the next query throws Binder Error, and
 * the candidate list shows the untypeable "\uFEFFfirst_name". The tool now
 * sanitizes header names at materialization so reported == queryable.
 *
 * Run: npm run test:duckdb
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DuckdbTools } from "../src/tools/duckdb.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-duckdb-bom-"));

const tools = new DuckdbTools(ws);

async function write(name: string, header: string, row: string) {
  await fs.writeFile(path.join(ws, name), header + "\n" + row + "\n", "utf8");
}

// ── 1. mid-header BOM: profile name must be queryable ──
await write("bom.csv", "Name,\uFEFFfirst_name,Email", "a,b,c");
{
  const cols = await tools.query(
    "SELECT column_name FROM duckdb_columns() WHERE table_name = 'csv' ORDER BY column_index",
    "bom.csv",
  );
  const names = (cols.rows as { column_name: string }[]).map((r) => r.column_name);
  assert.deepEqual(names, ["Name", "first_name", "Email"], "reported names are BOM-free");

  // The exact round-trip that killed the contact import: quote whatever the
  // profile reported and select it.
  const q = await tools.query('SELECT "first_name" FROM csv', "bom.csv");
  assert.deepEqual(q.rows, [{ first_name: "b" }], "reported name is queryable");
  console.log("1. BOM header round-trips: duckdb_columns() name == binder name");
}

// ── 2. BOM on the first column (classic file-level BOM) still fine ──
await write("bom0.csv", "\uFEFFEmail,Name", "e,n");
{
  const q = await tools.query('SELECT "Email" FROM csv', "bom0.csv");
  assert.deepEqual(q.rows, [{ Email: "e" }]);
  console.log("2. file-level BOM column queryable by clean name");
}

// ── 3. collision after sanitizing: fall back to raw names, no crash ──
await write("dup.csv", "a,\uFEFFa,b", "1,2,3");
{
  const cols = await tools.query(
    "SELECT column_name FROM duckdb_columns() WHERE table_name = 'csv'",
    "dup.csv",
  );
  assert.equal((cols.rows as unknown[]).length, 3, "all columns still visible");
  const q = await tools.query("SELECT count(*) AS n FROM csv", "dup.csv");
  assert.equal(Number((q.rows as { n: unknown }[])[0].n), 1);
  console.log("3. BOM/plain name collision degrades gracefully");
}

// ── 4. clean files unchanged (no rename projection at all) ──
await write("clean.csv", "First Name,last_name", "x,y");
{
  const q = await tools.query('SELECT "First Name", "last_name" FROM csv', "clean.csv");
  assert.deepEqual(q.rows, [{ "First Name": "x", last_name: "y" }]);
  console.log("4. clean headers pass through untouched");
}

console.log("duckdb-bom-test: all assertions passed");
