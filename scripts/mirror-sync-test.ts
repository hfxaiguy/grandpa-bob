// Desktop-mirror e2e: the bridge reconciles a browser manifest with a real
// folder, preserving OPFS as canonical on divergent files.
//
// Run: `npm run test:mirror`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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

const stateDir = await mkdtemp(path.join(os.tmpdir(), "bob-mirror-state-"));
const defaultRoot = await mkdtemp(path.join(os.tmpdir(), "bob-mirror-default-"));
const mirrorRoot = await mkdtemp(path.join(os.tmpdir(), "bob-mirror-folder-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const bridge = spawn(process.execPath, [path.join(repo, "web/scripts/storage-server.mjs"), defaultRoot], {
  env: { ...process.env, STORAGE_PORT: String(port), BOB_STATE_DIR: stateDir },
  stdio: "ignore",
});

const post = async (route: string, body: unknown, root?: string): Promise<any> =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(root ? { "x-bob-root": root } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (res) => {
    const json = (await res.json()) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  });

/** The browser portfolio hash: sha256 over the file's base64 text. */
function hashOf(content: string | Buffer): string {
  return createHash("sha256").update(Buffer.from(content).toString("base64")).digest("hex");
}
function entry(content: string): { hash: string; bytes: number } {
  return { hash: hashOf(content), bytes: Buffer.byteLength(content) };
}
const exists = (p: string): Promise<boolean> => readFile(p).then(() => true, () => false);

try {
  // Wait for the bridge.
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error("storage bridge never became healthy");
    await sleep(100);
  }

  await post("/roots", { name: "travel", dir: mirrorRoot });

  // ── first sync: mirror-only files pull, divergent files keep OPFS ─────
  await writeFile(path.join(mirrorRoot, "desktop-only.md"), "from desktop");
  await writeFile(path.join(mirrorRoot, "shared.txt"), "desktop version");
  const mine = {
    "browser-only.txt": entry("from browser"),
    "shared.txt": entry("opfs version"),
  };
  const first = await post("/mirror/plan", { manifest: mine }, "travel");
  assert.deepEqual(first.plan.pull.map((p: { path: string }) => p.path), ["desktop-only.md"]);
  assert.deepEqual(first.plan.push.sort(), ["browser-only.txt", "shared.txt"]);
  assert.deepEqual(first.plan.conflicts, ["shared.txt"], "first-sync divergence is a conflict");

  const merged = {
    ...mine,
    "desktop-only.md": { hash: hashOf("from desktop"), bytes: Buffer.byteLength("from desktop") },
  };
  const applied = await post(
    "/mirror/apply",
    {
      writes: [
        { path: "browser-only.txt", base64: Buffer.from("from browser").toString("base64") },
        { path: "shared.txt", base64: Buffer.from("opfs version").toString("base64") },
      ],
      deletes: [],
      conflicts: first.plan.conflicts,
      manifest: merged,
    },
    "travel",
  );
  assert.equal(applied.written, 2);
  assert.equal(await readFile(path.join(mirrorRoot, "shared.txt"), "utf8"), "opfs version", "OPFS wins the conflict");
  assert.equal(await readFile(path.join(mirrorRoot, "desktop-only.md"), "utf8"), "from desktop");
  const conflictCopies = (await readdir(mirrorRoot)).filter((n) => n.startsWith("shared.txt.conflict-"));
  assert.equal(conflictCopies.length, 1, "the desktop variant is preserved as a conflict copy");
  assert.equal(await readFile(path.join(mirrorRoot, conflictCopies[0]), "utf8"), "desktop version");

  // ── converged: an immediate plan is empty ─────────────────────────────
  const second = await post("/mirror/plan", { manifest: merged }, "travel");
  assert.deepEqual(second.plan, {
    pull: [],
    pullDeletes: [],
    push: [],
    pushDeletes: [],
    conflicts: [],
  });

  // ── desktop-side edits pull and browser edits push ────────────────────
  await writeFile(path.join(mirrorRoot, "desktop-only.md"), "edited on desktop");
  await writeFile(path.join(mirrorRoot, "desktop-new.md"), "new on desktop");
  const browserChanged = { ...merged, "browser-only.txt": entry("edited in browser") };
  const third = await post("/mirror/plan", { manifest: browserChanged }, "travel");
  assert.deepEqual(third.plan.pull.map((p: { path: string }) => p.path).sort(), [
    "desktop-new.md",
    "desktop-only.md",
  ]);
  assert.deepEqual(third.plan.push, ["browser-only.txt"]);
  assert.deepEqual(third.plan.conflicts, []);
  const afterThird = {
    ...browserChanged,
    "desktop-only.md": entry("edited on desktop"),
    "desktop-new.md": entry("new on desktop"),
  };
  await post(
    "/mirror/apply",
    {
      writes: [{ path: "browser-only.txt", base64: Buffer.from("edited in browser").toString("base64") }],
      deletes: [],
      conflicts: [],
      manifest: afterThird,
    },
    "travel",
  );
  assert.equal(await readFile(path.join(mirrorRoot, "browser-only.txt"), "utf8"), "edited in browser");

  // ── desktop deletion pulls as a delete (not a resurrection) ───────────
  await rm(path.join(mirrorRoot, "desktop-new.md"));
  const fourth = await post("/mirror/plan", { manifest: afterThird }, "travel");
  assert.deepEqual(fourth.plan.pullDeletes, ["desktop-new.md"]);
  const afterFourth = { ...afterThird };
  delete (afterFourth as Record<string, unknown>)["desktop-new.md"];
  await post(
    "/mirror/apply",
    {
      writes: [],
      deletes: [],
      conflicts: [],
      manifest: afterFourth,
    },
    "travel",
  );
  assert.equal(await exists(path.join(mirrorRoot, "desktop-new.md")), false, "the delete stands");

  // ── exclusions never mirror ───────────────────────────────────────────
  await mkdir(path.join(mirrorRoot, ".git"), { recursive: true });
  await writeFile(path.join(mirrorRoot, ".git/config"), "[core]");
  await mkdir(path.join(mirrorRoot, "logs"), { recursive: true });
  await writeFile(path.join(mirrorRoot, "logs/grandma-kat.db"), "not a dir");
  const fifth = await post(
    "/mirror/plan",
    { manifest: { "shared.txt": entry("opfs version"), "desktop-only.md": entry("edited on desktop"), "browser-only.txt": entry("edited in browser") } },
    "travel",
  );
  assert.deepEqual(fifth.plan.pull, [], ".git and logs are excluded");
  assert.deepEqual(fifth.plan.push, []);
  assert.deepEqual(fifth.plan.pullDeletes, []);

  console.log("mirror: plan/apply, conflicts, deletes and exclusions OK");
} finally {
  try { bridge.kill("SIGKILL"); } catch { /* already gone */ }
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  await rm(defaultRoot, { recursive: true, force: true }).catch(() => {});
  await rm(mirrorRoot, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
