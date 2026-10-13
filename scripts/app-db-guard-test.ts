/**
 * The app-owned-database guard: the top-level agent may not reach an app's
 * store with sql_query / sql_write directly — it must call the owning tree.
 * A call from inside an app tree (ctx.boundary) is exempt, and databases no
 * app owns stay reachable.
 * Run: `npm run test:app-db-guard`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/index.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-appdb-"));
const reg = new ToolRegistry(workspace, []);
const call = (name: string, args: Record<string, unknown>, ctx?: { boundary?: boolean }) =>
  reg.dispatch(name, JSON.stringify(args), ctx);

try {
  // Seed each store from inside an app (boundary true) so the files exist.
  await call("sql_write", { path: "contacts.db", query: "CREATE TABLE t (id INTEGER)" }, { boundary: true });
  await call("sql_write", { path: "comms.db", query: "CREATE TABLE t (id INTEGER)" }, { boundary: true });
  await call("sql_write", { path: "email.db", query: "CREATE TABLE t (id INTEGER)" }, { boundary: true });
  await call("sql_write", { path: "notes.db", query: "CREATE TABLE t (id INTEGER)" });

  // The trunk (no boundary) is refused on an app-owned store, with a pointer.
  const contacts = await call("sql_query", { path: "contacts.db", query: "SELECT 1" });
  assert.equal(typeof contacts, "string");
  assert.match(contacts as string, /"contacts\.db" is owned by the contacts tree/);

  const comms = await call("sql_query", { path: "comms.db", query: "SELECT 1" });
  assert.match(String(comms), /owned by the contacts tree/);

  const email = await call("sql_write", { path: "email.db", query: "INSERT INTO t VALUES (1)" });
  assert.match(String(email), /owned by the email tree/);
  // The refusal routes by CONTENT, not just ownership: email.db is sender
  // profiles with no message log, so "who was emailed" is a contacts question.
  assert.match(String(email), /sender profiles/, "the refusal says what email.db holds");
  assert.match(
    String(email),
    /sent\/received history is a contact `message` attribute/,
    "the refusal points history at the contact message attribute",
  );
  assert.match(String(email), /ask the contacts tree/, "the refusal names the right tree for history");

  // Other owned stores keep the plain refusal (no email hint leaks into them).
  assert.doesNotMatch(String(contacts), /sender profiles/);
  assert.doesNotMatch(String(comms), /sender profiles/);

  // A path with directories still matches by basename.
  const nested = await call("sql_query", { path: "some/dir/contacts.db", query: "SELECT 1" });
  assert.match(String(nested), /owned by the contacts tree/);

  // Inside an app (boundary true), the app may reach its own store.
  const fromApp = await call("sql_query", { path: "contacts.db", query: "SELECT 1" }, { boundary: true });
  assert.equal(typeof fromApp, "object", "an app may query its own store");

  // A database no app owns stays reachable from the trunk.
  const other = await call("sql_query", { path: "notes.db", query: "SELECT 1" });
  assert.equal(typeof other, "object", "an unowned db is reachable");

  console.log("app-db-guard: trunk refused, app exempt, unowned reachable OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
