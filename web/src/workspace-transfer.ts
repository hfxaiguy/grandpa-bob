/**
 * Workspace backup/restore. OPFS is already the live workspace; this exports
 * the whole origin storage to a portable JSON blob (base64 for binaries such as
 * .db files) and can restore it. Binary-safe and dependency-free.
 *
 * Restore is a **merge**: archive files are written over the workspace, files
 * the archive does not carry are left alone. The toolbar's Import button uses
 * this after confirming with the user, then reloads so the platform, the fs
 * index and the sqlite worker re-read the restored files.
 */
import { posixPath as path } from "../../src/platform/paths";

export interface WorkspaceArchive {
  version: 1;
  createdAt: string;
  files: Array<{ path: string; base64: string }>;
}

interface IterableDirHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new Error("invalid base64 data");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Archive paths are OPFS-relative, e.g. "workspace/app/trunk.prod.mjs". */
function archivePath(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`archive entry ${index}: missing path`);
  }
  if (value.startsWith("/") || value.includes("\\")) {
    throw new Error(`archive entry ${index}: path must be OPFS-relative: ${value}`);
  }
  if (value.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`archive entry ${index}: path escapes the workspace: ${value}`);
  }
  return value;
}

/**
 * Check a parsed JSON value is a `WorkspaceArchive` and return a normalized
 * copy. Throws a user-facing message naming the first bad entry, so the Import
 * button can reject a wrong file before touching OPFS.
 */
export function validateWorkspaceArchive(value: unknown): WorkspaceArchive {
  if (!isRecord(value)) throw new Error("not a workspace archive (expected a JSON object)");
  if (value.version !== 1) throw new Error(`unsupported archive version: ${String(value.version)}`);
  if (typeof value.createdAt !== "string") throw new Error("archive is missing createdAt");
  if (!Array.isArray(value.files)) throw new Error("archive is missing the files list");

  const files = value.files.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`archive entry ${index}: not an object`);
    const entryPath = archivePath(entry.path, index);
    if (typeof entry.base64 !== "string") {
      throw new Error(`archive entry ${index} (${entryPath}): missing base64 data`);
    }
    return { path: entryPath, base64: entry.base64 };
  });
  return { version: 1, createdAt: value.createdAt, files };
}

async function eachEntry(
  dir: FileSystemDirectoryHandle,
  visit: (name: string, handle: FileSystemHandle) => Promise<void>,
): Promise<void> {
  for await (const [name, handle] of (dir as IterableDirHandle).entries()) {
    await visit(name, handle);
  }
}

async function collect(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: WorkspaceArchive["files"],
): Promise<void> {
  await eachEntry(dir, async (name, handle) => {
    const rel = path.join(prefix, name);
    if (handle.kind === "directory") {
      await collect(await dir.getDirectoryHandle(name), rel, out);
      return;
    }
    const file = await (await dir.getFileHandle(name)).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    out.push({ path: rel, base64: toBase64(bytes) });
  });
}

/** Read every file in OPFS (workspace + sqlite databases) into an archive. */
export async function buildWorkspaceArchive(): Promise<WorkspaceArchive> {
  const files: WorkspaceArchive["files"] = [];
  await collect(await navigator.storage.getDirectory(), "", files);
  return { version: 1, createdAt: new Date().toISOString(), files };
}

/** A JSON blob for the archive, ready to download. */
export function archiveToBlob(archive: WorkspaceArchive): Blob {
  return new Blob([JSON.stringify(archive)], { type: "application/json" });
}

/** Read every file in OPFS (workspace + sqlite databases) into a JSON blob. */
export async function exportWorkspace(): Promise<Blob> {
  return archiveToBlob(await buildWorkspaceArchive());
}

/**
 * Write an archive back into OPFS (merge: paths in the archive are overwritten,
 * anything else is kept). Returns the number of files written.
 */
export async function importWorkspace(archive: WorkspaceArchive): Promise<number> {
  const root = await navigator.storage.getDirectory();
  let written = 0;
  for (const entry of archive.files) {
    const parts = entry.path.split("/").filter((part) => part && part !== ".");
    if (parts.some((part) => part === "..")) throw new Error(`invalid archive path: ${entry.path}`);
    const name = parts.pop();
    if (!name) continue;
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(entry.base64);
    } catch (err) {
      throw new Error(`archive entry ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as unknown as Parameters<typeof writable.write>[0]);
    await writable.close();
    written++;
  }
  return written;
}

/** Recursively count files in OPFS (for display). */
export async function countWorkspaceFiles(): Promise<number> {
  const files: WorkspaceArchive["files"] = [];
  await collect(await navigator.storage.getDirectory(), "", files);
  return files.length;
}
