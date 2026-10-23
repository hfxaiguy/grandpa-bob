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

import { access, readdir } from "node:fs/promises";
import path from "node:path";

export const PATTERNS_DIR = "patterns";
export const APP_DIR = "app";
export const TREE_FILE = "tree";
export const PROD_SUFFIX = ".prod.mjs";

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
