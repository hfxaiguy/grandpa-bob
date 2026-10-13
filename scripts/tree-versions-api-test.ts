/**
 * Admin tree-version API — routes in src/admin.ts.
 *
 *   GET  /api/tree/versions?name=   list legacy versions, prod, draft, active ref
 *   POST /api/tree/version/active   set the ref for NEW sessions (no clear)
 *   POST /api/tree/version/promote  promote the draft to production (copy → .prod)
 *
 * Mock agent, no network. Run: npm run test:tree-api
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-tree-api-"));
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
await fs.writeFile(
  path.join(ws, "patterns", "trunk.mjs"),
  `// trunk.mjs — test tree\nexport default { kind: "tree", name: "trunk", children: [] };\n`,
);
await fs.writeFile(path.join(ws, "patterns", "trunk.spec.md"), "# trunk spec\n");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const mockAgent = {
  sessionKeys: () => [],
  hasContinuation: () => false,
  sessionRef: () => undefined,
  pinnedVersions: () => [],
  clear() {},
} as any;

const mod = await import("../src/admin.ts");
const port = await freePort();
const server = mod.startAdmin({ port, workspaceDir: ws, agent: mockAgent });
await events.once(server, "listening");

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
};

try {
  // Empty version list, draft present, active ref defaults to prod.
  let r = await api("GET", "/api/tree/versions?name=trunk");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.versions, []);
  assert.equal(r.json.draft, true);
  assert.equal(r.json.prod, null);
  assert.equal(r.json.active, "");

  // Promote the draft → the bare `.prod` tree (the spec stays single).
  r = await api("POST", "/api/tree/version/promote", { name: "trunk" });
  assert.equal(r.status, 200);
  assert.equal(r.json.file, "patterns/trunk.prod.mjs");
  assert.ok(await fs.stat(path.join(ws, "patterns", "trunk.prod.mjs")));
  assert.equal(
    await fs.stat(path.join(ws, "patterns", "trunk.prod.spec.md")).catch(() => null),
    null,
    "no .prod.spec.md — one spec per tree",
  );

  r = await api("GET", "/api/tree/versions?name=trunk");
  assert.equal(r.json.prod, "prod", "a bare .prod reports as 'prod'");
  assert.equal(r.json.draft, true);

  // The single spec is readable through the default (prod) resolution.
  r = await api("GET", "/api/tree/spec?pattern=trunk");
  assert.equal(r.status, 200);
  assert.equal(r.json.spec, "# trunk spec\n");
  assert.equal(r.json.specFile, "patterns/trunk.spec.md");

  // Set the active ref for new sessions; /api/pattern reflects it.
  r = await api("POST", "/api/tree/version/active", { name: "trunk", ref: "draft" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ref, "draft");
  r = await api("GET", "/api/pattern");
  assert.equal(r.json.ref, "draft");

  // A promote broadcasts a "trees" SSE event so open pages refresh.
  {
    const ac = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const seen = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (buf.includes('"type":"trees"')) return true;
        }
      } catch { /* aborted */ }
      return false;
    })();
    await api("POST", "/api/tree/version/promote", { name: "trunk" });
    const got = await Promise.race([
      seen,
      new Promise((r) => setTimeout(() => r(false), 2000)),
    ]);
    assert.equal(got, true, "promote broadcasts trees");
    ac.abort();
  }

  // Unknown tree → empty list, not a crash.
  r = await api("GET", "/api/tree/versions?name=nope");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.versions, []);
  assert.equal(r.json.draft, false);

  // Promote with no draft is a 400 with a message.
  r = await api("POST", "/api/tree/version/promote", { name: "nope" });
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /no draft/);

  console.log("tree-versions-api-test: all assertions passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(ws, { recursive: true, force: true });
}
