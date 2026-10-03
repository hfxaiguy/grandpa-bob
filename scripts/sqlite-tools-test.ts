/**
 * SqliteTools over the Platform seam. Uses the Node adapter here (node:sqlite);
 * the same class runs in the browser over the sqlite-wasm worker.
 * Run: `npm run test:sqlite`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteTools } from "../src/tools/sqlite.js";
import { createNodePlatform } from "../src/platform/node.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-sqlite-"));
const platform = createNodePlatform(workspace);
const tools = new SqliteTools(platform);

try {
  const created = await tools.write("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, note TEXT)", "people.db");
  assert.equal(created.changes, 0);
  assert.equal(created.database, path.join(workspace, "people.db"));

  const inserted = await tools.write("INSERT INTO people (name, note) VALUES ('Ada', 'x'), ('Grace', 'y')", "people.db");
  assert.equal(inserted.changes, 2, "two rows inserted");
  assert.ok(Number(inserted.lastInsertRowid) >= 2);

  const rows = await tools.query("SELECT id, name, note FROM people ORDER BY id", "people.db");
  assert.deepEqual(rows.columns, ["id", "name", "note"]);
  assert.equal(rows.rowCount, 2);
  assert.deepEqual(rows.rows, [
    { id: 1, name: "Ada", note: "x" },
    { id: 2, name: "Grace", note: "y" },
  ]);

  // read-only guard
  await assert.rejects(
    () => tools.query("INSERT INTO people (name) VALUES ('nope')", "people.db"),
    /read-only/,
  );

  // workspace sandbox
  await assert.rejects(() => tools.query("SELECT 1", "../escape.db"), /escapes workspace/);

  // missing path is reported, not silently ignored
  await assert.rejects(() => tools.query("SELECT 1"), /path is required/);

  // locked path ignores the path argument entirely
  const locked = new SqliteTools(platform, path.join(workspace, "people.db"));
  const viaLock = await locked.query("SELECT COUNT(*) AS n FROM people", "/somewhere/else.db");
  assert.equal((viaLock.rows as Array<{ n: number }>)[0].n, 2);

  console.log("sqlite-tools: query/write/guard/sandbox/lock OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
