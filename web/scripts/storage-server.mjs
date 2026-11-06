// Standalone storage bridge (debug/tests) for the browser target.
//
//   node scripts/storage-server.mjs [workspaceRoot]
//
// Exposes real folders (files + git + SQLite) over loopback HTTP with CORS:
//   - named folder roots via POST /roots, selected with `x-bob-root`
//   - /fs, /git, /sql for callers that need a real path (tests, scripts)
//
// The product path does NOT use these routes: the browser's workspace lives in
// OPFS and a paired desktop/server peer carries mirror + ops over the
// authenticated DTLS channel (`npm run bob`). This server is kept for debugging,
// the standalone CLI and the desktop-profile test; loopback-only, no auth.
// Speech-to-text lives in `src/stt.ts` and is reached over the peer channel
// (`stt-run`) — this bridge has no STT route.
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

// The default root can be replaced by the combined entry (`npm run bob`) or
// by the standalone CLI (`node storage-server.mjs [root]`).
let ROOT = path.resolve(process.env.WORKSPACE_DIR ?? process.cwd());

// Desktop profiles: named folder roots served by this one bridge. The
// registry lives outside any workspace (~/.bobkat/channels.json); the
// bridge's own ROOT is always reachable as "default" (the pre-profiles
// desktop setup migrates to it by simply staying put). A request selects its
// root with the `x-bob-root` header; without one it lands on "default".
// Keep in sync with src/state-dir.ts / web/src/state-dir.ts (this plain-node
// file cannot import the TypeScript helper).
const CHANNELS_FILE = path.join(
  process.env.BOB_STATE_DIR ?? path.join(os.homedir(), ".bobkat"),
  "channels.json",
);
let rootsRegistry = { roots: [] };
try {
  const raw = JSON.parse(await fs.readFile(CHANNELS_FILE, "utf8"));
  if (raw && typeof raw === "object" && Array.isArray(raw.roots)) rootsRegistry = raw;
} catch {
  /* first boot: only the default root exists */
}

async function saveRoots() {
  await fs.mkdir(path.dirname(CHANNELS_FILE), { recursive: true });
  const tmp = `${CHANNELS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rootsRegistry, null, 2) + "\n");
  await fs.rename(tmp, CHANNELS_FILE);
}

const NAME_RE = /^[a-z0-9._-]{1,64}$/;

function rootFor(name) {
  if (!name || name === "default") return ROOT;
  const hit = rootsRegistry.roots.find((r) => r.name === name);
  if (!hit) throw new Error(`unknown folder root: ${name} (register it with POST /roots)`);
  return hit.dir;
}

function activeRoot(req) {
  const name = String(req.headers["x-bob-root"] ?? "").trim();
  return rootFor(name || "default");
}

/** Only the app's own loopback origins may use this bridge. Requests without
 *  an Origin header (curl, CLI, tests) are allowed but get no CORS headers. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function corsFor(req) {
  const origin = String(req.headers.origin ?? "");
  if (!origin || !LOCAL_ORIGIN.test(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type, x-bob-root",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
}

function resolveIn(root, rel) {
  // Treat incoming paths as workspace-relative even when they start with "/".
  const rel2 = String(rel ?? ".").replace(/^\/+/, "") || ".";
  const abs = path.resolve(root, rel2);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
  return abs;
}

function openDb(root, p, opts) {
  const db = new DatabaseSync(resolveIn(root, p), opts);
  // The admin process may hold its own connection to the KAT log; wait for a
  // short write lock instead of failing a turn marker with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

const routes = {
  async "GET /health"() {
    return { ok: true, root: ROOT, roots: ["/default", ...rootsRegistry.roots.map((r) => `/${r.name}`)] };
  },
  async "GET /roots"() {
    return { default: ROOT, roots: rootsRegistry.roots };
  },
  async "POST /roots"({ name, dir }) {
    if (!NAME_RE.test(String(name ?? ""))) throw new Error("root names use lowercase letters, digits, dot, dash or underscore");
    if (!dir || !path.isAbsolute(String(dir).replace(/^~\//, "/"))) {
      throw new Error("dir must be an absolute path (a leading ~/ expands against this machine's home)");
    }
    const clean = path.resolve(String(dir).replace(/^~\//, `${os.homedir()}/`));
    await fs.mkdir(clean, { recursive: true });
    const existing = rootsRegistry.roots.find((r) => r.name === name);
    if (existing) {
      if (existing.dir !== clean) throw new Error(`root ${name} already points at ${existing.dir}`);
      return { ok: true };
    }
    rootsRegistry.roots.push({ name, dir: clean });
    await saveRoots();
    return { ok: true };
  },
  async "POST /fs/list"({ path: p }, _q, root) {
    const entries = await fs.readdir(resolveIn(root, p), { withFileTypes: true });
    return { entries: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })) };
  },
  async "POST /fs/read"({ path: p }, _q, root) {
    return { content: await fs.readFile(resolveIn(root, p), "utf8") };
  },
  async "POST /fs/readBytes"({ path: p }, _q, root) {
    return { base64: (await fs.readFile(resolveIn(root, p))).toString("base64") };
  },
  async "POST /fs/write"({ path: p, content, base64 }, _q, root) {
    const abs = resolveIn(root, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (base64 !== undefined) await fs.writeFile(abs, Buffer.from(base64, "base64"));
    else await fs.writeFile(abs, content ?? "", "utf8");
    return { ok: true };
  },
  async "POST /fs/mkdir"({ path: p }, _q, root) {
    await fs.mkdir(resolveIn(root, p), { recursive: true });
    return { ok: true };
  },
  async "POST /fs/stat"({ path: p }, _q, root) {
    const st = await fs.stat(resolveIn(root, p)).catch(() => null);
    if (!st) throw new Error(`not found: ${p}`);
    return { isFile: st.isFile(), isDirectory: st.isDirectory() };
  },
  async "POST /fs/rm"({ path: p }, _q, root) {
    await fs.rm(resolveIn(root, p), { recursive: true, force: true });
    return { ok: true };
  },
  async "POST /fs/rename"({ from, to }, _q, root) {
    const abs = resolveIn(root, to);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.rename(resolveIn(root, from), abs);
    return { ok: true };
  },
  async "POST /fs/copy"({ from, to }, _q, root) {
    // Byte-for-byte copy on the host (fs.copyFile), never a text round-trip.
    const abs = resolveIn(root, to);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.copyFile(resolveIn(root, from), abs);
    return { ok: true };
  },
  async "POST /git"({ op, paths = [], message, remote, url: remoteUrl, branch }, _q, root) {
    if (op === "status") {
      const status = await git(root, ["status", "--porcelain"]);
      const branchName = await git(root, ["branch", "--show-current"]);
      return {
        branch: branchName.stdout || null,
        changes: status.stdout ? status.stdout.split("\n") : [],
      };
    }
    if (op === "log") {
      const log = await git(root, ["log", "--oneline", "-5"]).catch(() => ({ stdout: "" }));
      return { log: log.stdout };
    }
    if (op === "init") {
      await git(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => git(root, ["init", "-b", "main"]));
      return { ok: true };
    }
    if (op === "commit") {
      await git(root, ["add", "-A", "--", ...(paths.length ? paths : ["."])]);
      await git(root, ["-c", "user.name=BOB", "-c", "user.email=bob@desktop", "commit", "-q", "-m", message ?? "agent commit"]).catch(
        (e) => {
          if (!/nothing to commit/.test(String(e.stdout) + String(e.stderr))) throw e;
        },
      );
      return { commit: (await git(root, ["rev-parse", "--short", "HEAD"])).stdout };
    }
    if (op === "fetch" || op === "pull" || op === "push") {
      const target = remoteUrl || remote;
      if (!target) throw new Error("no git remote");
      const ref = branch ? `HEAD:refs/heads/${branch}` : "HEAD";
      const args =
        op === "push" ? ["push", target, ref] : op === "fetch" ? ["fetch", target] : ["pull", target];
      return { result: (await git(root, args)).stdout || `${op} ok` };
    }
    throw new Error(`unknown git op: ${op}`);
  },
  async "POST /sql/columns"({ path: p, sql }, _q, root) {
    const db = openDb(root, p, { readOnly: true });
    try {
      return { columns: db.prepare(sql).columns().map((c) => ({ name: c.name ?? "" })) };
    } finally {
      db.close();
    }
  },
  async "POST /sql/all"({ path: p, sql, params = [] }, _q, root) {
    const db = openDb(root, p, { readOnly: true });
    try {
      return { rows: db.prepare(sql).all(...params) };
    } finally {
      db.close();
    }
  },
  async "POST /sql/get"({ path: p, sql, params = [] }, _q, root) {
    const db = openDb(root, p, { readOnly: true });
    try {
      return { row: db.prepare(sql).get(...params) ?? null };
    } finally {
      db.close();
    }
  },
  async "POST /sql/run"({ path: p, sql, params = [] }, _q, root) {
    const db = openDb(root, p);
    try {
      const info = db.prepare(sql).run(...params);
      return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid ?? 0) };
    } finally {
      db.close();
    }
  },
  async "POST /sql/exec"({ path: p, sql }, _q, root) {
    const db = openDb(root, p);
    try {
      db.exec(sql);
      return { ok: true };
    } finally {
      db.close();
    }
  },
};

/** The bridge request handler; mountable on the combined channel server. */
export function handleStorageRequest(req, res) {
  const origin = String(req.headers.origin ?? "");
  // A foreign browser origin is refused outright: loopback CORS must not let a
  // random website drive-by writes on the debug bridge.
  if (origin && !LOCAL_ORIGIN.test(origin)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "origin not allowed" }));
    return;
  }
  const cors = corsFor(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const [pathname, query = ""] = (req.url ?? "/").split("?");
  const send = (status, body) => {
    res.writeHead(status, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) {
      send(404, { error: `no route ${req.method} ${pathname}` });
      return;
    }
    try {
      const body = data ? JSON.parse(data) : {};
      const root = activeRoot(req);
      const rootName = String(req.headers["x-bob-root"] ?? "").trim() || "default";
      send(200, await handler(body, new URLSearchParams(query), root, rootName));
    } catch (err) {
      send(400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Point the bridge at a workspace root (the "default" x-bob-root folder). */
export function configureStorageBridge(root = process.env.WORKSPACE_DIR ?? process.cwd()) {
  ROOT = path.resolve(root);
  return ROOT;
}

/** The bridge as a plain http.Server (no listen), for the combined entry. */
export function createStorageBridgeServer() {
  return http.createServer(handleStorageRequest);
}

/** Start the bridge standalone. Resolves once listening; rejects on EADDRINUSE. */
export function startStorageBridge({
  root = process.env.WORKSPACE_DIR ?? process.cwd(),
  port = Number(process.env.STORAGE_PORT ?? 8795),
  host = "127.0.0.1",
} = {}) {
  configureStorageBridge(root);
  return new Promise((resolve, reject) => {
    const server = createStorageBridgeServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({ server, root: ROOT, port, host });
    });
  });
}

// ── CLI: `npm run storage-server` (standalone bridge, for debugging) ─────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startStorageBridge({ root: process.argv[2] ?? process.env.WORKSPACE_DIR ?? process.cwd() })
    .then(({ port, root }) => console.log(`storage bridge on http://127.0.0.1:${port}  root=${root}`))
    .catch((err) => {
      if (err?.code === "EADDRINUSE") {
        console.error(`storage bridge: port ${process.env.STORAGE_PORT ?? 8795} is already in use.`);
        process.exit(1);
      }
      throw err;
    });
}
