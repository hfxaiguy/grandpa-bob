/**
 * OPFS root binding.
 *
 * The browser platform resolves every virtual path (`/workspace/...`) against
 * one root directory handle. With profiles, that root is no longer the origin
 * root: it is `/profiles/<name>/` for the active profile. This module holds the
 * current segments so every consumer (fs adapter, sqlite worker, transfer code)
 * agrees on the same root without threading a handle through the whole app.
 *
 * Workers are separate module instances, so the main thread passes the segments
 * in the Worker `name` (see `encodeOpfsPrefix` / `parseOpfsPrefix`), and the
 * worker calls `setOpfsRootSegments` itself before touching OPFS.
 */

let segments: string[] = [];

/** Segments below the origin root, e.g. `["profiles", "default"]`. */
export function setOpfsRootSegments(next: readonly string[]): void {
  segments = (next ?? [])
    .map((part) => String(part))
    .filter((part) => part.length > 0 && part !== "." && part !== "..");
}

export function opfsRootSegments(): string[] {
  return [...segments];
}

/**
 * Resolve the origin-private root, walking the active profile segments.
 * `create` is true for the profile path because the workspace root must exist
 * before sqlite/fs writes (a fresh profile starts empty).
 */
export async function resolveOpfsRoot(create = true): Promise<FileSystemDirectoryHandle> {
  return resolveOpfsDir(segments, create);
}

/** Resolve any directory below the origin root (empty segments = origin root). */
export async function resolveOpfsDir(
  parts: readonly string[],
  create = true,
): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory();
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("OPFS path may not escape the origin root");
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

/** Worker-name payload carrying the active profile segments. */
export function encodeOpfsPrefix(parts: readonly string[]): string {
  return JSON.stringify({ opfsPrefix: parts });
}

/** Parse a worker name; unusable values mean "origin root". */
export function parseOpfsPrefix(name: string | undefined | null): string[] {
  if (!name) return [];
  try {
    const raw = JSON.parse(name) as { opfsPrefix?: unknown };
    if (!Array.isArray(raw.opfsPrefix)) return [];
    return raw.opfsPrefix
      .map((part) => String(part))
      .filter((part) => part.length > 0 && part !== "." && part !== "..");
  } catch {
    return [];
  }
}
