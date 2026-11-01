/**
 * Bridge-backed platform for desktop-only operations on a real folder.
 *
 * The tab's workspace always lives in OPFS; a desktop mirror folder is kept in
 * sync through the bridge (see `web/src/server-link.ts`). This adapter exposes the
 * folder's real files/git/SQLite over the same loopback bridge for operations
 * that OPFS cannot perform (git against local paths, node:sqlite, archives).
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

async function call<T>(
  base: string,
  route: string,
  body: Record<string, unknown> = {},
  rootName?: string,
): Promise<T> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Desktop profiles: the bridge resolves this root name against its
      // folder registry (~/.bobkat/channels.json) and sandboxes every
      // path inside it. Absent/`default` = the bridge's own workspace root.
      ...(rootName && rootName !== "default" ? { "x-bob-root": rootName } : {}),
    },
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

function httpFs(base: string, rootName?: string): DesktopFileSystem {
  return {
    async readFile(path) {
      return (await call<{ content: string }>(base, "/fs/read", { path }, rootName)).content;
    },
    async readFileBytes(path) {
      return fromBase64(
        (await call<{ base64: string }>(base, "/fs/readBytes", { path }, rootName)).base64,
      );
    },
    async writeFile(path, data) {
      const body =
        typeof data === "string" ? { path, content: data } : { path, base64: toBase64(data) };
      await call(base, "/fs/write", body, rootName);
    },
    async mkdir(path) {
      await call(base, "/fs/mkdir", { path }, rootName);
    },
    async readdir(path) {
      const { entries } = await call<{ entries: Array<{ name: string; isDirectory: boolean }> }>(
        base,
        "/fs/list",
        { path },
        rootName,
      );
      return entries.map(
        (e): DirEntry => ({
          name: e.name,
          isDirectory: () => e.isDirectory,
          isFile: () => !e.isDirectory,
        }),
      );
    },
    async stat(path) {
      const st = await call<{ isFile: boolean; isDirectory: boolean }>(base, "/fs/stat", { path }, rootName);
      return { isFile: () => st.isFile, isDirectory: () => st.isDirectory };
    },
    async rm(path) {
      await call(base, "/fs/rm", { path }, rootName);
    },
    async rename(from, to) {
      await call(base, "/fs/rename", { from, to }, rootName);
    },
  };
}

function httpGit(base: string, rootName?: string): GitOps {
  return {
    async ensureRepo() {
      await call(base, "/git", { op: "init" }, rootName);
    },
    async autoCommit(paths, message) {
      try {
        const { commit } = await call<{ commit?: string }>(base, "/git", { op: "commit", paths, message }, rootName);
        return commit ?? "no-changes";
      } catch {
        return "failed";
      }
    },
    status: () => call(base, "/git", { op: "status" }, rootName),
    log: () => call(base, "/git", { op: "log" }, rootName),
    fetch: (url: string, branch?: string) => call(base, "/git", { op: "fetch", url, branch }, rootName),
    push: (url: string, branch?: string) => call(base, "/git", { op: "push", url, branch }, rootName),
    async commitAll(message: string): Promise<string> {
      const { commit } = await call<{ commit?: string }>(base, "/git", { op: "commit", paths: ["."], message }, rootName);
      return commit ?? "no-changes";
    },
  };
}

function httpSqlite(base: string, rootName?: string): SqliteFactory {
  return {
    async open(path) {
      return {
        async prepare(sql) {
          const { columns } = await call<{ columns: Array<{ name: string }> }>(
            base,
            "/sql/columns",
            { path, sql },
            rootName,
          );
          return {
            all: async (...params: unknown[]) =>
              (await call<{ rows: unknown[] }>(base, "/sql/all", { path, sql, params }, rootName)).rows,
            get: async (...params: unknown[]) =>
              (await call<{ row: unknown }>(base, "/sql/get", { path, sql, params }, rootName)).row,
            run: async (...params: unknown[]) =>
              call<{ changes: number; lastInsertRowid: number }>(base, "/sql/run", { path, sql, params }, rootName),
            columns: async () => columns,
          };
        },
        async exec(sql) {
          await call(base, "/sql/exec", { path, sql }, rootName);
        },
        async close() {
          /* each op opens and closes its own handle */
        },
      };
    },
  };
}

/**
 * Build the desktop platform. `opts.rootName` selects a registered folder
 * root for every request (desktop profiles); absent = the bridge's own
 * workspace root (the pre-profiles "default" root).
 */
export function createDesktopPlatform(
  workspaceRoot: string,
  server: string,
  opts: { rootName?: string } = {},
): Platform {
  const base = server.replace(/\/$/, "");
  const fs = httpFs(base, opts.rootName);
  const crypto: CryptoOps = { randomUUID: () => crypto.randomUUID(), sha256hex };
  return {
    kind: "browser",
    path: posixPath,
    fs,
    crypto,
    shell: createCoreutilsShell({ fs, path: posixPath, workspaceRoot }),
    git: httpGit(base, opts.rootName),
    sqlite: httpSqlite(base, opts.rootName),
    workspaceRoot,
  };
}
