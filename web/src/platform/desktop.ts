/**
 * "Desktop storage" platform: the browser uses the real workspace on the
 * machine running scripts/storage-server.mjs, via a loopback HTTP bridge.
 *
 * Files and git go to the desktop; SQLite is not bridged yet (phase 2).
 */
import { posixPath } from "../../../src/platform/paths";
import { sha256hex } from "../../../src/platform/sha256";
import { createCoreutilsShell } from "../../../src/platform/coreutils";
import type { CryptoOps, DirEntry, FileSystem, GitOps, Platform, SqliteFactory } from "../../../src/platform/types";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function call<T>(base: string, route: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `storage bridge HTTP ${res.status}`);
  return json as T;
}

function httpFs(base: string): FileSystem {
  return {
    async readFile(path) {
      return (await call<{ content: string }>(base, "/fs/read", { path })).content;
    },
    async writeFile(path, data) {
      const body =
        typeof data === "string" ? { path, content: data } : { path, base64: toBase64(data) };
      await call(base, "/fs/write", body);
    },
    async mkdir(path) {
      await call(base, "/fs/mkdir", { path });
    },
    async readdir(path) {
      const { entries } = await call<{ entries: Array<{ name: string; isDirectory: boolean }> }>(base, "/fs/list", {
        path,
      });
      return entries.map(
        (e): DirEntry => ({
          name: e.name,
          isDirectory: () => e.isDirectory,
          isFile: () => !e.isDirectory,
        }),
      );
    },
    async stat(path) {
      const st = await call<{ isFile: boolean; isDirectory: boolean }>(base, "/fs/stat", { path });
      return { isFile: () => st.isFile, isDirectory: () => st.isDirectory };
    },
    async rm(path) {
      await call(base, "/fs/rm", { path });
    },
    async rename(from, to) {
      await call(base, "/fs/rename", { from, to });
    },
  };
}

function httpGit(base: string): GitOps {
  return {
    async ensureRepo() {
      await call(base, "/git", { op: "init" });
    },
    async autoCommit(paths, message) {
      try {
        const { commit } = await call<{ commit?: string }>(base, "/git", { op: "commit", paths, message });
        return commit ?? "no-changes";
      } catch {
        return "failed";
      }
    },
    status: () => call(base, "/git", { op: "status" }),
    log: () => call(base, "/git", { op: "log" }),
    fetch: (url: string) => call(base, "/git", { op: "fetch", url }),
    push: (url: string) => call(base, "/git", { op: "push", url }),
  };
}

const desktopSqlite: SqliteFactory = {
  open: async () => {
    throw new Error("desktop SQLite is not bridged yet (phase 2)");
  },
};

export function createDesktopPlatform(workspaceRoot: string, server: string): Platform {
  const base = server.replace(/\/$/, "");
  const fs = httpFs(base);
  const crypto: CryptoOps = { randomUUID: () => crypto.randomUUID(), sha256hex };
  return {
    kind: "browser",
    path: posixPath,
    fs,
    crypto,
    shell: createCoreutilsShell({ fs, path: posixPath, workspaceRoot }),
    git: httpGit(base),
    sqlite: desktopSqlite,
    workspaceRoot,
  };
}
