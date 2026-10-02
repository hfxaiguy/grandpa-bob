/**
 * Admin tree-version API — routes in src/admin.ts.
 *
 *   GET  /api/tree/versions?name=   list versions, prod, draft, active ref
 *   POST /api/tree/versions         snapshot the draft
 *   POST /api/tree/version/active   set the ref for NEW sessions (no clear)
 *   POST /api/tree/version/promote  promote a snapshot to production
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

  // Snapshot creates v1 and reports `created`.
  r = await api("POST", "/api/tree/versions", { name: "trunk" });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, "v1");
  assert.equal(r.json.created, true);

  r = await api("GET", "/api/tree/versions?name=trunk");
  assert.deepEqual(r.json.versions, ["v1"]);
  assert.deepEqual(r.json.specs, ["v1"], "the snapshot captured the paired spec");
  assert.equal(r.json.draftSpec, true);

  // The spec of a specific resolved version is readable.
  r = await api("GET", "/api/tree/spec?pattern=trunk@v1");
  assert.equal(r.status, 200);
  assert.equal(r.json.spec, "# trunk spec\n");
  assert.equal(r.json.specFile, "patterns/trunk.v1.spec.md");

  // Set the active ref for new sessions; /api/pattern reflects it.
  r = await api("POST", "/api/tree/version/active", { name: "trunk", ref: "v1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ref, "v1");
  r = await api("GET", "/api/pattern");
  assert.equal(r.json.ref, "v1");

  // Promote v1 → prod; the version list still shows v1, now as prod.
  r = await api("POST", "/api/tree/version/promote", { name: "trunk", version: "v1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.promoted, "v1");
  r = await api("GET", "/api/tree/versions?name=trunk");
  assert.equal(r.json.prod, "v1");
  assert.deepEqual(r.json.versions, ["v1"]);
  assert.deepEqual(r.json.specs, ["v1"], "promote carried the spec to prod");

  // Default (prod) resolution finds the promoted version's spec.
  r = await api("GET", "/api/tree/spec?pattern=trunk");
  assert.equal(r.status, 200);
  assert.equal(r.json.spec, "# trunk spec\n");

  // Unknown tree → 404-ish empty list, not a crash.
  r = await api("GET", "/api/tree/versions?name=nope");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.versions, []);
  assert.equal(r.json.draft, false);

  // Snapshot with no draft is a 400 with a message.
  r = await api("POST", "/api/tree/versions", { name: "nope" });
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /no draft/);

  console.log("tree-versions-api-test: all assertions passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(ws, { recursive: true, force: true });
}
