/**
 * Vite alias target for `node:fs` / `node:fs/promises`. Backed by the OPFS
 * FileSystem. Implements the subset the shared modules use, including the
 * `withFileTypes` readdir form and (ignored) option objects.
 */
import type { DirEntry } from "../../../src/platform/types";
import { opfsFs } from "../platform/corefs";

export async function readFile(path: string, _encoding?: string): Promise<string> {
  return opfsFs.readFile(path, "utf8");
}

export async function writeFile(
  path: string,
  data: string | Uint8Array,
  _options?: unknown,
): Promise<void> {
  return opfsFs.writeFile(path, data);
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  return opfsFs.mkdir(path, { recursive: options?.recursive ?? true });
}

export function readdir(path: string): Promise<string[]>;
export function readdir(path: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
export async function readdir(
  path: string,
  options?: { withFileTypes?: boolean },
): Promise<string[] | DirEntry[]> {
  const entries = await opfsFs.readdir(path, { withFileTypes: true });
  return options?.withFileTypes ? entries : entries.map((e) => e.name);
}

export async function stat(path: string) {
  return opfsFs.stat(path);
}

export async function rm(path: string): Promise<void> {
  return opfsFs.rm(path);
}

export async function unlink(path: string): Promise<void> {
  return opfsFs.rm(path);
}

export async function rename(from: string, to: string): Promise<void> {
  return opfsFs.rename(from, to);
}

export default { readFile, writeFile, mkdir, readdir, stat, rm, unlink, rename };
