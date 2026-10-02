/**
 * In-memory `Platform` for tests and for the browser target's early stages.
 * No Node builtins, so it runs anywhere (Node tests, browser, workers).
 */
import { posixPath } from "./paths.js";
import type { CryptoOps, DirEntry, FileSystem, GitOps, Platform, Shell, SqliteFactory } from "./types.js";
import { sha256hex } from "./sha256.js";

interface Node {
  type: "file" | "dir";
  data?: string | Uint8Array;
}

export function createMemoryFs(): FileSystem {
  const nodes = new Map<string, Node>();

  const normalize = (p: string): string => posixPath.resolve("/", p);
  const parent = (p: string): string => posixPath.dirname(p);

  const ensureDir = (dir: string): void => {
    const abs = normalize(dir);
    if (abs === "/") return;
    if (nodes.get(abs)?.type === "file") throw new Error(`not a directory: ${abs}`);
    if (!nodes.has(abs)) {
      ensureDir(parent(abs));
      nodes.set(abs, { type: "dir" });
    }
  };

  const requireDir = (dir: string): void => {
    const abs = normalize(dir);
    const node = nodes.get(abs);
    if (!node) throw new Error(`not found: ${abs}`);
    if (node.type !== "dir") throw new Error(`not a directory: ${abs}`);
  };

  return {
    async readFile(p) {
      const node = nodes.get(normalize(p));
      if (!node) throw new Error(`not found: ${p}`);
      if (node.type === "dir") throw new Error(`is a directory: ${p}`);
      if (typeof node.data === "string" || node.data === undefined) return node.data ?? "";
      return new TextDecoder().decode(node.data);
    },
    async writeFile(p, data) {
      const abs = normalize(p);
      ensureDir(parent(abs));
      nodes.set(abs, { type: "file", data });
    },
    async mkdir(p) {
      ensureDir(p);
    },
    async readdir(p) {
      const abs = normalize(p);
      requireDir(abs);
      const prefix = abs === "/" ? "/" : abs + "/";
      const seen = new Set<string>();
      const out: DirEntry[] = [];
      for (const [key, node] of nodes) {
        if (key === abs || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split("/")[0];
        if (seen.has(name)) continue;
        seen.add(name);
        const isDir = node.type === "dir" || rest.includes("/");
        out.push({ name, isDirectory: () => isDir, isFile: () => !isDir });
      }
      return out;
    },
    async stat(p) {
      const node = nodes.get(normalize(p));
      if (!node) throw new Error(`not found: ${p}`);
      return {
        isFile: () => node.type === "file",
        isDirectory: () => node.type === "dir",
      };
    },
    async rm(p) {
      const abs = normalize(p);
      if (!nodes.has(abs)) throw new Error(`not found: ${p}`);
      const prefix = abs + "/";
      for (const key of [...nodes.keys()]) {
        if (key === abs || key.startsWith(prefix)) nodes.delete(key);
      }
    },
    async rename(from, to) {
      const src = normalize(from);
      const dst = normalize(to);
      const node = nodes.get(src);
      if (!node) throw new Error(`not found: ${from}`);
      ensureDir(parent(dst));
      const prefix = src + "/";
      const moves: Array<[string, Node]> = [];
      for (const [key, value] of nodes) {
        if (key === src) moves.push([dst, value]);
        else if (key.startsWith(prefix)) moves.push([dst + key.slice(src.length), value]);
      }
      for (const key of [...nodes.keys()]) {
        if (key === src || key.startsWith(prefix)) nodes.delete(key);
      }
      for (const [key, value] of moves) nodes.set(key, value);
    },
  };
}

export function createMemoryPlatform(opts: { root?: string; autoCommit?: GitOps["autoCommit"] } = {}): Platform {
  let uuid = 0;
  const crypto: CryptoOps = {
    randomUUID: () => `mem-${++uuid}`,
    sha256hex,
  };
  const shell: Shell = {
    runCommand: async (command) => `error: command not available in memory platform: ${command}`,
  };
  const git: GitOps = {
    ensureRepo: async () => {},
    autoCommit: opts.autoCommit ?? (async () => "no-changes"),
  };
  const sqlite: SqliteFactory = {
    open: () => {
      throw new Error("sqlite is not implemented in the memory platform");
    },
  };
  return {
    kind: "browser",
    path: posixPath,
    fs: createMemoryFs(),
    crypto,
    shell,
    git,
    sqlite,
    workspaceRoot: opts.root ?? "/workspace",
  };
}
