/**
 * OPFS-backed `FileSystem` adapter for the browser target.
 *
 * Implements the shared `FileSystem` interface (src/platform/types.ts) on top
 * of the Origin Private File System. OPFS is origin-scoped, so this is a real
 * sandbox: the host filesystem is not reachable.
 *
 * The handle-based implementation lives in ./handle-fs.ts and is shared with
 * the File System Access ("Desktop direct") adapter.
 */
import { posixPath as path } from "../../../src/platform/paths";
import { createHandleFs, type HandleFileSystem } from "./handle-fs";

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

export const opfsFs: HandleFileSystem = createHandleFs(opfsRoot);

export { path };
