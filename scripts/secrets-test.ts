/**
 * App secret config files — declaration, storage, delivery.
 *
 *   1. SecretsStore: CRUD, binary round-trip, persistence across reopen,
 *      0600 file mode, strict name validation.
 *   2. Manifests: app/<name>/secrets.json (array or {secrets:[...]}),
 *      invalid names and broken files ignored.
 *   3. App tools: execute(args, ctx) reads ONLY its own app's secrets
 *      (ctx.secret/secretText/requireSecret/listSecrets); a missing
 *      secret raises a WebUI-hinting error.
 *   4. Admin API: list requests (present/missing), multipart upload,
 *      delete, and the store stays invisible to the file browser.
 *
 * Run: npm run test:secrets
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { SecretsStore, listSecretRequests, validSecretName } from "../src/secrets.js";
import { loadAppTools } from "../src/app-tools.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-secrets-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
// The store lives OUTSIDE the workspace (the workspace leaks via git).
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-secret-data-"));
const storePath = path.join(dataDir, "grandpa-bob", "secrets.db");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

// ── 1. store basics ──
{
  const store = new SecretsStore(storePath);
  assert.ok(validSecretName("creds.json") && validSecretName("google-service-account.json"));
  assert.ok(!validSecretName("../etc/passwd") && !validSecretName("a/b") && !validSecretName(".hidden") && !validSecretName(""));
  store.put("calendar", "creds.json", Buffer.from('{"k":"v"}'), "application/json");
  const got = store.get("calendar", "creds.json");
  assert.ok(got, "stored secret retrievable");
  assert.equal(got.content.toString(), '{"k":"v"}');
  assert.equal(got.contentType, "application/json");
  assert.equal(store.list("calendar").length, 1);
  assert.equal(store.list("other").length, 0);
  // setFields merges (dotted keys -> nested, null removes) instead of replacing.
  store.put("calendar", "vars.json", Buffer.from('{"keep":1,"drop":2}'), "application/json");
  store.setFields("calendar", "vars.json", { "auth.token": "t", drop: null });
  assert.deepEqual(
    JSON.parse(store.get("calendar", "vars.json")!.content.toString()),
    { keep: 1, auth: { token: "t" } },
    "setFields merges the named fields, keeping the rest",
  );
  store.delete("calendar", "vars.json");
  store.close();

  const reopened = new SecretsStore(storePath);
  assert.equal(reopened.get("calendar", "creds.json")?.content.toString(), '{"k":"v"}', "survives reopen");
  const mode = (await fs.stat(storePath)).mode & 0o777;
  assert.equal(mode, 0o600, "store file is 0600");
  const dirMode = (await fs.stat(path.dirname(storePath))).mode & 0o777;
  assert.equal(dirMode, 0o700, "store parent directory is 0700");
  assert.ok(!(await fs.stat(path.join(ws, "logs", "secrets.db")).catch(() => null)),
    "nothing is written into the workspace");
  reopened.put("calendar", "bin.dat", Buffer.from([0, 1, 2, 255]));
  assert.deepEqual([...reopened.get("calendar", "bin.dat")!.content], [0, 1, 2, 255], "binary round-trip");
  assert.equal(reopened.delete("calendar", "bin.dat"), true);
  assert.equal(reopened.delete("calendar", "bin.dat"), false, "double delete is a no-op");
  reopened.close();
  console.log("1. store: CRUD, binary, persistence, 0600");
}

// ── 2. manifests ──
{
  await fs.mkdir(path.join(ws, "app", "calendar"), { recursive: true });
  await fs.mkdir(path.join(ws, "app", "mailer"), { recursive: true });
  await fs.mkdir(path.join(ws, "app", "nolist"), { recursive: true });
  await fs.writeFile(
    path.join(ws, "app", "calendar", "secrets.json"),
    JSON.stringify([
      { name: "creds.json", description: "Calendar service account", contentType: "application/json" },
      { name: "../evil", description: "must be skipped" },
      { name: "ok.key", description: "" },
    ]),
  );
  await fs.writeFile(
    path.join(ws, "app", "mailer", "secrets.json"),
    JSON.stringify({ secrets: [{ name: "smtp.txt", description: "SMTP password file" }] }),
  );
  await fs.writeFile(path.join(ws, "app", "nolist", "secrets.json"), "{ not json");

  const requests = await listSecretRequests(ws);
  const byKey = new Map(requests.map((r) => [`${r.app}/${r.name}`, r]));
  assert.ok(byKey.has("calendar/creds.json"));
  assert.ok(byKey.has("calendar/ok.key"), "array form parsed");
  assert.ok(byKey.has("mailer/smtp.txt"), "{secrets:[...]} form parsed");
  assert.ok(!byKey.has("calendar/../evil"), "path-like names rejected");
  assert.equal(requests.filter((r) => r.app === "nolist").length, 0, "broken manifest ignored");
  console.log("2. manifests: array/object forms, junk skipped");
}

// ── 3. app tool context ──
{
  await fs.writeFile(
    path.join(ws, "app", "calendar", "tools.mjs"),
    `export const tools = [{
       name: "calendar_check",
       execute: (args, ctx) => {
         const names = ctx.listSecrets().map((s) => s.name);
         try {
           return { app: ctx.app, creds: ctx.requireSecret("creds.json"), names };
         } catch (e) {
           return { app: ctx.app, error: e.message, names };
         }
       },
     }];\n`,
  );
  const store = new SecretsStore(storePath);
  store.delete("calendar", "creds.json"); // ensure the missing-secret path is exercised
  const tools = await loadAppTools(ws, store);
  const tool = tools.find((t) => t.name === "calendar_check")!;
  assert.ok(tool && tool.app === "calendar");

  const missing = (await tool.execute({}, tool.appContext)) as { error?: string; names: string[] };
  assert.match(String(missing.error), /missing/);
  assert.match(String(missing.error), /WebUI/, "missing-secret error points at the upload page");
  assert.equal(missing.names.length, 0, "listSecrets is empty before any upload");

  store.put("calendar", "creds.json", Buffer.from("SECRET-BYTES"), "application/json");
  const found = (await tool.execute({}, tool.appContext)) as { app: string; creds: string; names: string[] };
  assert.equal(found.app, "calendar");
  assert.equal(found.creds, "SECRET-BYTES");
  assert.ok(found.names.includes("creds.json"), "listSecrets sees the uploaded name");
  store.close();
  console.log("3. app tools: scoped context, requireSecret hint, own data only");
}

// ── 4. admin API + file-browser invisibility ──
{
  // Custom SECRETS_DB inside the workspace (defense-in-depth case): the
  // browser must not serve or list it even then.
  const insidePath = path.join(ws, "logs", "custom-secrets.db");
  const store = new SecretsStore(insidePath);
  store.delete("calendar", "creds.json"); // start from a clean slate
  const port = await freePort();
  const mod = await import("../src/admin.ts?secrets-test");
  const server = mod.startAdmin({ port, workspaceDir: ws, secrets: store, projectDir: ws, envPath: path.join(ws, "absent.env") });
  await events.once(server, "listening");
  const base = `http://127.0.0.1:${port}`;

  const listed = await (await fetch(`${base}/api/secrets`)).json();
  const entry = listed.secrets.find((s: any) => s.app === "calendar" && s.name === "creds.json");
  assert.ok(entry, "declared request listed");
  assert.equal(entry.present, false, "starts missing");

  const boundary = "----gpb" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="creds.json"\r\nContent-Type: application/json\r\n\r\n`),
    Buffer.from('{"client_email":"bot@example.com"}'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await fetch(`${base}/api/secrets?app=calendar&name=creds.json`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(up.status, 200, "upload accepted");
  assert.equal(store.get("calendar", "creds.json")?.content.toString(), '{"client_email":"bot@example.com"}');

  const after = await (await fetch(`${base}/api/secrets`)).json();
  const stored = after.secrets.find((s: any) => s.app === "calendar" && s.name === "creds.json");
  assert.equal(stored.present, true);
  assert.equal(stored.size, 34);
  assert.equal(stored.updatedAt != null, true);

  // Undeclared uploads are refused (no open upload slots).
  const rej = await fetch(`${base}/api/secrets?app=calendar&name=not-declared`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(rej.status, 404, "undeclared secret rejected");
  const evil = await fetch(`${base}/api/secrets?app=..&name=x`, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body });
  assert.equal(evil.status, 400, "path-like app rejected");

  // The store is invisible to the file browser and the download route.
  const files = await (await fetch(`${base}/api/files?path=logs`)).json();
  assert.ok(!files.files.some((f: any) => f.name.startsWith("custom-secrets.db")), "file browser hides the secret store");
  const dl = await fetch(`${base}/api/files/download?path=logs/custom-secrets.db`);
  assert.ok(dl.status >= 400, "download of the secret store refused");

  // ── vars: save ONE field at a time, without overwriting the rest ──
  const varsUrl = `${base}/api/secrets/vars?app=calendar&name=creds.json`;
  const postVars = (b: unknown) =>
    fetch(varsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const storedVars = () => JSON.parse(store.get("calendar", "creds.json")!.content.toString());

  const one = await postVars({ key: "auth.token", value: "tok-1" });
  assert.equal(one.status, 200, "a single field saves");
  assert.deepEqual(storedVars(), { client_email: "bot@example.com", auth: { token: "tok-1" } }, "only the named field changed");

  await postVars({ key: "from", value: "bot@example.com" });
  assert.deepEqual(
    storedVars(),
    { client_email: "bot@example.com", auth: { token: "tok-1" }, from: "bot@example.com" },
    "saving a field does not drop the earlier ones",
  );

  await postVars({ set: { provider: "mock", from: null } });
  assert.deepEqual(
    storedVars(),
    { client_email: "bot@example.com", auth: { token: "tok-1" }, provider: "mock" },
    "set merges several and a null removes one",
  );

  assert.equal((await postVars({ key: "../evil", value: "x" })).status, 400, "path-like key rejected");
  assert.equal((await postVars({ key: "a..b", value: "x" })).status, 400, "doubled dot rejected");
  const undeclared = await fetch(`${base}/api/secrets/vars?app=calendar&name=not-declared`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "x", value: "y" }),
  });
  assert.equal(undeclared.status, 404, "undeclared secret rejected");

  // Legacy full-replace still replaces; merging a non-JSON secret is refused.
  await postVars({ value: { only: "this" } });
  assert.deepEqual(storedVars(), { only: "this" }, "value replaces the whole document");
  store.put("calendar", "creds.json", Buffer.from("not-json"), "text/plain");
  assert.equal((await postVars({ key: "x", value: "y" })).status, 409, "a non-JSON secret cannot be merged into");

  const del = await fetch(`${base}/api/secrets?app=calendar&name=creds.json`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(store.get("calendar", "creds.json"), null, "delete removes bytes");
  server.close();
  store.close();
  console.log("4. admin API: upload/list/delete + store invisible to file browser");
}

console.log("secrets-test: all assertions passed");
process.exit(0);
