// Local storage bridge for the browser target's "desktop storage" mode.
//
//   node scripts/storage-server.mjs [workspaceRoot]
//
// Exposes the real workspace (files + git) over loopback HTTP with CORS, so
// the browser can use the desktop's storage instead of OPFS. Sandboxed to the
// workspace root. Loopback-only; add auth before exposing it.
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(process.argv[2] ?? process.env.WORKSPACE_DIR ?? process.cwd());
const PORT = Number(process.env.STORAGE_PORT ?? 8795);

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function resolveIn(rel) {
  // Treat incoming paths as workspace-relative even when they start with "/".
  const rel2 = String(rel ?? ".").replace(/^\/+/, "") || ".";
  const abs = path.resolve(ROOT, rel2);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
  return abs;
}

async function git(args) {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

const routes = {
  async "GET /health"() {
    return { ok: true, root: ROOT };
  },
  async "POST /fs/list"({ path: p }) {
    const entries = await fs.readdir(resolveIn(p), { withFileTypes: true });
    return { entries: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })) };
  },
  async "POST /fs/read"({ path: p }) {
    return { content: await fs.readFile(resolveIn(p), "utf8") };
  },
  async "POST /fs/write"({ path: p, content, base64 }) {
    const abs = resolveIn(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (base64 !== undefined) await fs.writeFile(abs, Buffer.from(base64, "base64"));
    else await fs.writeFile(abs, content ?? "", "utf8");
    return { ok: true };
  },
  async "POST /fs/mkdir"({ path: p }) {
    await fs.mkdir(resolveIn(p), { recursive: true });
    return { ok: true };
  },
  async "POST /fs/stat"({ path: p }) {
    const st = await fs.stat(resolveIn(p)).catch(() => null);
    if (!st) throw new Error(`not found: ${p}`);
    return { isFile: st.isFile(), isDirectory: st.isDirectory() };
  },
  async "POST /fs/rm"({ path: p }) {
    await fs.rm(resolveIn(p), { recursive: true, force: true });
    return { ok: true };
  },
  async "POST /fs/rename"({ from, to }) {
    const abs = resolveIn(to);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.rename(resolveIn(from), abs);
    return { ok: true };
  },
  async "POST /git"({ op, paths = [], message, remote, url: remoteUrl, branch }) {
    if (op === "status") {
      const status = await git(["status", "--porcelain"]);
      const branchName = await git(["branch", "--show-current"]);
      return {
        branch: branchName.stdout || null,
        changes: status.stdout ? status.stdout.split("\n") : [],
      };
    }
    if (op === "log") {
      const log = await git(["log", "--oneline", "-5"]).catch(() => ({ stdout: "" }));
      return { log: log.stdout };
    }
    if (op === "init") {
      await git(["rev-parse", "--is-inside-work-tree"]).catch(() => git(["init", "-b", "main"]));
      return { ok: true };
    }
    if (op === "commit") {
      await git(["add", "-A", "--", ...(paths.length ? paths : ["."])]);
      await git(["-c", "user.name=BOB", "-c", "user.email=bob@desktop", "commit", "-q", "-m", message ?? "agent commit"]).catch(
        (e) => {
          if (!/nothing to commit/.test(String(e.stdout) + String(e.stderr))) throw e;
        },
      );
      return { commit: (await git(["rev-parse", "--short", "HEAD"])).stdout };
    }
    if (op === "fetch" || op === "pull" || op === "push") {
      const target = remoteUrl || remote;
      if (!target) throw new Error("no git remote");
      const ref = branch ? `HEAD:refs/heads/${branch}` : "HEAD";
      const args =
        op === "push" ? ["push", target, ref] : op === "fetch" ? ["fetch", target] : ["pull", target];
      return { result: (await git(args)).stdout || `${op} ok` };
    }
    throw new Error(`unknown git op: ${op}`);
  },
  async "POST /sql/columns"({ path: p, sql }) {
    const db = new DatabaseSync(resolveIn(p), { readOnly: true });
    try {
      return { columns: db.prepare(sql).columns().map((c) => ({ name: c.name ?? "" })) };
    } finally {
      db.close();
    }
  },
  async "POST /sql/all"({ path: p, sql, params = [] }) {
    const db = new DatabaseSync(resolveIn(p), { readOnly: true });
    try {
      return { rows: db.prepare(sql).all(...params) };
    } finally {
      db.close();
    }
  },
  async "POST /sql/get"({ path: p, sql, params = [] }) {
    const db = new DatabaseSync(resolveIn(p), { readOnly: true });
    try {
      return { row: db.prepare(sql).get(...params) ?? null };
    } finally {
      db.close();
    }
  },
  async "POST /sql/run"({ path: p, sql, params = [] }) {
    const db = new DatabaseSync(resolveIn(p));
    try {
      const info = db.prepare(sql).run(...params);
      return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid ?? 0) };
    } finally {
      db.close();
    }
  },
  async "POST /sql/exec"({ path: p, sql }) {
    const db = new DatabaseSync(resolveIn(p));
    try {
      db.exec(sql);
      return { ok: true };
    } finally {
      db.close();
    }
  },
};

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const [pathname, query = ""] = (req.url ?? "/").split("?");
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
      send(200, await handler(body, new URLSearchParams(query)));
    } catch (err) {
      send(400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`storage bridge on http://127.0.0.1:${PORT}  root=${ROOT}`));
