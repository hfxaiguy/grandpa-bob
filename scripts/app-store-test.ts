/**
 * The app store's one-writer contract, and handle invalidation.
 *
 * `applyDatabaseDumps` closes the cached writable handle before it replays a
 * dump (one in-memory copy per file). App modules cache the wrapper `open()`
 * returned, so that wrapper must resolve its handle by name and reopen after a
 * close instead of failing on a dead id.
 *
 * Run: `npm run test:app-store`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodePlatform } from "../src/platform/node.js";
import { createAppStore } from "../web/src/app-store.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-app-store-"));
const platform = createNodePlatform(workspace);

async function names(): Promise<string[]> {
  const store = createAppStore(platform);
  const db = await store.open("people.db", { readOnly: true });
  try {
    const rows = (await (await db.prepare("SELECT name FROM people ORDER BY id")).all()) as Array<{
      name: string;
    }>;
    return rows.map((row) => String(row.name));
  } finally {
    await db.close();
  }
}

try {
  const store = createAppStore(platform);
  const first = await store.open("people.db");
  await first.exec("CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  const insert = await first.prepare("INSERT INTO people (name) VALUES (?)");
  await insert.run("Ada");

  // A dump replay closes the cached writer; the wrapper app code still holds
  // must reopen rather than fail on a dead handle.
  await store.close("people.db");
  await first.exec("CREATE TABLE IF NOT EXISTS marker (id INTEGER)");
  const more = await first.prepare("INSERT INTO people (name) VALUES (?)");
  await more.run("Grace");

  assert.deepEqual(await names(), ["Ada", "Grace"], "the closed wrapper reopened and wrote");

  // Read-only opens are per-request and never touch the cached writer.
  const read = await store.open("people.db", { readOnly: true });
  await read.close();
  const write = await store.open("people.db");
  await write.exec("INSERT INTO people (name) VALUES ('Linus')");
  assert.deepEqual(await names(), ["Ada", "Grace", "Linus"], "the writer stayed current");

  console.log("app-store: one by-name writer, and a closed wrapper reopens OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
