/**
 * OPFS-backed `FileSystem` adapter for the browser target.
 *
 * Implements the shared `FileSystem` interface (src/platform/types.ts) on top
 * of the Origin Private File System. OPFS is origin-scoped, so this is a real
 * sandbox: the host filesystem is not reachable.
 *
 * The handle-based implementation lives in ./handle-fs.ts and backs the OPFS
 * adapter. The root is not always the origin root: `./opfs-root.ts` holds the
 * active profile segments, so switching profiles only rebinds the root.
 */
import { posixPath as path } from "./paths";
import { createHandleFs, type HandleFileSystem } from "./handle-fs";
import { resolveOpfsRoot } from "./opfs-root";

export const opfsFs: HandleFileSystem = createHandleFs(resolveOpfsRoot);

export { path };
