/**
 * Vite alias target for `node:fs` / `node:fs/promises`.
 *
 * Routes to the *active* backend: OPFS by default, or the desktop bridge when
 * storage mode is "desktop". Shared modules (tree-sources, tree-versions) that
 * `import fs from "node:fs"` therefore follow the selected storage mode.
 */
import type { DirEntry, FileSystem } from "../../../src/platform/types";
import { opfsFs } from "../platform/corefs";

let activeFs: FileSystem = opfsFs;

/** Point the node:fs shim at a backend (e.g. the desktop bridge). */
export function setActiveFs(fs: FileSystem): void {
  activeFs = fs;
}

// A preloaded index of workspace files, so synchronous calls (used by
// `appTreeNames()` in tree patterns) work without sync OPFS access.
let fsIndex: Set<string> | null = null;

/** Install an index of absolute file paths for the sync fs functions. */
export function setFsIndex(files: string[]): void {
  fsIndex = new Set(files);
}

function indexIsDir(p: string): boolean {
  if (!fsIndex) return false;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  for (const f of fsIndex) if (f.startsWith(prefix)) return true;
  return false;
}

/** Synchronous exists, backed by the preloaded index. */
export function existsSync(p: string): boolean {
  if (!fsIndex) return false;
  return fsIndex.has(p) || indexIsDir(p);
}

/** Synchronous readdir, backed by the preloaded index. */
export function readdirSync(p: string, options?: { withFileTypes?: boolean }): unknown {
  if (!fsIndex) throw new Error("readdirSync: filesystem index not loaded");
  const prefix = p.endsWith("/") ? p : `${p}/`;
  const kinds = new Map<string, boolean>();
  for (const f of fsIndex) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const name = rest.split("/")[0];
    if (!kinds.has(name)) kinds.set(name, rest.includes("/"));
  }
  const names = [...kinds.keys()].sort();
  if (options?.withFileTypes) {
    return names.map((name) => ({
      name,
      isDirectory: () => kinds.get(name) === true,
      isFile: () => kinds.get(name) !== true,
    }));
  }
  return names;
}

/** Synchronous stat, backed by the preloaded index. */
export function statSync(p: string): { isFile(): boolean; isDirectory(): boolean } {
  const dir = indexIsDir(p);
  if (!fsIndex?.has(p) && !dir) throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
  return { isFile: () => !dir, isDirectory: () => dir };
}

export async function readFile(path: string, _encoding?: string): Promise<string> {
  return activeFs.readFile(path, "utf8");
}

export async function writeFile(
  path: string,
  data: string | Uint8Array,
  _options?: unknown,
): Promise<void> {
  return activeFs.writeFile(path, data);
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  return activeFs.mkdir(path, { recursive: options?.recursive ?? true });
}

export function readdir(path: string): Promise<string[]>;
export function readdir(path: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
export async function readdir(
  path: string,
  options?: { withFileTypes?: boolean },
): Promise<string[] | DirEntry[]> {
  const entries = await activeFs.readdir(path, { withFileTypes: true });
  return options?.withFileTypes ? entries : entries.map((e) => e.name);
}

export async function stat(path: string) {
  return activeFs.stat(path);
}

export async function rm(path: string): Promise<void> {
  return activeFs.rm(path);
}

export async function unlink(path: string): Promise<void> {
  return activeFs.rm(path);
}

export async function rename(from: string, to: string): Promise<void> {
  return activeFs.rename(from, to);
}

export default {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  rm,
  unlink,
  rename,
  existsSync,
  readdirSync,
  statSync,
};
