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

export default { readFile, writeFile, mkdir, readdir, stat, rm, unlink, rename };
