/**
 * Resolve whatever the UI calls a "pattern" to a concrete workspace file.
 *
 * Two shapes reach the agent worker:
 *   - a workspace path from boot/detection: `patterns/trunk.mjs`
 *   - a logical name from the pattern picker: `context_manager` or `name@v3`
 *
 * The workspace convention is the draft/prod pair (`name.draft.mjs` /
 * `name.prod.mjs`), so a bare name must go through the version-aware catalog
 * (`resolveTreeEntry`) rather than being treated as a filename. Passing the
 * name straight to the module loader opened `<workspace>/context_manager`,
 * which does not exist.
 */
import type { Platform } from "../../../src/platform/types";
import { listTreeEntries, resolveTreeEntry } from "../../../src/tree-versions";

export const DEFAULT_PATTERN_PATH = "patterns/trunk.mjs";

/**
 * Human-facing name for a pattern path or logical name:
 * `patterns/context_manager.prod.mjs` → `context_manager`.
 */
export function patternLabel(pattern?: string | null): string {
  const raw = (pattern ?? "").trim();
  if (!raw) return "";
  const file = raw.split("/").pop() ?? raw;
  return file.replace(/\.mjs$/, "").replace(/\.(draft|prod|v\d+)$/, "");
}

function looksLikePath(pattern: string): boolean {
  return pattern.includes("/") || pattern.endsWith(".mjs") || pattern.endsWith(".js");
}

export async function resolvePatternPath(platform: Platform, pattern?: string | null): Promise<string> {
  const raw = (pattern ?? "").trim();
  if (!raw) return DEFAULT_PATTERN_PATH;
  if (looksLikePath(raw)) return raw;

  const at = raw.lastIndexOf("@");
  const logical = at >= 0 ? raw.slice(0, at) : raw;
  const ref = at >= 0 ? raw.slice(at + 1) : null;

  const entry = await resolveTreeEntry(platform.workspaceRoot, logical, ref).catch(() => null);
  if (entry) return entry.file;

  // Not in the catalog. A plain `patterns/<name>.mjs` may still exist (older
  // single-file patterns), so allow that; otherwise fail with the names that
  // do exist instead of a bare ENOENT pointing at a file nobody wrote.
  const conventional = `patterns/${logical}.mjs`;
  const exists = await platform.fs
    .stat(platform.path.join(platform.workspaceRoot, conventional))
    .then((st) => st.isFile())
    .catch(() => false);
  if (exists) return conventional;

  const entries = await listTreeEntries(platform.workspaceRoot).catch(() => []);
  const available = [
    ...new Set(entries.filter((e) => e.kind === "pattern").map((e) => e.logical)),
  ]
    .sort()
    .join(", ");
  throw new Error(
    `unknown pattern '${logical}'${ref ? ` (@${ref})` : ""}` +
      (available ? ` — available: ${available}` : ""),
  );
}
