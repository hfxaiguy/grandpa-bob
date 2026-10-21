/**
 * CSV parsing + the csv_query tool over the Platform seam. Uses the Node
 * adapter here (node:sqlite); the same class runs in the tab over sqlite-wasm,
 * where the browser worker injects its wasm factory as the scratch engine.
 * Run: `npm run test:csv`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCsv } from "../src/platform/csv.js";
import { CsvTools } from "../src/tools/csv.js";
import { createNodePlatform } from "../src/platform/node.js";
import type { Platform } from "../src/platform/types.js";

// ── parser ───────────────────────────────────────────────────────────────
{
  const { columns, records } = parseCsv("name,phone,note\nAda,555-0101,first\nGrace,555-0102,\n");
  assert.deepEqual(columns, ["name", "phone", "note"]);
  assert.deepEqual(records, [
    ["Ada", "555-0101", "first"],
    ["Grace", "555-0102", null],
  ], "an unquoted empty cell is null");

  const quoted = parseCsv('a,b\n"x, y","line1\nline2"\n"say ""hi""",2\n');
  assert.deepEqual(quoted.records, [
    ["x, y", "line1\nline2"],
    ['say "hi"', 2],
  ], "quotes keep delimiters/newlines and double the escape");

  assert.deepEqual(parseCsv('\uFEFFa,b\r\n1,2\r\n').records, [[1, 2]], "BOM + CRLF");
  assert.deepEqual(parseCsv("a\tb\n1\t2\n", { delimiter: "\t" }).records, [[1, 2]], "TSV");
  assert.deepEqual(parseCsv("a,b\n\n1,2\n").records, [[1, 2]], "blank lines are skipped");
  assert.deepEqual(parseCsv('a,b\n"",\n').records, [["", null]], "quoted empty vs empty");
  assert.deepEqual(parseCsv("a,a\n1,2\n").columns, ["a", "a_2"], "duplicate headers");
  assert.deepEqual(parseCsv("a,b,c\n1\n").records, [[1, null, null]], "short rows pad with null");
  assert.deepEqual(
    parseCsv("id,big\n007,9007199254740993\n").records,
    [["007", "9007199254740993"]],
    "leading zeros and unsafe integers stay text",
  );
  assert.deepEqual(parseCsv("").columns, [], "empty input has no header");
}

// ── tool ─────────────────────────────────────────────────────────────────
const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-csv-"));
const platform = createNodePlatform(workspace);
const tools = new CsvTools(platform);
const abs = (name: string): string => platform.path.join(workspace, name);

const rows = ["name,phone,city"];
for (let i = 0; i < 150; i++) rows.push(`Person ${i},555-${String(1000 + i)},City ${i % 3}`);
const big = "X".repeat(600);

try {
  await platform.fs.writeFile(abs("leads.csv"), rows.join("\n") + "\n");
  await platform.fs.writeFile(abs("big.csv"), `name,note\nAda,"${big}"\n`);
  await platform.fs.writeFile(abs("notes.txt"), "a,b\n1,2\n");

  const count = await tools.query("SELECT COUNT(*) AS n FROM csv", "leads.csv");
  assert.equal((count.rows as Array<{ n: number }>)[0].n, 150);
  assert.deepEqual(count.columns, ["n"]);

  const agg = await tools.query(
    "SELECT city, COUNT(*) AS n FROM csv GROUP BY city ORDER BY city",
    "leads.csv",
  );
  assert.deepEqual(agg.rows, [
    { city: "City 0", n: 50 },
    { city: "City 1", n: 50 },
    { city: "City 2", n: 50 },
  ]);

  const filtered = await tools.query("SELECT name FROM csv WHERE phone = '555-1005'", "leads.csv");
  assert.deepEqual(filtered.rows, [{ name: "Person 5" }]);

  const all = await tools.query("SELECT * FROM csv", "leads.csv");
  assert.equal(all.rowCount, 150, "rowCount reports the full match");
  assert.equal((all.rows as unknown[]).length, 100, "rows are capped");
  assert.equal(all.truncated, true);

  const shape = await tools.query("PRAGMA table_info(csv)", "leads.csv");
  assert.deepEqual((shape.rows as Array<{ name: string }>).map((r) => r.name), ["name", "phone", "city"]);

  const truncatedCell = await tools.query("SELECT note FROM csv", "big.csv");
  const note = (truncatedCell.rows as Array<{ note: string }>)[0].note;
  assert.equal(note.length, 501, "cells are capped at 500 chars + ellipsis");
  assert.ok(note.endsWith("…"));

  await assert.rejects(() => tools.query("INSERT INTO csv VALUES ('x')", "leads.csv"), /read-only/);
  await assert.rejects(() => tools.query("SELECT 1; DROP TABLE csv", "leads.csv"), /one SQL statement/);
  await assert.rejects(() => tools.query("SELECT 1", "notes.txt"), /only accepts \.csv/);
  await assert.rejects(() => tools.query("SELECT 1", "missing.csv"), /file not found/);
  await assert.rejects(() => tools.query("SELECT 1", "../escape.csv"), /escapes workspace/);
  await assert.rejects(() => tools.query("SELECT 1", ""), /path is required/);

  // The scratch engine is injected: CSV work must not depend on the
  // workspace engine. The desktop bridge is exactly this shape — per-call
  // handles that cannot hold a temp table.
  const bridged = {
    ...platform,
    sqlite: {
      open: async (): Promise<never> => {
        throw new Error("bridge handles are per-op");
      },
    },
  } as unknown as Platform;
  const viaScratch = new CsvTools(bridged, platform.sqlite);
  const injected = await viaScratch.query("SELECT COUNT(*) AS n FROM csv", "leads.csv");
  assert.equal((injected.rows as Array<{ n: number }>)[0].n, 150, "scratch factory carries the table");

  console.log("csv: parser edge cases, aggregates, caps and the injected scratch engine OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
