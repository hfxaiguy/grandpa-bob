/**
 * `FileSystem` adapter over a `FileSystemDirectoryHandle`.
 *
 * The root is the origin-private file system (`navigator.storage.getDirectory()`).
 *
 * Keeping one implementation means tree sources, file tools, patterns, git and
 * the workspace file browser all behave identically over the private browser
 * sandbox.
 *
 * Known gaps handled here:
 *   - no `rename`/`move`  -> copy + delete
 *   - no `stat`           -> resolve a handle and report its kind/size/mtime
 *   - no chmod/mtime      -> not modelled (the interface does not need them)
 */
import type { DirEntry, FileSystem } from "../../../src/platform/types";

function segments(absolutePath: string): string[] {
  return absolutePath.split("/").filter((s) => s.length > 0 && s !== ".");
}

/**
 * Directory iteration (`entries()`) is part of the File System Access API but
 * is missing from some TypeScript DOM lib versions; declare it locally.
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

async function copyFile(
  src: FileSystemDirectoryHandle,
  srcName: string,
  dst: FileSystemDirectoryHandle,
  dstName: string,
): Promise<void> {
  const file = await (await src.getFileHandle(srcName)).getFile();
  const buffer = await file.arrayBuffer();
  const handle = await dst.getFileHandle(dstName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(buffer as Parameters<typeof writable.write>[0]);
  await writable.close();
}

async function copyDir(
  src: FileSystemDirectoryHandle,
  srcName: string,
  dst: FileSystemDirectoryHandle,
  dstName: string,
): Promise<void> {
  const srcDir = await src.getDirectoryHandle(srcName);
  const dstDir = await dst.getDirectoryHandle(dstName, { create: true });
  await eachEntry(srcDir, async (child, handle) => {
    if (handle.kind === "directory") await copyDir(srcDir, child, dstDir, child);
    else await copyFile(srcDir, child, dstDir, child);
  });
}

async function copyEntry(
  src: FileSystemDirectoryHandle,
  srcName: string,
  dst: FileSystemDirectoryHandle,
  dstName: string,
): Promise<void> {
  if ((await entryKind(src, srcName)) === "file") await copyFile(src, srcName, dst, dstName);
  else await copyDir(src, srcName, dst, dstName);
}

export interface HandleFileSystem extends FileSystem {
  /** Binary read (git objects are not UTF-8). */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Size/mtime in addition to the kind (git status needs both). */
  statDetail(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    mtimeMs: number;
  }>;
  /** The folder this filesystem is rooted at. */
  rootHandle(): Promise<FileSystemDirectoryHandle>;
}

/**
 * Create a filesystem rooted at whatever handle `getRoot` returns. The root is
 * resolved lazily per call so a re-picked folder takes effect without rebuilding
 * the platform.
 */
export function createHandleFs(
  getRoot: () => Promise<FileSystemDirectoryHandle>,
): HandleFileSystem {
  async function parentOf(
    absolutePath: string,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = segments(absolutePath);
    const name = parts.pop();
    if (!name) throw new DOMException(`invalid path: ${absolutePath}`, "TypeMismatchError");
    const dir = await dirHandle(await getRoot(), parts, false);
    return { dir, name };
  }

  return {
    async readFile(absolutePath) {
      const { dir, name } = await parentOf(absolutePath);
      const file = await (await dir.getFileHandle(name)).getFile();
      return file.text();
    },

    async readFileBytes(absolutePath) {
      const { dir, name } = await parentOf(absolutePath);
      const file = await (await dir.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    },

    async writeFile(absolutePath, data) {
      const parts = segments(absolutePath);
      const name = parts.pop();
      if (!name) throw new DOMException(`invalid path: ${absolutePath}`, "TypeMismatchError");
      const dir = await dirHandle(await getRoot(), parts, true);
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(data as Parameters<typeof writable.write>[0]);
      await writable.close();
    },

    async mkdir(absolutePath) {
      await dirHandle(await getRoot(), segments(absolutePath), true);
    },

    async readdir(absolutePath) {
      const dir = await dirHandle(await getRoot(), segments(absolutePath), false);
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
      if (segments(absolutePath).length === 0) {
        return { isFile: () => false, isDirectory: () => true };
      }
      const { dir, name } = await parentOf(absolutePath);
      const kind = await entryKind(dir, name);
      return {
        isFile: () => kind === "file",
        isDirectory: () => kind === "directory",
      };
    },

    async statDetail(absolutePath) {
      if (segments(absolutePath).length === 0) {
        return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
      }
      const { dir, name } = await parentOf(absolutePath);
      const kind = await entryKind(dir, name);
      if (kind === "directory") {
        return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
      }
      const file = await (await dir.getFileHandle(name)).getFile();
      return {
        isFile: true,
        isDirectory: false,
        size: file.size,
        mtimeMs: file.lastModified,
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
      const dstDir = await dirHandle(await getRoot(), dstParts, true);
      await copyEntry(src.dir, src.name, dstDir, dstName);
      await src.dir.removeEntry(src.name, { recursive: true });
    },

    rootHandle: getRoot,
  };
}
