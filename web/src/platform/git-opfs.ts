/**
 * Git for the browser workspace: `isomorphic-git` over the OPFS filesystem
 * adapter. Runs inside the agent worker (or main thread); uses the async OPFS
 * API (`useSync: false`) so it coexists with the corefs FileSystem handles.
 *
 * Local commits only: enough for grandpa-bob's per-write auto-commit. Remote
 * push/pull would need an HTTP remote (the Node `git daemon` protocol does not
 * work from a browser).
 */
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import OPFS from "@componentor/opfs-fs";
import { Buffer } from "buffer";
import type { GitOps } from "../../../src/platform/types";
import "../shims/process";

// isomorphic-git expects Node's Buffer in the global scope.
(globalThis as unknown as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

type GitFs = Parameters<typeof git.init>[0]["fs"];

/** Clone a remote into the browser workspace (OPFS). */
export async function cloneWorkspace(root: string, url: string): Promise<void> {
  const opfs = new OPFS({ useSync: false });
  await (opfs as unknown as { ready?: () => Promise<void> }).ready?.();
  const fs = opfs as unknown as GitFs;
  await git.clone({ fs, http, dir: root, url, singleBranch: true });
}

let sharedOpfs: OPFS | null = null;
async function gitFs(): Promise<GitFs> {
  if (!sharedOpfs) sharedOpfs = new OPFS({ useSync: false });
  await (sharedOpfs as unknown as { ready?: () => Promise<void> }).ready?.();
  return sharedOpfs as unknown as GitFs;
}

/** Working-tree changes and current branch. */
export async function gitStatus(root: string): Promise<unknown> {
  const fs = await gitFs();
  const matrix = await git.statusMatrix({ fs, dir: root });
  const changes = matrix
    .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
    .map(([filepath, head, workdir, stage]) => ({ path: filepath, head, workdir, stage }));
  const branch = await git.currentBranch({ fs, dir: root, fullname: false }).catch(() => null);
  return { branch, changes };
}

/** Recent commits (short). */
export async function gitLog(root: string, depth = 5): Promise<unknown> {
  const fs = await gitFs();
  const commits = await git.log({ fs, dir: root, depth });
  return commits.map((c) => ({ oid: c.oid.slice(0, 7), message: c.commit.message.split("\n")[0] }));
}

/** Fetch updates from the configured remote. */
export async function gitFetch(root: string, url: string): Promise<unknown> {
  if (!url) throw new Error("no git remote configured");
  const fs = await gitFs();
  const result = await git.fetch({ fs, http, dir: root, url, singleBranch: true });
  return { fetched: result.fetchHead?.slice(0, 7) ?? null };
}

/** Push the current branch to the configured remote (optionally refs/heads/<branch>). */
export async function gitPush(root: string, url: string, branch?: string): Promise<unknown> {
  if (!url) throw new Error("no git remote configured");
  const fs = await gitFs();
  const result = await git.push({ fs, http, dir: root, url, ...(branch ? { ref: branch } : {}) });
  return { ok: result.ok, refs: Object.fromEntries(Object.entries(result.refs ?? {}).map(([k, v]) => [k, String(v).slice(0, 7)])) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`git step timed out: ${label}`)), ms)),
  ]);
}

export function createOpfsGit(root: string): GitOps {
  const opfs = new OPFS({ useSync: false });
  const fs = opfs as unknown as GitFs;
  const dir = root;
  const author = { name: "BOB", email: "bob@browser" };

  async function hasRepo(): Promise<boolean> {
    try {
      await withTimeout(git.resolveRef({ fs, dir, ref: "HEAD" }), 3000, "resolveRef");
      return true;
    } catch {
      return false;
    }
  }

  return {
    async ensureRepo(): Promise<void> {
      await (opfs as unknown as { ready?: () => Promise<void> }).ready?.();
      if (await hasRepo()) return;
      await withTimeout(git.init({ fs, dir, defaultBranch: "main" }), 4000, "init");
    },
    async autoCommit(paths: string[], message: string): Promise<string> {
      try {
        await (opfs as unknown as { ready?: () => Promise<void> }).ready?.();
        if (!(await hasRepo())) await withTimeout(git.init({ fs, dir, defaultBranch: "main" }), 4000, "init");
        for (const filepath of paths) {
          await withTimeout(git.add({ fs, dir, filepath }), 4000, `add ${filepath}`);
        }
        const sha = await withTimeout(git.commit({ fs, dir, message, author }), 4000, "commit");
        return sha.slice(0, 7);
      } catch (err) {
        console.error("[git] autoCommit failed:", err);
        return "failed";
      }
    },
    status: () => gitStatus(dir),
    log: (depth = 5) => gitLog(dir, depth),
    fetch: (url: string) => gitFetch(dir, url),
    push: (url: string, branch?: string) => gitPush(dir, url, branch),
  };
}
