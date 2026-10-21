/**
 * A stopped turn must unwind promptly even while a model request is in flight,
 * and the previous checkpoint must remain resumable.
 *
 * Run: npm run test:stop
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import { AgentStoppedError, isAgentStopped } from "../src/stop-error.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-stop-"));
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
await fs.mkdir(path.join(ws, "node_modules"), { recursive: true });
await fs.symlink(
  path.resolve("node_modules/grandma-kat"),
  path.join(ws, "node_modules", "grandma-kat"),
  "dir",
);
await fs.writeFile(
  path.join(ws, "patterns", "trunk.prod.mjs"),
  `import { Tree, name, Model, Human, Prompt, Emit } from "grandma-kat";
export default Tree(
  name("trunk"),
  Model("strong"),
  Human("input"),
  Prompt("answer", (m) => [{ role: "user", content: String(m.input) }]),
  Emit((m) => m.branch.answer),
);
`,
);

// A model endpoint that accepts the request but never answers within the test.
const server = createServer((req, res) => {
  if (req.url !== "/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }
  req.resume();
  req.on("end", () => {
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "too late" } }] }));
    }, 10_000).unref();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

const tools = new ToolRegistry(ws, []);
const agent = new Agent({
  models: {
    strong: { baseURL: `http://127.0.0.1:${port}`, model: "mock", apiKey: "no-key" },
  },
  workspace: ws,
  tools,
});

try {
  const first = await agent.run("stop-test", "", () => {});
  assert.equal(first.status, "waiting", "the test tree pauses at its input");

  const stop = new AbortController();
  const started = Date.now();
  const running = agent.run("stop-test", "hello", () => {}, { signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(running, (err) => {
    assert.ok(isAgentStopped(err), `expected AgentStoppedError, got ${err}`);
    assert.ok(err instanceof AgentStoppedError);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `stop took ${elapsed}ms (model request was not aborted)`);
  assert.equal(agent.hasContinuation("stop-test"), true, "the previous checkpoint survives a stop");

  console.log(`stop-test: aborted in ${elapsed}ms; checkpoint preserved`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(ws, { recursive: true, force: true });
}
