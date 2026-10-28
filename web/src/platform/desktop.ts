/**
 * "Desktop storage" platform: the browser uses the real workspace on the
 * machine running scripts/storage-server.mjs, via a loopback HTTP bridge.
 *
 * Files, git, and SQLite go to the desktop; the session log reads and writes
 * `logs/grandma-kat.db` through the bridge like any other DB.
 */
import { posixPath } from "./paths";
import { sha256hex } from "./sha256";
import { createCoreutilsShell } from "./coreutils";
import type { CryptoOps, DirEntry, FileSystem, GitOps, Platform, SqliteFactory } from "./types";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
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

interface DesktopFileSystem extends FileSystem {
  /** Binary read for archives (git objects, sqlite databases). */
  readFileBytes(path: string): Promise<Uint8Array>;
}

function httpFs(base: string): DesktopFileSystem {
  return {
    async readFile(path) {
      return (await call<{ content: string }>(base, "/fs/read", { path })).content;
    },
    async readFileBytes(path) {
      return fromBase64((await call<{ base64: string }>(base, "/fs/readBytes", { path })).base64);
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
    fetch: (url: string, branch?: string) => call(base, "/git", { op: "fetch", url, branch }),
    push: (url: string, branch?: string) => call(base, "/git", { op: "push", url, branch }),
    async commitAll(message: string): Promise<string> {
      const { commit } = await call<{ commit?: string }>(base, "/git", { op: "commit", paths: ["."], message });
      return commit ?? "no-changes";
    },
  };
}

function httpSqlite(base: string): SqliteFactory {
  return {
    async open(path) {
      return {
        async prepare(sql) {
          const { columns } = await call<{ columns: Array<{ name: string }> }>(base, "/sql/columns", { path, sql });
          return {
            all: async (...params: unknown[]) =>
              (await call<{ rows: unknown[] }>(base, "/sql/all", { path, sql, params })).rows,
            get: async (...params: unknown[]) =>
              (await call<{ row: unknown }>(base, "/sql/get", { path, sql, params })).row,
            run: async (...params: unknown[]) =>
              call<{ changes: number; lastInsertRowid: number }>(base, "/sql/run", { path, sql, params }),
            columns: async () => columns,
          };
        },
        async exec(sql) {
          await call(base, "/sql/exec", { path, sql });
        },
        async close() {
          /* each op opens and closes its own handle */
        },
      };
    },
  };
}

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
    sqlite: httpSqlite(base),
    workspaceRoot,
  };
}
