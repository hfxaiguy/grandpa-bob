/**
 * OPFS-backed `FileSystem` adapter for the browser target.
 *
 * Implements the shared `FileSystem` interface (src/platform/types.ts) on top
 * of the Origin Private File System. OPFS is origin-scoped, so this is a real
 * sandbox: the host filesystem is not reachable.
 *
 * Known OPFS gaps handled here:
 *   - no `rename`/`move`  -> copy + delete
 *   - no `stat`           -> resolve a handle and report its kind
 *   - no chmod/mtime      -> not modelled (the interface does not need them)
 */
import type { DirEntry, FileSystem } from "../../../src/platform/types";
import { posixPath as path } from "../../../src/platform/paths";

function segments(absolutePath: string): string[] {
  return absolutePath.split("/").filter((s) => s.length > 0 && s !== ".");
}

/**
 * OPFS directory iteration (`entries()`) is part of the File System Access API
 * but is missing from some TypeScript DOM lib versions; declare it locally.
 */
interface IterableDirHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

async function eachEntry(
  dir: FileSystemDirectoryHandle,
  visit: (name: string, handle: FileSystemHandle) => void | Promise<void>,
): Promise<void> {
  for await (const [name, handle] of (dir as IterableDirHandle).entries()) {
    await visit(name, handle);
  }
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function dirHandle(
  from: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = from;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

async function parentOf(
  absolutePath: string,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = segments(absolutePath);
  const name = parts.pop();
  if (!name) throw new DOMException(`invalid path: ${absolutePath}`, "TypeMismatchError");
  const dir = await dirHandle(await root(), parts, false);
  return { dir, name };
}

async function entryKind(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<"file" | "directory"> {
  try {
    await dir.getFileHandle(name);
    return "file";
  } catch {
    // fall through to directory
  }
  try {
    await dir.getDirectoryHandle(name);
    return "directory";
  } catch {
    throw new DOMException(`not found: ${name}`, "NotFoundError");
  }
}

async function copyEntry(
  src: FileSystemDirectoryHandle,
  dst: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const kind = await entryKind(src, name);
  if (kind === "file") {
    const file = await (await src.getFileHandle(name)).getFile();
    const buffer = await file.arrayBuffer();
    const handle = await dst.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(buffer);
    await writable.close();
    return;
  }
  const srcDir = await src.getDirectoryHandle(name);
  const dstDir = await dst.getDirectoryHandle(name, { create: true });
  await eachEntry(srcDir, (child) => copyEntry(srcDir, dstDir, child));
}

export const opfsFs: FileSystem = {
  async readFile(absolutePath) {
    const { dir, name } = await parentOf(absolutePath);
    const file = await (await dir.getFileHandle(name)).getFile();
    return file.text();
  },

  async writeFile(absolutePath, data) {
    const parts = segments(absolutePath);
    const name = parts.pop();
    if (!name) throw new DOMException(`invalid path: ${absolutePath}`, "TypeMismatchError");
    const dir = await dirHandle(await root(), parts, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  },

  async mkdir(absolutePath, _opts) {
    await dirHandle(await root(), segments(absolutePath), true);
  },

  async readdir(absolutePath) {
    const dir = await dirHandle(await root(), segments(absolutePath), false);
    const out: DirEntry[] = [];
    await eachEntry(dir, (name, handle) => {
      out.push({
        name,
        isDirectory: () => handle.kind === "directory",
        isFile: () => handle.kind === "file",
      });
    });
    return out;
  },

  async stat(absolutePath) {
    const { dir, name } = await parentOf(absolutePath);
    const kind = await entryKind(dir, name);
    return {
      isFile: () => kind === "file",
      isDirectory: () => kind === "directory",
    };
  },

  async rm(absolutePath) {
    const { dir, name } = await parentOf(absolutePath);
    await dir.removeEntry(name, { recursive: true });
  },

  async rename(from, to) {
    if (from === to) return;
    const src = await parentOf(from);
    const dstParts = segments(to);
    const dstName = dstParts.pop();
    if (!dstName) throw new DOMException(`invalid path: ${to}`, "TypeMismatchError");
    const dstDir = await dirHandle(await root(), dstParts, true);
    await copyEntry(src.dir, dstDir, src.name);
    await src.dir.removeEntry(src.name, { recursive: true });
  },
};

export { path };
