import { posixPath } from "../platform/paths.js";

const path = posixPath;

/** Resolve a user/agent-supplied relative path inside the workspace, rejecting escapes. */
export function resolveInWorkspace(workspace: string, rel: string): string {
  const abs = path.resolve(workspace, rel);
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

export function toRel(workspace: string, abs: string): string {
  return path.relative(workspace, abs) || ".";
}
