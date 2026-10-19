/**
 * Git over a `FileSystemDirectoryHandle` (a picked real folder or OPFS).
 *
 * isomorphic-git wants a Node-like `fs.promises` API, including binary reads
 * and stat with size/mtime. `HandleFileSystem` exposes both; this module maps
 * the two, so the same git code works for the browser sandbox and a real
 * workspace on disk.
 *
 * Local commits only for callers that do not configure a remote; push/pull use
 * the HTTP transport (`isomorphic-git/http/web`) and work with CORS-enabled
 * remotes, exactly like the OPFS target.
 */
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Buffer } from "buffer";
import type { GitOps } from "../../../src/platform/types";
import { posixPath } from "../../../src/platform/paths";
import type { HandleFileSystem } from "./handle-fs";
import "../shims/process";

// isomorphic-git expects Node's Buffer in the global scope.
(globalThis as unknown as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

type GitFs = Parameters<typeof git.init>[0]["fs"];

function codedError(code: string, message: string, p: string): Error {
  const err = new Error(`${code}: ${message}, '${p}'`) as Error & { code?: string };
  err.code = code;
  return err;
}

function normalize(p: string): string {
  if (!p || p === "." || p === "./") return "/";
  const normalized = posixPath.normalize(p);
  if (normalized === "." || normalized === "") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function rootOf(dir: string): string {
  return normalize(dir);
}

interface Stat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
  mtime: Date;
  ctimeMs: number;
  ctime: Date;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
}

/**
 * Node-ish promises facade passed to isomorphic-git. Only the calls the library
 * actually makes are implemented; anything else throws ENOSYS.
 */
function gitFs(fs: HandleFileSystem): GitFs {
  async function stat(p: string): Promise<Stat> {
    let detail: Awaited<ReturnType<HandleFileSystem["statDetail"]>>;
    try {
      detail = await fs.statDetail(normalize(p));
    } catch {
      throw codedError("ENOENT", "no such file or directory", p);
    }
    const isFile = detail.isFile;
    const when = new Date(detail.mtimeMs || Date.now());
    return {
      isFile: () => isFile,
      isDirectory: () => !isFile,
      isSymbolicLink: () => false,
      size: detail.size,
      mtimeMs: when.getTime(),
      mtime: when,
      ctimeMs: when.getTime(),
      ctime: when,
      dev: 0,
      ino: 0,
      uid: 0,
      gid: 0,
      mode: isFile ? 0o100644 : 0o040000,
    };
  }

  const promises = {
    async readFile(p: string, opts?: { encoding?: string } | string): Promise<unknown> {
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      try {
        if (encoding === "utf8" || encoding === "utf-8") {
          return await fs.readFile(normalize(p));
        }
        return await fs.readFileBytes(normalize(p));
      } catch {
        throw codedError("ENOENT", "no such file or directory", p);
      }
    },
    async writeFile(p: string, data: string | Uint8Array): Promise<void> {
      await fs.writeFile(normalize(p), data);
    },
    async unlink(p: string): Promise<void> {
      try {
        await fs.rm(normalize(p));
      } catch {
        throw codedError("ENOENT", "no such file or directory", p);
      }
    },
    async readdir(p: string): Promise<string[]> {
      try {
        const entries = await fs.readdir(normalize(p), { withFileTypes: true });
        return entries.map((e) => e.name);
      } catch {
        throw codedError("ENOENT", "no such file or directory", p);
      }
    },
    async mkdir(p: string): Promise<void> {
      await fs.mkdir(normalize(p), { recursive: false });
    },
    async rmdir(p: string): Promise<void> {
      const dir = normalize(p);
      try {
        // The adapter has no "remove empty directory" primitive; list first so
        // a populated directory keeps its ENOTEMPTY behavior.
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (entries.length) throw codedError("ENOTEMPTY", "directory not empty", p);
      } catch (err) {
        if ((err as { code?: string }).code === "ENOTEMPTY") throw err;
        throw codedError("ENOENT", "no such file or directory", p);
      }
      await fs.rm(dir);
    },
    async rename(from: string, to: string): Promise<void> {
      try {
        await fs.rename(normalize(from), normalize(to));
      } catch {
        throw codedError("ENOENT", "no such file or directory", from);
      }
    },
    async stat(p: string): Promise<Stat> {
      return stat(p);
    },
    async lstat(p: string): Promise<Stat> {
      return stat(p);
    },
    async chmod(): Promise<void> {
      /* mode is not modelled; git's executable bit is ignored */
    },
    async symlink(): Promise<void> {
      throw codedError("ENOSYS", "symlinks are not supported", "");
    },
    async readlink(p: string): Promise<string> {
      throw codedError("ENOSYS", `symlinks are not supported: ${p}`, p);
    },
  };

  return { promises } as unknown as GitFs;
}

/** Clone a remote into a picked directory. */
export async function cloneIntoHandle(
  fs: HandleFileSystem,
  root: string,
  url: string,
): Promise<void> {
  await git.clone({ fs: gitFs(fs), http, dir: rootOf(root), url, singleBranch: true });
}

export async function handleGitStatus(fs: HandleFileSystem, root: string): Promise<unknown> {
  const matrix = await git.statusMatrix({ fs: gitFs(fs), dir: rootOf(root) });
  const changes = matrix
    .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
    .map(([filepath, head, workdir, stage]) => ({ path: filepath, head, workdir, stage }));
  const branch = await git
    .currentBranch({ fs: gitFs(fs), dir: rootOf(root), fullname: false })
    .catch(() => null);
  return { branch, changes };
}

export async function handleGitLog(fs: HandleFileSystem, root: string, depth = 5): Promise<unknown> {
  const commits = await git.log({ fs: gitFs(fs), dir: rootOf(root), depth });
  return commits.map((c) => ({ oid: c.oid.slice(0, 7), message: c.commit.message.split("\n")[0] }));
}

export async function handleGitFetch(fs: HandleFileSystem, root: string, url: string): Promise<unknown> {
  if (!url) throw new Error("no git remote configured");
  const result = await git.fetch({ fs: gitFs(fs), http, dir: rootOf(root), url, singleBranch: true });
  return { fetched: result.fetchHead?.slice(0, 7) ?? null };
}

export async function handleGitPush(
  fs: HandleFileSystem,
  root: string,
  url: string,
  branch?: string,
): Promise<unknown> {
  if (!url) throw new Error("no git remote configured");
  const result = await git.push({
    fs: gitFs(fs),
    http,
    dir: rootOf(root),
    url,
    ...(branch ? { ref: branch } : {}),
  });
  return {
    ok: result.ok,
    refs: Object.fromEntries(
      Object.entries(result.refs ?? {}).map(([k, v]) => [k, String(v).slice(0, 7)]),
    ),
  };
}

export async function handleGitPull(
  fs: HandleFileSystem,
  root: string,
  url: string,
  branch?: string,
): Promise<unknown> {
  if (!url) throw new Error("no git remote configured");
  const dir = rootOf(root);
  const ref =
    branch ??
    (await git.currentBranch({ fs: gitFs(fs), dir, fullname: false }).catch(() => null)) ??
    "main";
  await git.pull({
    fs: gitFs(fs),
    http,
    dir,
    url,
    ref,
    singleBranch: true,
    fastForwardOnly: true,
    author: { name: "BOB", email: "bob@browser" },
  });
  return { ok: true };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`git step timed out: ${label}`)), ms),
    ),
  ]);
}

export function createHandleGit(fs: HandleFileSystem, root: string): GitOps {
  const dir = rootOf(root);
  const author = { name: "BOB", email: "bob@browser" };
  const gfs = gitFs(fs);

  async function hasRepo(): Promise<boolean> {
    try {
      await withTimeout(git.resolveRef({ fs: gfs, dir, ref: "HEAD" }), 3000, "resolveRef");
      return true;
    } catch {
      return false;
    }
  }

  return {
    async ensureRepo(): Promise<void> {
      if (await hasRepo()) return;
      await withTimeout(git.init({ fs: gfs, dir, defaultBranch: "main" }), 4000, "init");
    },
    async autoCommit(paths: string[], message: string): Promise<string> {
      try {
        if (!(await hasRepo())) {
          await withTimeout(git.init({ fs: gfs, dir, defaultBranch: "main" }), 4000, "init");
        }
        for (const filepath of paths) {
          await withTimeout(git.add({ fs: gfs, dir, filepath }), 4000, `add ${filepath}`);
        }
        const sha = await withTimeout(git.commit({ fs: gfs, dir, message, author }), 4000, "commit");
        return sha.slice(0, 7);
      } catch (err) {
        console.error("[git] autoCommit failed:", err);
        return "failed";
      }
    },
    status: () => handleGitStatus(fs, dir),
    log: (depth = 5) => handleGitLog(fs, dir, depth),
    fetch: (url: string) => handleGitFetch(fs, dir, url),
    push: (url: string, branch?: string) => handleGitPush(fs, dir, url, branch),
    pull: (url: string, branch?: string) => handleGitPull(fs, dir, url, branch),
    async commitAll(message: string): Promise<string> {
      if (!(await hasRepo())) {
        await withTimeout(git.init({ fs: gfs, dir, defaultBranch: "main" }), 4000, "init");
      }
      const matrix = await git.statusMatrix({ fs: gfs, dir });
      for (const [filepath, head, workdir, stage] of matrix) {
        if (head === 1 && workdir === 1 && stage === 1) continue; // unchanged
        if (workdir === 0) await withTimeout(git.remove({ fs: gfs, dir, filepath }), 4000, `remove ${filepath}`);
        else await withTimeout(git.add({ fs: gfs, dir, filepath }), 4000, `add ${filepath}`);
      }
      const sha = await withTimeout(git.commit({ fs: gfs, dir, message, author }), 4000, "commit");
      return sha.slice(0, 7);
    },
  };
}
