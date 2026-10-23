/**
 * Resolve whatever the UI calls a "pattern" to a concrete workspace file.
 *
 * Two shapes reach the agent worker:
 *   - a workspace path from boot/detection: `patterns/trunk.prod.mjs`
 *   - a logical name from the pattern picker: `context_manager`
 *
 * A tree is one file: `patterns/<name>.prod.mjs` or `app/<name>/tree.prod.mjs`.
 * A bare name goes through the tree resolver rather than being treated as a
 * filename — passing the name straight to the module loader opened
 * `<workspace>/context_manager`, which does not exist.
 */
import type { Platform } from "../../../src/platform/types";
import { resolveTreeEntry } from "../../../src/tree-files";

export const DEFAULT_PATTERN_PATH = "patterns/trunk.prod.mjs";

/**
 * Human-facing name for a pattern path or logical name:
 * `patterns/context_manager.prod.mjs` → `context_manager`.
 */
export function patternLabel(pattern?: string | null): string {
  const raw = (pattern ?? "").trim();
  if (!raw) return "";
  const file = raw.split("/").pop() ?? raw;
  return file.replace(/\.mjs$/, "").replace(/\.prod$/, "");
}

function looksLikePath(pattern: string): boolean {
  return pattern.includes("/") || pattern.endsWith(".mjs") || pattern.endsWith(".js");
}

export async function resolvePatternPath(platform: Platform, pattern?: string | null): Promise<string> {
  const raw = (pattern ?? "").trim();
  if (!raw) return DEFAULT_PATTERN_PATH;
  if (looksLikePath(raw)) return raw;

  const entry = await resolveTreeEntry(platform.workspaceRoot, raw).catch(() => null);
  if (entry) return entry.file;

  throw new Error(
    `unknown tree '${raw}': no patterns/${raw}.prod.mjs or app/${raw}/tree.prod.mjs ` +
      `(a dotted name maps to its nested folder, e.g. a.b → app/a/app/b/tree.prod.mjs)`,
  );
}
