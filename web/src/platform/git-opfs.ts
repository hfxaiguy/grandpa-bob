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
  };
}
