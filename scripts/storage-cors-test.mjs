/**
 * Storage bridge CORS: only loopback origins may use it, and a foreign origin
 * is refused before any route runs (no drive-by writes from a random site).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startStorageBridge } from "../web/scripts/storage-server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bob-cors-"));
const { server } = await startStorageBridge({ root, port: 0 });
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

try {
  // Allowed loopback origin: echoed, not "*".
  const allowed = await fetch(`${base}/health`, { headers: { origin: "http://localhost:8080" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:8080");
  assert.equal(allowed.headers.get("vary"), "Origin");

  // Preflight from an allowed origin.
  const preflight = await fetch(`${base}/fs/write`, {
    method: "OPTIONS",
    headers: { origin: "http://127.0.0.1:8080", "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:8080");

  // Foreign origin: refused before the route runs, and nothing is written.
  const evil = await fetch(`${base}/fs/write`, {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ path: "owned.txt", content: "x" }),
  });
  assert.equal(evil.status, 403);
  await assert.rejects(fs.stat(path.join(root, "owned.txt")));

  // A loopback origin can still write.
  const write = await fetch(`${base}/fs/write`, {
    method: "POST",
    headers: { origin: "http://localhost:8080", "content-type": "application/json" },
    body: JSON.stringify({ path: "ok.txt", content: "hi" }),
  });
  assert.equal(write.status, 200);
  assert.equal(await fs.readFile(path.join(root, "ok.txt"), "utf8"), "hi");

  // No Origin (curl/CLI/tests): allowed, no CORS headers.
  const bare = await fetch(`${base}/health`);
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get("access-control-allow-origin"), null);

  console.log("storage-cors: ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
