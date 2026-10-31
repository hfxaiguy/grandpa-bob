// Desktop-bridge e2e: the storage bridge serves one folder per profile,
// selected per request, and a workspace archive (a seed) imports into the
// selected folder — never into another root. Desktop profiles are now OPFS
// workspaces with a synced mirror folder, so the registry still carries the
// binding (kind + folder) while `web/src/mirror.ts` does the sync.
//
// Spawns the real bridge (`web/scripts/storage-server.mjs`), registers a
// second folder root, then uses `createDesktopPlatform(..., { rootName })`
// exactly as desktop-only operations do.
//
// Run: `npm run test:desktop-profile`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createDesktopPlatform } from "../web/src/platform/desktop.js";
import { importPlatformArchive, type WorkspaceArchive } from "../web/src/workspace-transfer.js";
import { parseProfileRegistry } from "../web/src/profiles.js";

const repo = path.resolve(import.meta.dirname, "..");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

const stateDir = await mkdtemp(path.join(os.tmpdir(), "bob-desktop-state-"));
const defaultRoot = await mkdtemp(path.join(os.tmpdir(), "bob-desktop-default-"));
const travelRoot = await mkdtemp(path.join(os.tmpdir(), "bob-desktop-travel-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const bridge = spawn(process.execPath, [path.join(repo, "web/scripts/storage-server.mjs"), defaultRoot], {
  env: { ...process.env, STORAGE_PORT: String(port), BOB_STATE_DIR: stateDir },
  stdio: "ignore",
});

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("storage bridge never became healthy");
}

const post = async (route: string, body: unknown, root?: string): Promise<Response> =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(root ? { "x-bob-root": root } : {}),
    },
    body: JSON.stringify(body),
  });

try {
  await waitHealthy();

  // ── register the second folder root (the picker's POST /roots) ───────
  const add = await post("/roots", { name: "travel", dir: travelRoot });
  assert.equal(add.ok, true, "the bridge registers a named folder root");
  const list = (await (await fetch(`${base}/roots`)).json()) as {
    roots: Array<{ name: string; dir: string }>;
  };
  assert.deepEqual(list.roots.map((r) => r.name), ["travel"]);

  // ── import a workspace archive through the desktop platform ──────────
  const archive: WorkspaceArchive = {
    version: 1,
    createdAt: new Date().toISOString(),
    files: [
      { path: "workspace/patterns/trunk.mjs", base64: Buffer.from("export default { trunk: true };").toString("base64") },
      { path: "workspace/app/notes/README.md", base64: Buffer.from("# notes").toString("base64") },
    ],
  };
  const travel = createDesktopPlatform("/", base, { rootName: "travel" });
  const written = await importPlatformArchive(travel, archive);
  assert.equal(written, 2, "both seed files import");

  const onDisk = await readFile(path.join(travelRoot, "patterns/trunk.mjs"), "utf8");
  assert.match(onDisk, /trunk: true/, "the seed lands in the registered folder");
  assert.equal(
    await readFile(path.join(travelRoot, "app/notes/README.md"), "utf8"),
    "# notes",
    "nested paths survive the import",
  );

  // ── the default root must not see the profile's files ────────────────
  assert.equal(
    await readFile(path.join(defaultRoot, "patterns/trunk.mjs"), "utf8").then(() => true, () => false),
    false,
    "the default workspace root stays untouched",
  );
  const leaked = await post("/fs/read", { path: "patterns/trunk.mjs" }); // no x-bob-root
  assert.equal(leaked.ok, false, "a request without the root header cannot read the profile's files");

  // ── per-root sandboxing: travel cannot escape its own folder ─────────
  const escape = await post("/fs/read", { path: "../../etc/passwd" }, "travel");
  assert.equal(escape.ok, false, "paths cannot escape the selected root");
  const traversal = await post("/fs/write", { path: "../outside.txt", content: "nope" }, "travel");
  assert.equal(traversal.ok, false, "writes cannot escape the selected root");

  // ── unknown roots are refused ────────────────────────────────────────
  const unknown = await post("/fs/list", { path: "." }, "missing");
  assert.equal(unknown.ok, false, "an unregistered root name is refused");

  // ── the registry record (pure layer) parses the mirror binding ────────
  const registry = parseProfileRegistry({
    version: 1,
    profiles: [
      { name: "default", createdAt: "2026-01-01T00:00:00.000Z" },
      { name: "travel", createdAt: "2026-01-02T00:00:00.000Z", kind: "desktop", folder: "travel" },
    ],
  });
  assert.deepEqual(
    registry.profiles.map((p) => [p.name, p.kind ?? "opfs", p.folder]),
    [
      ["default", "opfs", undefined],
      ["travel", "desktop", "travel"],
    ],
    "desktop records carry kind + folder; old records stay opfs",
  );

  // ── stale registry entries: a desktop record without a folder is invalid
  assert.throws(
    () =>
      parseProfileRegistry({
        version: 1,
        profiles: [{ name: "broken", createdAt: "2026-01-01T00:00:00.000Z", kind: "desktop" }],
      }),
    /needs a valid folder/,
    "a desktop profile without a folder is rejected",
  );

  console.log("desktop-profile: bridge roots, seed import, sandboxing and registry OK");
} finally {
  try { bridge.kill("SIGKILL"); } catch { /* already gone */ }
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  await rm(defaultRoot, { recursive: true, force: true }).catch(() => {});
  await rm(travelRoot, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
