// Local storage bridge for the browser target.
//
//   node scripts/storage-server.mjs [workspaceRoot]
//
// Exposes real folders (files + git + SQLite) over loopback HTTP with CORS:
//   - desktop mirror folders: the tab's OPFS workspace stays canonical and is
//     synced to a registered folder through /mirror/* (desktop-only operations
//     then run against that real folder)
//   - the bridge also serves any registered folder root through /fs, /git and
//     /sql for callers that need a real path (tests, scripts, ops)
// Sandboxed to the selected root. Loopback-only; add auth before exposing it.
//
// Opt-in STT pass-through: start with BOB_STT=1 (WHISPER_URL, default
// http://127.0.0.1:8178) to expose POST /stt — raw audio bytes in, transcript
// out. The tab can then use the desktop's whisper instead of downloading an
// in-tab model; voice notes parked by the Telegram channel are transcribed
// there directly, not through this route.
import http from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { diffMirror, mirrorExcluded, parseManifest } from "./mirror-lib.mjs";

const execFileAsync = promisify(execFile);
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

// ── desktop mirror ──────────────────────────────────────────────────────
// The browser's OPFS workspace is canonical; a bound folder on this machine
// is a synced copy (and the surface desktop-only ops run against). The last
// synced manifest per root lives outside the folder so a mirror never
// contains bookkeeping of its own.
const MIRROR_STATE_DIR = path.join(path.dirname(CHANNELS_FILE), "mirrors");

async function readMirrorBase(name) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(MIRROR_STATE_DIR, `${name}.json`), "utf8"));
    return parseManifest(raw.files ?? {});
  } catch {
    return {};
  }
}

/** Whether this root has ever completed a sync (its base manifest exists). */
async function mirrorBaseExists(name) {
  return fs
    .access(path.join(MIRROR_STATE_DIR, `${name}.json`))
    .then(() => true, () => false);
}

async function saveMirrorBase(name, files) {
  await fs.mkdir(MIRROR_STATE_DIR, { recursive: true });
  const target = path.join(MIRROR_STATE_DIR, `${name}.json`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), files }, null, 2));
  await fs.rename(tmp, target);
}

/** sha256 of the base64 text — the same hash the browser's sync hashmap uses. */
function mirrorHash(bytes) {
  return createHash("sha256").update(bytes.toString("base64")).digest("hex");
}

/** Walk a mirror folder into `{ path: { hash, bytes } }`. */
async function walkMirror(dir, prefix = "", out = {}) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (mirrorExcluded(rel)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMirror(abs, rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await fs.readFile(abs).catch(() => null);
    if (!bytes) continue;
    out[rel] = { hash: mirrorHash(bytes), bytes: bytes.length };
  }
  return out;
}

/** A locally preserved loser next to the file (`name.ext.conflict-<stamp>`). */
function mirrorConflictPath(abs) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${abs}.conflict-${stamp}`;
}
/** STT pass-through: off unless explicitly enabled. */
const STT_ENABLED = process.env.BOB_STT === "1";
const WHISPER_URL = (process.env.WHISPER_URL ?? "http://127.0.0.1:8178").replace(/\/$/, "");

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-bob-root",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function resolveIn(root, rel) {
  // Treat incoming paths as workspace-relative even when they start with "/".
  const rel2 = String(rel ?? ".").replace(/^\/+/, "") || ".";
  const abs = path.resolve(root, rel2);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
  return abs;
}

async function git(root, args) {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ── STT pass-through (BOB_STT=1) ─────────────────────────────────────────

/** POST raw audio bytes to the whisper-server; returns its `text`. */
async function whisperInference(wavPath, language) {
  const fields = [
    ["response_format", "json"],
    ["temperature", "0"],
  ];
  if (language && language !== "auto") fields.push(["language", language]);
  const boundary = `bob-stt-${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  const wav = await fs.readFile(wavPath);
  parts.push(
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="audio.wav"\r\ncontent-type: audio/wav\r\n\r\n`,
    ),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const body = Buffer.concat(parts);
  const res = await fetch(`${WHISPER_URL}/inference`, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  });
  if (!res.ok) throw new Error(`whisper-server ${res.status}`);
  const data = await res.json();
  return String(data.text ?? "").trim();
}

/** POST /stt: raw audio body → ffmpeg → 16 kHz WAV → whisper-server. */
async function handleStt(req, res, send, query) {
  if (!STT_ENABLED) {
    send(501, { error: "stt not enabled — start the bridge with BOB_STT=1" });
    return;
  }
  const ext = (query.get("ext") ?? ".webm").replace(/[^.a-z0-9]/gi, "").slice(0, 8) || ".webm";
  const language = query.get("language") ?? "";
  const tmpIn = path.join(os.tmpdir(), `bob-stt-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  const tmpOut = tmpIn.replace(/\.[^.]+$/, ".wav");
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await fs.writeFile(tmpIn, Buffer.concat(chunks));
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", tmpIn,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      tmpOut,
    ]);
    const text = await whisperInference(tmpOut, language);
    send(200, { text });
  } finally {
    await fs.rm(tmpIn, { force: true }).catch(() => {});
    await fs.rm(tmpOut, { force: true }).catch(() => {});
  }
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
  async "POST /mirror/plan"({ manifest }, _q, root, rootName) {
    const mine = parseManifest(manifest);
    const base = await readMirrorBase(rootName);
    const initial = !(await mirrorBaseExists(rootName));
    const theirs = await walkMirror(root);
    const plan = diffMirror(base, mine, theirs);
    const pull = [];
    for (const p of plan.pull) {
      const abs = resolveIn(root, p);
      const bytes = await fs.readFile(abs).catch(() => null);
      // A file that moved between the walk and the read is simply picked up
      // by the next round; the hash guard would discard a stale answer anyway.
      if (!bytes) continue;
      pull.push({ path: p, base64: bytes.toString("base64"), hash: theirs[p].hash, bytes: bytes.length });
    }
    return {
      plan: {
        pull,
        pullDeletes: plan.pullDeletes,
        push: plan.push,
        pushDeletes: plan.pushDeletes,
        conflicts: plan.conflicts,
      },
      initial,
      at: new Date().toISOString(),
    };
  },
  async "POST /mirror/apply"({ writes = [], deletes = [], conflicts = [], manifest }, _q, root, rootName) {
    // Preserve the desktop variant before OPFS overwrites it (OPFS is
    // canonical). Conflict copies are excluded from later syncs by name.
    for (const p of conflicts) {
      const abs = resolveIn(root, p);
      await fs.copyFile(abs, mirrorConflictPath(abs)).catch(() => {});
    }
    for (const p of deletes) {
      await fs.rm(resolveIn(root, p), { recursive: true, force: true });
    }
    let written = 0;
    for (const entry of writes) {
      if (typeof entry?.path !== "string" || typeof entry.base64 !== "string") {
        throw new Error("mirror write entries need {path, base64}");
      }
      const abs = resolveIn(root, entry.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, Buffer.from(entry.base64, "base64"));
      written++;
    }
    if (manifest !== undefined) await saveMirrorBase(rootName, parseManifest(manifest));
    return { ok: true, written, deleted: deletes.length, conflicts: conflicts.length };
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
  if (req.method === "POST" && pathname === "/stt") {
    // Raw audio pass-through: the body is bytes, not JSON — handled before
    // the JSON routes below.
    void handleStt(req, res, send, new URLSearchParams(query));
    return;
  }
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
