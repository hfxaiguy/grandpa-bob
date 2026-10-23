// src/tree-files.ts
//
// Where a runnable tree lives. One file per tree:
//
//   patterns/<name>.prod.mjs      a pattern (the trunk, reusable trees)
//   app/<name>/tree.prod.mjs      an app tree
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

/** Relative production path for a logical tree. */
export function treePathFor(logical: string, kind: TreeKind = "app"): string {
  return kind === "app"
    ? path.join(APP_DIR, logical, `${TREE_FILE}${PROD_SUFFIX}`)
    : path.join(PATTERNS_DIR, `${logical}${PROD_SUFFIX}`);
}

/**
 * Resolve a logical name to its production file. `patterns/<name>.prod.mjs`
 * wins, then `app/<name>/tree.prod.mjs`. Returns null when neither exists.
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

/** Every logical name that resolves to a tree file, both kinds. */
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
      if (!entry.isDirectory()) continue;
      try {
        await access(path.join(workspaceDir, APP_DIR, entry.name, `${TREE_FILE}${PROD_SUFFIX}`));
        names.add(entry.name);
      } catch {
        // app without a tree — tools-only
      }
    }
  } catch {
    // no app directory
  }
  return [...names].sort();
}
