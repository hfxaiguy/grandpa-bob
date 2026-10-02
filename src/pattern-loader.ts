// src/pattern-loader.ts
//
// Loads Tree patterns from workspace/patterns/*.mjs at runtime.
// Each file exports a built tree (`export default Tree(...)`) or a
// default function that receives the element surface and returns a Tree.
//
// The loader busts the ESM import cache on every call so the agent
// can self-modify patterns and see changes on the next turn.

import { pathToFileURL } from "node:url";
import { resolveTreeEntry } from "./tree-versions.js";
// @ts-ignore — grandma-kat ships no .d.ts files.
import { Tree, when, goback, goto, max, update, calls, parameters, disableAuto, toolHookBefore, toolHookAfter, name as elementName, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Each, Call, Check, Emit, Return, Until, From, memory, version, description, optional } from "grandma-kat";

export const DEFAULT_PATTERN = "trunk";

/**
 * Split `name@ref` into its logical tree name and version ref. The `@` is the
 * operator surface only — it never appears in a filename. A missing ref means
 * "prod, else draft".
 */
export function splitTreeRef(name: string): { logical: string; ref?: string } {
  const at = name.indexOf("@");
  if (at < 0) return { logical: name };
  const ref = name.slice(at + 1);
  return { logical: name.slice(0, at), ref: ref || undefined };
}

/** Args passed to every pattern function. */
export interface PatternContext {
  Tree: typeof Tree;
  when: typeof when;
  goback: typeof goback;
  goto: typeof goto;
  max: typeof max;
  /** Memory-update marker for `.memory(update(), ...)` writes. */
  update: typeof update;
  /** Register markers for `.register(name, desc, fn, calls(...), parameters(...))`. */
  calls: typeof calls;
  parameters: typeof parameters;
  /** Prompt markers for the auto tool loop (see grandma-kat docs). */
  disableAuto: typeof disableAuto;
  toolHookBefore: typeof toolHookBefore;
  toolHookAfter: typeof toolHookAfter;
  /** The element surface — trees may be authored as elements. */
  name: typeof elementName;
  Model: typeof Model;
  Tools: typeof Tools;
  Needs: typeof Needs;
  Human: typeof Human;
  Prompt: typeof Prompt;
  Memory: typeof Memory;
  Register: typeof Register;
  Branch: typeof Branch;
  Each: typeof Each;
  Call: typeof Call;
  Check: typeof Check;
  Emit: typeof Emit;
  Return: typeof Return;
  Until: typeof Until;
  /** Attach a registered tree as a branch, optionally seeding its scope. */
  From: typeof From;
  /** Marker for From('name', memory(fn)) — the slots to seed. */
  memory: typeof memory;
  /**
   * Marker for From('name', version('vN'|'prod'|'draft')) — pin the imported
   * tree to a snapshot. The host resolves it from disk at run time.
   */
  version: typeof version;
  /** Marker for Needs('name', description('...')) — an input-slots's note. */
  description: typeof description;
  /** Marker for Needs('name', optional()) — an input that may be absent. */
  optional: typeof optional;
}

/**
 * Load a named tree from the workspace. A name resolves to
 * `patterns/<name>.mjs` first, then to an app tree at
 * `app/<name>/tree.mjs`. The file may export a built tree
 * (`export default Tree(...)`) or a default function that receives
 * `PatternContext` and returns a Tree.
 *
 * @param workspaceDir  The workspace root (e.g. ~/grandma-workspace)
 * @param name          Pattern name or app directory name (default "trunk")
 */
export async function loadPattern(
  workspaceDir: string,
  name: string = DEFAULT_PATTERN,
) {
  const { logical, ref } = splitTreeRef(name);
  if (!/^[A-Za-z0-9._-]+$/.test(logical)) {
    throw new Error(`invalid pattern name '${name}'`);
  }
  const resolved = await resolveTreeEntry(workspaceDir, logical, ref);
  if (!resolved) {
    throw new Error(
      `failed to load pattern '${name}': not found for '${logical}'` +
        (ref ? ` at version '${ref}'` : "") +
        ` in patterns/ or app/*/tree.mjs`,
    );
  }
  const filePath = resolved.abs;
  const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;

  let mod: { default?: unknown };
  try {
    mod = await import(fileUrl);
  } catch (err: any) {
    throw new Error(`failed to load pattern '${name}' from ${filePath}: ${err.message}`);
  }

  if (typeof mod.default !== "function" && (typeof mod.default !== "object" || mod.default === null)) {
    throw new Error(`pattern '${name}' must export a default tree or a factory function: ${filePath}`);
  }

  const ctx: PatternContext = { Tree, when, goback, goto, max, update, calls, parameters, disableAuto, toolHookBefore, toolHookAfter, name: elementName, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Each, Call, Check, Emit, Return, Until, From, memory, version, description, optional };
  const tree = typeof mod.default === "function" ? mod.default(ctx) : mod.default;

  if (!tree || typeof tree !== "object") {
    throw new Error(`pattern '${name}' must return a Tree definition: ${filePath}`);
  }

  // Snapshot trees carry a stable version-qualified internal name
  // (`trunk.v1`), so a checkpoint grown under one stays valid when promotion
  // only renames files. The draft keeps the bare logical name.
  const def = (tree as { def?: { name?: string | null } }).def ?? (tree as { name?: string | null });
  if (def && typeof def === "object") def.name = resolved.internalName;

  return tree;
}
