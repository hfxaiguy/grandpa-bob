import { posixPath } from "../platform/paths.js";

const path = posixPath;

/** Resolve a user/agent-supplied relative path inside the workspace, rejecting escapes. */
export function resolveInWorkspace(workspace: string, rel: string): string {
  const abs = path.resolve(workspace, rel);
  // A "/" workspace (the desktop-bridge root) contains every absolute path;
  // the bridge enforces the real sandbox.
  if (workspace === path.sep) return abs;
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

export function toRel(workspace: string, abs: string): string {
  return path.relative(workspace, abs) || ".";
}
