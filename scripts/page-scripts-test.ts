/**
 * Settings page script regression guard.
 *
 * The settings page is served as raw HTML — its inline <script> blocks ship to
 * the browser verbatim (no transpile). A single TypeScript token (`as`,
 * annotations, `!`) anywhere in them throws SyntaxError at load and kills the
 * whole page script. Compiles every inline script with vm.Script to make sure
 * they're valid JavaScript.
 *
 * (The chat surface is the built SolidJS app in `ui/`, served as a bundled
 * asset from ui/dist — not raw inline script, so not covered here.)
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

// With no ui/dist in this workspace, "/" serves the build notice (not a page).
{
  const root = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(root, /UI not built/, "an unbuilt ui/dist shows the build notice at /");
}

// Every inline script on /settings must be valid JavaScript.
{
  const res = await fetch(`http://127.0.0.1:${port}/settings`);
  assert.equal(res.status, 200, "/settings served");
  const html = await res.text();
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 1, "/settings has inline script(s)");
  for (const [i, b] of blocks.entries()) {
    new vm.Script(b[1], { filename: `/settings#script-${i}` }); // throws on SyntaxError
  }
  console.log(`/settings: ${blocks.length} inline script block(s) compile`);
}

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
  assert.match(String(s.uiVersion), /^[0-9a-f]{12}$/, "status carries the page fingerprint");
  console.log(`/api/status: ${s.services.map((x: any) => `${x.name}=${x.up === null ? "n/a" : x.up}`).join(" ")}`);
}

const settingsHtml = await (await fetch(`http://127.0.0.1:${port}/settings`)).text();
assert.match(settingsHtml, /id="service-dots"/, "settings page renders the service-dots host");
assert.match(settingsHtml, /id="follow-chk"/, "settings follow toggle present");
assert.match(settingsHtml, /id="secrets-list"/, "app secrets card present");
assert.match(settingsHtml, /loadSecrets\(\);/, "app secrets load on page open");
assert.match(settingsHtml, /id="model-slots"/, "model editor host present");
assert.match(settingsHtml, /function addModelSlot\(\)/, "add-model button wired");
assert.match(settingsHtml, /function saveModels\(\)/, "model save wired");
assert.match(settingsHtml, /\$\{ENV_VAR\}/, "literal env interpolation hint survives into the page");
assert.match(settingsHtml, /"neuralwatt"/, "Neuralwatt provider preset present");
assert.match(settingsHtml, /function checkUiVersion\(v\)/, "settings reloads itself when the page fingerprint changes");

server.close();
console.log("page-scripts-test: all assertions passed");
