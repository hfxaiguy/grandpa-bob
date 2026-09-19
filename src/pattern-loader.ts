// src/pattern-loader.ts
//
// Loads Tree patterns from workspace/patterns/*.mjs at runtime.
// Each file exports a default function that receives the Tree builder
// API and returns a Tree definition.
//
// The loader busts the ESM import cache on every call so the agent
// can self-modify patterns and see changes on the next turn.

import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree, when, goback, goto, max } from "grandma-kat";

const PATTERN_DIR = "patterns";
export const DEFAULT_PATTERN = "trunk";

/** Args passed to every pattern function. */
export interface PatternContext {
  Tree: typeof Tree;
  when: typeof when;
  goback: typeof goback;
  goto: typeof goto;
  max: typeof max;
}

/**
 * Load a named pattern from the workspace. The file must export a
 * default function that receives `PatternContext` and returns a Tree.
 *
 * @param workspaceDir  The workspace root (e.g. ~/grandma-workspace)
 * @param name          Pattern name (filename without .mjs, default "trunk")
 */
export async function loadPattern(
  workspaceDir: string,
  name: string = DEFAULT_PATTERN,
) {
  const filePath = path.resolve(workspaceDir, PATTERN_DIR, `${name}.mjs`);
  const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;

  let mod: { default?: (ctx: PatternContext) => unknown };
  try {
    mod = await import(fileUrl);
  } catch (err: any) {
    throw new Error(`failed to load pattern '${name}' from ${filePath}: ${err.message}`);
  }

  if (typeof mod.default !== "function") {
    throw new Error(`pattern '${name}' must export a default function: ${filePath}`);
  }

  const ctx: PatternContext = { Tree, when, goback, goto, max };
  const tree = mod.default(ctx);

  if (!tree || typeof tree !== "object") {
    throw new Error(`pattern '${name}' must return a Tree definition: ${filePath}`);
  }

  return tree;
}
