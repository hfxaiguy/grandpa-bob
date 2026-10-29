// src/tree-files.ts
//
// Where a runnable tree lives. One file per tree:
//
//   patterns/<name>.prod.mjs          a pattern (the trunk, reusable trees)
//   app/<name>/tree.prod.mjs          an app tree
//   app/<a>/app/<b>/tree.prod.mjs     a nested app tree: `a.b`
//
// Apps nest fractally: every app folder may keep an `app/` folder of its own,
// and the dotted logical name spells the path (`a.b.c` ⇔ app/a/app/b/app/c).
// Dots are the separator, so a nested folder segment must not contain one;
// flat directory names keep working for top-level apps. Slashes are never part
// of a logical name — engine branch paths use them for tree segments.
//
// The notation in the file's leading comment block IS the tree's spec — the
// code and that block are edited together, and git is the version history.
// There is no draft copy, no version snapshot, and no separate `.spec.md`.
// An app's agent-facing `## Guide` lives in its README.
//
// A child module is any existing `.mjs` inside an app folder (site_walk.mjs,
// tools.mjs, src/*.mjs). It is ordinary JavaScript the tree imports, not a
// tree: it has no notation spec and cannot be loaded as a target. Editing one
// is a confined write — the resolved path must stay inside that app's folder
// (symlinks resolved), and nested `app/` folders belong to sub-apps, not to
// the parent. See modulePathFor/resolveModuleEntry/listModuleFiles below.

import { access, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const PATTERNS_DIR = "patterns";
export const APP_DIR = "app";
export const TREE_FILE = "tree";
export const PROD_SUFFIX = ".prod.mjs";

/** A child module: ordinary JavaScript inside an app folder, imported by its
 *  tree. Only `.mjs` files are addressable — config, JSON and assets are not
 *  authoring targets. */
export const MODULE_SUFFIX = ".mjs";

/** One path segment of a child module. Rejects "", "." and ".." (so `..`
 *  traversal is impossible by construction) and hidden segments. */
const MODULE_SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export type TreeKind = "pattern" | "app";

/** A nested app segment: a folder under an `app/` folder. Dots are reserved —
 *  they join the segments of a logical name (`a.b` ⇔ app/a/app/b). */
export const LOGICAL_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The app folder of a logical name, relative to the workspace root:
 * `a.b.c` → `app/a/app/b/app/c`. Also dotless names (`contacts` →
 * `app/contacts`). Null when a segment carries a dot — such a flat name can
 * only ever be a top-level folder, never a nesting step.
 */
export function appDirFor(logical: string): string | null {
  const segments = logical.split(".");
  if (!segments.length || !segments.every((s) => LOGICAL_SEGMENT_RE.test(s))) return null;
  return path.join(...segments.flatMap((s) => [APP_DIR, s]));
}

/**
 * The logical name of an app folder relative to the workspace root:
 * `app/a/app/b` → `a.b`. Every odd step must be an `app/` folder and every
 * segment must be nestable; anything else (a dotted folder name, a stray
 * layout) is not globally addressable and gets null.
 */
export function logicalForAppDir(relDir: string): string | null {
  const parts = relDir.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2 || parts.length % 2 !== 0) return null;
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] !== APP_DIR || !LOGICAL_SEGMENT_RE.test(parts[i + 1])) return null;
    segments.push(parts[i + 1]);
  }
  return segments.join(".");
}

/** A tree file resolved from a logical name. */
export interface ResolvedTree {
  logical: string;
  kind: TreeKind;
  /** Relative to the workspace root, e.g. `app/contacts/tree.prod.mjs`. */
  file: string;
  /** Absolute path. */
  abs: string;
}

/** `trunk.prod.mjs` → `"trunk"`; `null` for tests and non-tree files. */
export function parsePatternFileName(file: string): string | null {
  if (!file.endsWith(PROD_SUFFIX)) return null;
  const logical = file.slice(0, -PROD_SUFFIX.length);
  if (!logical || logical.endsWith(".test")) return null;
  return logical;
}

/** True only for an app's `tree.prod.mjs`. */
export function isAppTreeFileName(file: string): boolean {
  return file === `${TREE_FILE}${PROD_SUFFIX}`;
}

/** Relative production path for a logical tree. Dotted names map to their
 *  nested app folder (`a.b` → app/a/app/b); a dotless name keeps today's flat
 *  path, and an ill-formed name falls back to it too so the error is visible. */
export function treePathFor(logical: string, kind: TreeKind = "app"): string {
  if (kind === "app") {
    const dir = appDirFor(logical) ?? path.join(APP_DIR, logical);
    return path.join(dir, `${TREE_FILE}${PROD_SUFFIX}`);
  }
  return path.join(PATTERNS_DIR, `${logical}${PROD_SUFFIX}`);
}

/**
 * Resolve a logical name to its production file. `patterns/<name>.prod.mjs`
 * wins, then `app/<name>/tree.prod.mjs`, then the dotted name's nested folder
 * (`a.b` → `app/a/app/b/tree.prod.mjs`). Returns null when none exists.
 */
export async function resolveTreeEntry(
  workspaceDir: string,
  logical: string,
): Promise<ResolvedTree | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(logical)) return null;
  const candidates: { kind: TreeKind; rel: string }[] = [
    { kind: "pattern", rel: path.join(PATTERNS_DIR, `${logical}${PROD_SUFFIX}`) },
    { kind: "app", rel: path.join(APP_DIR, logical, `${TREE_FILE}${PROD_SUFFIX}`) },
  ];
  // A dotted name may also be a nested app. The flat candidates resolve first,
  // so an existing top-level directory with that literal name keeps winning.
  const nested = appDirFor(logical);
  if (nested && nested !== path.join(APP_DIR, logical)) {
    candidates.push({ kind: "app", rel: path.join(nested, `${TREE_FILE}${PROD_SUFFIX}`) });
  }
  for (const candidate of candidates) {
    const abs = path.join(workspaceDir, candidate.rel);
    try {
      await access(abs);
      return { logical, kind: candidate.kind, file: candidate.rel, abs };
    } catch {
      // try the next location
    }
  }
  return null;
}

/** Every logical name that resolves to a tree file, both kinds, at any depth. */
export async function listTreeNames(workspaceDir: string): Promise<string[]> {
  const names = new Set<string>();
  try {
    for (const file of await readdir(path.join(workspaceDir, PATTERNS_DIR))) {
      const logical = parsePatternFileName(file);
      if (logical) names.add(logical);
    }
  } catch {
    // no patterns directory
  }
  try {
    for (const entry of await readdir(path.join(workspaceDir, APP_DIR), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      // A dot in a top-level folder name is a flat-name segment: the app still
      // exists, but it cannot host a nested app/ of its own (see listAppTrees).
      await collectAppTreeNames(
        path.join(workspaceDir, APP_DIR, entry.name),
        entry.name,
        LOGICAL_SEGMENT_RE.test(entry.name),
        names,
      );
    }
  } catch {
    // no app directory
  }
  return [...names].sort();
}

/** One app folder: its own tree, then its `app/` children, depth first. */
async function collectAppTreeNames(
  dirAbs: string,
  logical: string,
  nestable: boolean,
  names: Set<string>,
): Promise<void> {
  try {
    await access(path.join(dirAbs, `${TREE_FILE}${PROD_SUFFIX}`));
    names.add(logical);
  } catch {
    // app without a tree — tools-only
  }
  if (!nestable) return;
  try {
    for (const entry of await readdir(path.join(dirAbs, APP_DIR), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!LOGICAL_SEGMENT_RE.test(entry.name)) continue;
      await collectAppTreeNames(
        path.join(dirAbs, APP_DIR, entry.name),
        `${logical}.${entry.name}`,
        true,
        names,
      );
    }
  } catch {
    // no nested app folder
  }
}

// ── child modules: ordinary .mjs inside one app folder ─────────────────────
//
// A target names the app, never a path: `enrich-profile` + `site_walk` (the
// module is relative: `site_walk.mjs`, `src/site_walk.mjs`). The rules here are
// the whole safety surface for module edits, so they are strict:
//   - `.mjs` only, and the file must already exist (edits, not new files);
//   - every segment must be safe (no `..`, no hidden, no absolute paths);
//   - the resolved path must stay inside the app's own folder, symlinks
//     resolved, so a link planted in the app cannot reach outside it;
//   - nested `app/` folders belong to sub-apps and are not the parent's modules.

/** The app folder of a logical name, relative to the workspace root. */
function appFolderFor(logical: string): string {
  return appDirFor(logical) ?? path.join(APP_DIR, logical);
}

/**
 * Relative path of a child module, or null when the name is not addressable.
 * `module` is relative to the app folder and must end in `.mjs`.
 */
export function modulePathFor(logical: string, module: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(logical)) return null;
  const rel = String(module ?? "").trim().replace(/\\/g, "/");
  if (!rel || path.isAbsolute(rel) || !rel.endsWith(MODULE_SUFFIX)) return null;
  if (rel.endsWith(PROD_SUFFIX)) return null; // a tree file is not a child module
  const segments = rel.split("/");
  if (segments.some((s) => !MODULE_SEGMENT_RE.test(s))) return null;
  if (segments.some((s) => s === "node_modules" || s === APP_DIR)) return null;
  return path.join(appFolderFor(logical), ...segments);
}

/** A child module resolved from an app's logical name. */
export interface ResolvedModule {
  logical: string;
  /** Relative to the app folder, e.g. `site_walk.mjs` or `src/ingest.mjs`. */
  module: string;
  /** Relative to the workspace root. */
  file: string;
  /** Real (symlink-resolved) absolute path. */
  abs: string;
}

/**
 * Resolve an existing child module. Null when the name is malformed, the file
 * does not exist, or its real path escapes the app's folder.
 */
export async function resolveModuleEntry(
  workspaceDir: string,
  logical: string,
  module: string,
): Promise<ResolvedModule | null> {
  const rel = modulePathFor(logical, module);
  if (!rel) return null;
  try {
    const appRoot = await realpath(path.join(workspaceDir, appFolderFor(logical)));
    const abs = await realpath(path.join(workspaceDir, rel));
    if (!abs.startsWith(appRoot + path.sep)) return null;
    const info = await stat(abs);
    if (!info.isFile()) return null;
    return {
      logical,
      module: String(module).trim().replace(/\\/g, "/"),
      file: path.relative(workspaceDir, abs),
      abs,
    };
  } catch {
    return null;
  }
}

/**
 * Every existing child module of an app, relative to the app folder, sorted.
 * Skips hidden files, `node_modules`, and nested `app/` folders (sub-apps).
 */
export async function listModuleFiles(workspaceDir: string, logical: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dirAbs: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === APP_DIR) continue; // a sub-app is its own target
        await walk(path.join(dirAbs, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith(MODULE_SUFFIX)) {
        if (entry.name.endsWith(PROD_SUFFIX)) continue; // the tree itself
        if (MODULE_SEGMENT_RE.test(entry.name)) files.push(rel);
      }
    }
  }
  await walk(path.join(workspaceDir, appFolderFor(logical)), "");
  return files.sort();
}
