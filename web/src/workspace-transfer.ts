/**
 * Workspace backup/restore. OPFS is already the live workspace; this exports
 * the whole origin storage to a portable JSON blob (base64 for binaries such as
 * .db files) and can restore it. Binary-safe and dependency-free.
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

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
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
export async function exportWorkspace(): Promise<Blob> {
  const files: WorkspaceArchive["files"] = [];
  await collect(await navigator.storage.getDirectory(), "", files);
  const archive: WorkspaceArchive = { version: 1, createdAt: new Date().toISOString(), files };
  return new Blob([JSON.stringify(archive)], { type: "application/json" });
}

/** Write an archive back into OPFS. Returns the number of files restored. */
export async function importWorkspace(archive: WorkspaceArchive): Promise<number> {
  const root = await navigator.storage.getDirectory();
  for (const entry of archive.files) {
    const parts = entry.path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(fromBase64(entry.base64) as unknown as Parameters<typeof writable.write>[0]);
    await writable.close();
  }
  return archive.files.length;
}

/** Recursively count files in OPFS (for display). */
export async function countWorkspaceFiles(): Promise<number> {
  const files: WorkspaceArchive["files"] = [];
  await collect(await navigator.storage.getDirectory(), "", files);
  return files.length;
}
