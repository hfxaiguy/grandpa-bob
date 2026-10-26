/**
 * .env editor regression guard.
 *
 * Two field reports, both fixed here:
 *  - the admin's parser dropped whole files (CRLF endings, a UTF-8 BOM,
 *    `export KEY=…` lines, lowercase/dotted/hyphenated names), so the "All
 *    .env keys" editor showed "(no keys — add one below)" while the bot
 *    (dotenv) ran fine — and saving then looked like a no-op;
 *  - "Save all keys" answered a flat "nothing to change", whether the editor
 *    had no rows at all or just a blank KEY NAME box. It now says which, takes
 *    a pasted `KEY=value` line, validates the name, and reports where the save
 *    went (the .env file vs the browser profile).
 *
 * The client half runs the real inline script from /settings in a VM with a
 * minimal DOM, the same way a browser would.
 *
 * Run: npm run test:env-editor
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import events from "node:events";
import { startAdmin } from "../src/admin.js";

// ── server: dotenv-compatible parse + rewrite ─────────────────────────
const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-env-editor-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const envFile = path.join(ws, ".env");
await fs.writeFile(
  envFile,
  "\uFEFF# keep this comment\r\n" +
    "TEST_PLAIN=plain\r\n" +
    'export TEST_EXPORT="quoted value"\r\n' +
    "test_lower=lower\r\n" +
    "test.dotted=dot\r\n" +
    "test-hyphen=hyphen\r\n",
);

const port = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address() as net.AddressInfo;
    s.close(() => resolve(port));
  });
});

const server = startAdmin({ port, workspaceDir: ws, projectDir: ws, envPath: envFile });
await events.once(server, "listening");
const base = `http://127.0.0.1:${port}`;

{
  const s = await (await fetch(`${base}/api/status`)).json();
  for (const key of ["TEST_PLAIN", "TEST_EXPORT", "test_lower", "test.dotted", "test-hyphen"]) {
    assert.ok(key in s.env, `${key} survives a BOM/CRLF/export-prefixed file`);
  }
  assert.equal(s.env.TEST_PLAIN, "plain");
  assert.equal(s.env.TEST_EXPORT, '"quoted value"', "quoted values stay verbatim");
  console.log("/api/status: BOM + CRLF + export + lowercase/dotted/hyphen keys visible");
}

{
  const res = await fetch(`${base}/api/env`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ TEST_PLAIN: "changed", test_lower: null, TEST_NEW: "new" }),
  });
  assert.equal(res.status, 200);
  const text = await fs.readFile(envFile, "utf8");
  assert.ok(!text.startsWith("\uFEFF"), "BOM stripped on rewrite");
  assert.ok(!text.includes("\r"), "CRLF normalized to LF");
  assert.match(text, /^# keep this comment$/m, "comments preserved");
  assert.match(text, /^export TEST_EXPORT="quoted value"$/m, "untouched export lines preserved verbatim");
  assert.match(text, /^TEST_PLAIN=changed$/m, "existing key updated");
  assert.doesNotMatch(text, /^test_lower=/m, "removed key deleted");
  assert.match(text, /^TEST_NEW=new$/m, "new key appended");
  console.log("/api/env: rewrite keeps comments and untouched lines, normalizes endings");
}

// ── client: the real settings script in a DOM shim ────────────────────
const html = await (await fetch(`${base}/settings`)).text();
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const js = blocks.find((b) => b.includes("function saveAllEnv"));
assert.ok(js, "/settings serves the env editor script");

type El = {
  style: { cssText: string; display?: string; setProperty(): void };
  children: El[];
  classList: { add(): void; remove(): void; toggle(): void };
  dataset: Record<string, string>;
  textContent: string;
  innerHTML: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  title: string;
  className: string;
  id: string;
  append(...xs: El[]): void;
  appendChild(x: El): El;
  addEventListener(): void;
  setAttribute(): void;
  focus(): void;
  remove(): void;
  querySelectorAll(): El[];
  onclick: (() => void) | null;
  oninput: (() => void) | null;
  onchange: (() => void) | null;
  onsubmit: (() => void) | null;
};

function makeEl(tag = "div"): El {
  const el: El = {
    style: { cssText: "", setProperty() {} },
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    _text: "",
    _html: "",
    get textContent() { return this._text; },
    set textContent(v: string) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v: string) { this._html = String(v); this.children = []; this._text = ""; },
    value: "",
    checked: false,
    disabled: false,
    title: "",
    className: "",
    id: "",
    append(...xs: El[]) { this.children.push(...xs); },
    appendChild(x: El) { this.children.push(x); return x; },
    addEventListener() {},
    setAttribute() {},
    focus() {},
    remove() {},
    querySelectorAll() { return []; },
    onclick: null,
    oninput: null,
    onchange: null,
    onsubmit: null,
  } as unknown as El & { _text: string; _html: string };
  (el as unknown as { tagName: string }).tagName = String(tag).toUpperCase();
  return el;
}

const elements = new Map<string, El>();
const document = {
  hidden: false,
  body: makeEl("body"),
  getElementById(id: string) {
    if (!elements.has(id)) elements.set(id, makeEl("div"));
    return elements.get(id)!;
  },
  createElement(tag: string) { return makeEl(tag); },
  querySelectorAll() { return [] as El[]; },
  querySelector() { return null; },
  addEventListener() {},
};

const posts: string[] = [];
const reply = (body: unknown) => ({ ok: true, json: async () => body });
const sandbox = {
  console,
  document,
  window: { __UI_VERSION__: "test", addEventListener() {}, location: { reload() {} } },
  location: { reload() {} },
  fetch: async (p: string, opts?: { body?: string }) => {
    const url = String(p);
    if (url === "/api/status") {
      return reply({ env: { TEST_PLAIN: "plain" }, services: [], uptimeSec: 1, pid: 1 });
    }
    if (url === "/api/env") { posts.push(String(opts?.body ?? "")); return reply({ ok: true }); }
    if (url === "/api/session") return reply({ follow: false });
    if (url === "/api/capabilities") return reply({ admin: true });
    if (url === "/api/secrets") return reply({ secrets: [] });
    if (url === "/api/models") return reply({ json: "" });
    if (url === "/api/pattern") return reply({ patterns: [] });
    return reply({});
  },
  setTimeout: () => 0,
  setInterval: () => 0,
  clearTimeout() {},
  clearInterval() {},
};
(sandbox as unknown as { globalThis: unknown }).globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(js, ctx, { filename: "/settings#inline" });

const run = (code: string) => vm.runInContext(code, ctx) as unknown;
const rows = () => JSON.parse(run("JSON.stringify(envRows)") as string);
const toast = () => document.getElementById("toast").textContent;
const tick = () => new Promise((r) => setTimeout(r, 40));

await tick(); // initial refreshStatus() populates the editor
assert.deepEqual(JSON.parse(run("JSON.stringify(collectEnvUpdates())") as string), { TEST_PLAIN: "plain" });

// A pasted whole line lands in both boxes, `export ` and value quotes intact.
run("addEnvKey()");
{
  const wraps = document.getElementById("env-keys").children;
  const wrap = wraps[wraps.length - 1];
  const keyInput = wrap.children[0].children[0];
  const valInput = wrap.children[1];
  keyInput.value = 'export PASTED_KEY="pasted value"';
  keyInput.oninput!();
  const row = rows()[rows().length - 1];
  assert.equal(row.key, "PASTED_KEY");
  assert.equal(row.value, '"pasted value"');
  assert.equal(keyInput.value, "PASTED_KEY", "name box shows just the name");
  assert.equal(valInput.value, '"pasted value"', "value box receives the value");

  // Split happens at the FIRST `=` only.
  run("addEnvKey()");
  const wraps2 = document.getElementById("env-keys").children;
  const key2 = wraps2[wraps2.length - 1].children[0].children[0];
  key2.value = "PASTED_PLAIN=a=b";
  key2.oninput!();
  assert.equal(rows().at(-1).key, "PASTED_PLAIN");
  assert.equal(rows().at(-1).value, "a=b");
  console.log("client: a pasted KEY=value line fills name and value");
}

// Saving from the admin: POST body carries the rows, toast says restart.
await run("saveAllEnv()");
assert.equal(posts.length, 1);
{
  const body = JSON.parse(posts[0]);
  assert.equal(body.PASTED_KEY, '"pasted value"');
  assert.equal(body.PASTED_PLAIN, "a=b");
  assert.match(toast(), /saved — restart the bot to apply/);
}

// Empty-state hints name the actual mistake.
run("envRows = []");
await run("saveAllEnv()");
assert.match(toast(), /no keys loaded — press \+ Add key first/);

run('envRows = [{ key: "", orig: "", value: "oops", removed: false }]');
await run("saveAllEnv()");
assert.match(toast(), /put the key name in the left box/);

run('envRows = [{ key: "", orig: "", value: "", removed: false }]');
await run("saveAllEnv()");
assert.match(toast(), /type the key name in the left box and its value/);

// An invalid name is rejected before it can silently vanish from the editor.
run('envRows = [{ key: "bad key", orig: "", value: "x", removed: false }]');
const before = posts.length;
await run("saveAllEnv()");
assert.equal(posts.length, before, "invalid key name never reaches the server");
assert.match(toast(), /invalid key name: bad key/);

// Browser profile mode: no .env, no restart — the shim persists to localStorage.
run("serverAdmin = false");
run('envRows = [{ key: "TEST_PLAIN", orig: "", value: "1", removed: false }]');
await run("saveAllEnv()");
assert.match(toast(), /saved to this browser profile — applies immediately/);

console.log("client: paste split, specific hints, key validation, browser-mode toast");

server.close();
console.log("env-editor-test: all assertions passed");
