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

const server = startAdmin({ port, workspaceDir: ws });
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

server.close();
console.log("page-scripts-test: all assertions passed");
