/**
 * The app-owned-database guard in the browser worker's tool map. bob-web used
 * to expose sql_query / sql_write without the Node registry's guard, so the
 * trunk could raw-write contacts.db / comms.db / email.db. The guard now lives
 * in the shared app-dbs module and both targets refuse the same stores.
 *
 * A call from inside an app tree (`ctx.boundary`) is exempt — the app owns its
 * store — and databases no app owns stay reachable.
 *
 * Run: `npm run test:browser-sql-guard`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserTools } from "../web/src/agent/browser-tools.js";
import { createNodePlatform } from "../src/platform/node.js";
import { createAppStore } from "../src/app-store.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-web-sql-"));
const platform = createNodePlatform(workspace);
const store = createAppStore(platform);
const tools = browserTools(platform, { store });

try {
  // ── the trunk is refused on app-owned stores ──────────────────────────
  const refusedWrite = await tools.sql_write.execute({
    path: "contacts.db",
    query: "CREATE TABLE t (id INTEGER)",
  });
  assert.equal(typeof refusedWrite, "string", "a refusal is a string, like the Node registry's");
  assert.match(refusedWrite as string, /"contacts\.db" is owned by the contacts tree/);

  const refusedRead = await tools.sql_query.execute({ path: "comms.db", query: "SELECT 1" });
  assert.match(String(refusedRead), /owned by the contacts tree/);

  const refusedEmail = await tools.sql_write.execute({
    path: "email.db",
    query: "CREATE TABLE t (id INTEGER)",
  });
  assert.match(String(refusedEmail), /owned by the email tree/);
  assert.match(String(refusedEmail), /sender profiles/, "the refusal keeps its content hint");

  // A path with directories still matches by basename.
  const nested = await tools.sql_query.execute({ path: "some/dir/contacts.db", query: "SELECT 1" });
  assert.match(String(nested), /owned by the contacts tree/);

  // ── inside an app tree the app may reach its own store ────────────────
  const fromApp = (await tools.sql_write.execute(
    { path: "contacts.db", query: "CREATE TABLE own (id INTEGER)" },
    { boundary: true },
  )) as { changes?: number };
  assert.equal(typeof fromApp, "object", "an app may write its own store");
  assert.equal(Number(fromApp.changes), 0);

  const appRead = await tools.sql_query.execute(
    { path: "contacts.db", query: "SELECT COUNT(*) AS n FROM own" },
    { boundary: true },
  );
  assert.equal(typeof appRead, "object", "an app may query its own store");

  // ── databases no app owns stay reachable from the trunk ───────────────
  const unowned = await tools.sql_write.execute({
    path: "notes.db",
    query: "CREATE TABLE t (id INTEGER)",
  });
  assert.equal(typeof unowned, "object", "an unowned db is reachable");

  console.log("browser-sql-guard: trunk refused, app exempt, unowned reachable OK");
} finally {
  await store.close();
  await rm(workspace, { recursive: true, force: true });
}
