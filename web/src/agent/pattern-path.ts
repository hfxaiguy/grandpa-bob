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
import { resolveTreeEntry } from "../../../src/tree-versions";

export const DEFAULT_PATTERN_PATH = "patterns/trunk.mjs";

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

  // Not in the catalog (yet): fall back to the conventional pattern path so a
  // missing file surfaces the loader's own ENOENT instead of a bad path.
  return `patterns/${logical}.mjs`;
}
