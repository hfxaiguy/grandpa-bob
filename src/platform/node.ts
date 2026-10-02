/**
 * Node adapter. Wraps the existing Node implementations behind the platform
 * interfaces so the shared core can run on Node without changing behavior.
 *
 * Browser code must never import this module (it pulls in node:fs, node:path,
 * child_process). The browser adapter lives in `web/src/platform/browser.ts`.
 */
import fs from "node:fs/promises";
import nodePath from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { posixPath } from "./paths.js";
import type {
  CryptoOps,
  DirEntry,
  FileSystem,
  GitOps,
  PathOps,
  Platform,
  Shell,
  SqliteDatabase,
  SqliteFactory,
} from "./types.js";
import { ShellTools } from "../tools/shell.js";
import { autoCommit, ensureRepo } from "../tools/git.js";

/** Node path ops. On Linux these are POSIX; use `posixPath`-equivalent output. */
export const nodePathOps: PathOps = {
  sep: nodePath.sep,
  resolve: (...parts) => nodePath.posix.resolve(...parts),
  join: (...parts) => nodePath.posix.join(...parts),
  relative: (from, to) => nodePath.posix.relative(from, to),
  dirname: (p) => nodePath.posix.dirname(p),
  basename: (p, ext) => nodePath.posix.basename(p, ext),
  extname: (p) => nodePath.posix.extname(p),
  isAbsolute: (p) => nodePath.posix.isAbsolute(p),
  normalize: (p) => nodePath.posix.normalize(p),
};

export const nodeFs: FileSystem = {
  readFile: (path, encoding) => fs.readFile(path, encoding ?? "utf8"),
  writeFile: (path, data) => fs.writeFile(path, data).then(() => undefined),
  mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
  readdir: (path, _opts) =>
    fs.readdir(path, { withFileTypes: true }).then((entries) =>
      entries.map(
        (e): DirEntry => ({
          name: e.name,
          isDirectory: () => e.isDirectory(),
          isFile: () => e.isFile(),
        }),
      ),
    ),
  stat: async (path) => {
    const st = await fs.stat(path);
    return { isFile: () => st.isFile(), isDirectory: () => st.isDirectory() };
  },
  rm: (path) => fs.rm(path).then(() => undefined),
  rename: (from, to) => fs.rename(from, to).then(() => undefined),
};

export const nodeCrypto: CryptoOps = {
  randomUUID: () => randomUUID(),
  sha256hex: (text) => createHash("sha256").update(text).digest("hex"),
};

/** node:sqlite adapter (synchronous DatabaseSync / StatementSync). */
export const nodeSqlite: SqliteFactory = {
  open(path: string, { readOnly }): SqliteDatabase {
    const db = new DatabaseSync(path, { readOnly });
    return {
      prepare(sql) {
        const stmt = db.prepare(sql);
        return {
          all: (...params) => stmt.all(...(params as never[])) as unknown[],
          get: (...params) => stmt.get(...(params as never[])),
          run: (...params) =>
            stmt.run(...(params as never[])) as {
              changes: number | bigint;
              lastInsertRowid: number | bigint;
            },
          columns: () => stmt.columns().map((c) => ({ name: c.name ?? "" })),
        };
      },
      exec: (sql) => {
        db.exec(sql);
      },
      close: () => db.close(),
    };
  },
};

/** Build a Node-backed `Platform`. `allowedCommands` feeds the shell adapter. */
export function createNodePlatform(workspaceRoot: string, allowedCommands: string[] = []): Platform {
  const shellTools = new ShellTools(workspaceRoot, allowedCommands);
  const shell: Shell = {
    runCommand: (command, args) => shellTools.runCommand(command, args),
  };
  const git: GitOps = {
    ensureRepo: () => ensureRepo(workspaceRoot),
    autoCommit: (paths, message) => autoCommit(workspaceRoot, paths, message),
  };
  return {
    kind: "node",
    path: nodePathOps,
    fs: nodeFs,
    crypto: nodeCrypto,
    shell,
    git,
    sqlite: nodeSqlite,
    workspaceRoot,
  };
}

export { posixPath };
