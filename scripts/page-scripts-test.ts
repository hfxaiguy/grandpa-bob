/**
 * Page script regression guard.
 *
 * The chat and settings pages are served as raw HTML — their inline
 * <script> blocks are shipped to the browser verbatim (no transpile).
 * A single TypeScript token (`as`, annotations, `!`) anywhere in them
 * throws SyntaxError at load and kills the *whole* page script — e.g.
 * the pattern dropdown silently stayed empty when a cast leaked into
 * the chat client. Compiles every inline script from both pages with
 * vm.Script to make sure they're valid JavaScript.
 *
 * Run: npm run test:pages
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import events from "node:events";
import { startAdmin } from "../src/admin.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-pages-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

const port = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address() as net.AddressInfo;
    s.close(() => resolve(port));
  });
});

const server = startAdmin({
  port,
  workspaceDir: ws,
  // Hermetic: no .env and no models.json → every probe answers "not
  // configured" without touching the network.
  envPath: path.join(ws, "absent.env"),
  projectDir: ws,
});
await events.once(server, "listening");

let checked = 0;
for (const page of ["/", "/settings"]) {
  const res = await fetch(`http://127.0.0.1:${port}${page}`);
  assert.equal(res.status, 200, `${page} served`);
  const html = await res.text();
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 1, `${page} has inline script(s)`);
  for (const [i, b] of blocks.entries()) {
    new vm.Script(b[1], { filename: `${page}#script-${i}` }); // throws on SyntaxError
    checked++;
  }
  console.log(`${page}: ${blocks.length} inline script block(s) compile`);
}
assert.ok(checked >= 2, "expected scripts on both pages");

// The chat page must wire up the pattern dropdown — the exact symptom of
// the syntax bug was an empty <select>. Assert the markup + loader exist.
const chatHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text();
assert.match(chatHtml, /<select id="pattern-sel"/, "pattern select present");
assert.match(chatHtml, /loadPatternSelect\(\);/, "dropdown is populated on load");
assert.match(chatHtml, /<div id="session-bar"/, "session picker present");
assert.match(chatHtml, /id="session-resume"/, "resume button present");
assert.match(chatHtml, /id="session-new"/, "new-session button present");
assert.match(chatHtml, /id="health-dots"/, "chat header carries service health dots");
assert.match(chatHtml, /loadHealth\(\);/, "health dots are populated on load");
assert.match(chatHtml, /function checkFollow\(\)/, "follow watcher present");

// /api/status must report real service health (telegram / voice / llm),
// each a tri-state (up/down/n-a) with a detail line — the old dots were a
// tmux-session guess that read "off" on any host without tmux.
{
  const s = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.ok(Array.isArray(s.services), "status returns a services array");
  const names = s.services.map((x: any) => x.name);
  for (const want of ["telegram", "voice", "llm"]) {
    assert.ok(names.includes(want), `status lists ${want}`);
  }
  for (const svc of s.services) {
    assert.ok(
      svc.up === true || svc.up === false || svc.up === null,
      `${svc.name}.up is tri-state (got ${JSON.stringify(svc.up)})`,
    );
    assert.equal(typeof svc.detail, "string", `${svc.name} has a detail line`);
    // Hermetic config (no token, no STT, no models.json) => nothing is
    // asserted "up", and crucially no live network call was made.
    assert.notEqual(svc.up, true, `${svc.name} not falsely up with nothing configured`);
  }
  assert.ok(typeof s.uptimeSec === "number" && s.uptimeSec >= 0, "bot uptime reported");
  assert.ok(Number.isInteger(s.pid) && s.pid > 0, "bot pid reported");
  console.log(`/api/status: ${s.services.map((x: any) => `${x.name}=${x.up === null ? "n/a" : x.up}`).join(" ")}`);
}

const settingsHtml = await (await fetch(`http://127.0.0.1:${port}/settings`)).text();
assert.match(settingsHtml, /id="service-dots"/, "settings page renders the service-dots host");
assert.match(settingsHtml, /id="follow-chk"/, "settings follow toggle present");
assert.match(settingsHtml, /id="secrets-list"/, "app secrets card present");
assert.match(settingsHtml, /loadSecrets\(\);/, "app secrets load on page open");

server.close();
console.log("page-scripts-test: all assertions passed");
