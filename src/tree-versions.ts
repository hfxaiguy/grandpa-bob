// src/tree-versions.ts
//
// Tree versioning: one logical tree (e.g. `contacts`) can exist as several
// immutable snapshots plus one editable draft. The directory is the source of
// truth — there is no manifest and no hidden state. File grammar:
//
//   patterns/<logical>.mjs              draft (the file you edit)
//   patterns/<logical>.vN.mjs           candidate snapshot
//   patterns/<logical>.vN.prod.mjs      production snapshot (exactly one)
//   app/<logical>/tree.mjs              draft
//   app/<logical>/tree.vN.mjs           candidate snapshot
//   app/<logical>/tree.vN.prod.mjs      production snapshot
//
// Internal tree names are version-qualified and stable across a promote: the
// draft is `<logical>`, a snapshot is `<logical>.<vN>`. The bare `<logical>`
// is a host-side alias that resolves to the current prod snapshot (or the
// draft when no prod exists). Promoting therefore only renames files and
// re-points the alias — nothing a session pinned ever changes.
//
// Version ids are monotonic per logical tree (`v1`, `v2`, …). Because a
// logical always keeps its newest snapshot, the highest id never gets reused.

import { readdir, readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const PATTERNS_DIR = "patterns";
export const APP_DIR = "app";
export const TREE_FILE = "tree";
/** Keep the prod snapshot plus this many newest snapshots per tree. */
export const KEEP_VERSIONS = 10;

export type TreeKind = "pattern" | "app";

/** One file on disk that belongs to a logical tree (draft or snapshot). */
export interface VersionEntry {
  logical: string;
  kind: TreeKind;
  /** Relative to the workspace root, e.g. `patterns/trunk.v1.prod.mjs`. */
  file: string;
  /** Absolute path. */
  abs: string;
  /** `"vN"` for a snapshot, `null` for the draft. */
  version: string | null;
  /** True for the `*.prod` snapshot. */
  prod: boolean;
  /** True for the editable working file. */
  draft: boolean;
  /**
   * The paired `.spec.md` (the source of truth for behavior), relative to the
   * workspace root, e.g. `patterns/trunk.v1.spec.md`. Null when absent.
   */
  specFile: string | null;
  /** Absolute path of `specFile`. */
  specAbs: string | null;
}

/** A logical tree with the versions currently on disk. */
export interface TreeCatalogEntry {
  logical: string;
  kind: TreeKind;
  draft: boolean;
  /** True when a `*.prod` snapshot exists. */
  hasProd: boolean;
  /** Version id of the prod snapshot (`null` for a bare `.prod` or none). */
  prodVersion: string | null;
  /** Version ids present, ascending (`["v1", "v2"]`). */
  versions: string[];
  /** Version ids whose paired `.spec.md` exists, ascending. */
  specVersions: string[];
  /** True when the draft has a paired `.spec.md`. */
  draftSpec: boolean;
}

/** A resolved tree file for a logical name + ref. */
export interface ResolvedTree {
  logical: string;
  version: string | null;
  prod: boolean;
  draft: boolean;
  kind: TreeKind;
  file: string;
  abs: string;
  /** Stable internal name: `<logical>` (draft) or `<logical>.<vN>`. */
  internalName: string;
  /** Paired spec file (relative), or null when the version has no spec. */
  specFile: string | null;
  specAbs: string | null;
}

/**
 * The paired spec path for a tree file: replace the `.mjs` suffix with
 * `.spec.md`, keeping any version/prod suffix. `tree.v1.mjs` →
 * `tree.v1.spec.md`, `trunk.v1.prod.mjs` → `trunk.v1.prod.spec.md`.
 */
export function specPathForTree(treeFile: string): string {
  return treeFile.replace(/\.mjs$/, ".spec.md");
}

// ── filename parsing ──────────────────────────────────────────────────

/**
 * Parse a `.mjs` basename (without the extension) into its version parts.
 * `.vN` and `.prod` are reserved trailing suffixes; the rest is the logical
 * name (which may itself contain dots, e.g. `random_enrich.v2`).
 */
export function parseTreeBase(base: string): {
  logical: string;
  version: string | null;
  prod: boolean;
} | null {
  const parts = base.split(".");
  let prod = false;
  let version: string | null = null;
  if (parts.length > 1 && parts[parts.length - 1] === "prod") {
    prod = true;
    parts.pop();
  }
  if (parts.length > 1 && /^v[0-9]+$/.test(parts[parts.length - 1])) {
    version = parts.pop()!;
  }
  const logical = parts.join(".");
  if (!logical) return null;
  return { logical, version, prod };
}

/** Parse a `patterns/<file>` name. `null` for tests and non-trees. */
export function parsePatternFileName(
  file: string,
): { logical: string; version: string | null; prod: boolean } | null {
  if (!file.endsWith(".mjs")) return null;
  const base = file.slice(0, -".mjs".length);
  if (base.endsWith(".test")) return null;
  return parseTreeBase(base);
}

/** Parse an `app/<dir>/<file>` name; only `tree[.vN][.prod].mjs` counts. */
export function parseAppTreeFileName(
  file: string,
): { version: string | null; prod: boolean } | null {
  if (!file.endsWith(".mjs")) return null;
  const base = file.slice(0, -".mjs".length);
  const parsed = parseTreeBase(base);
  if (!parsed || parsed.logical !== TREE_FILE) return null;
  return { version: parsed.version, prod: parsed.prod };
}

/**
 * True when a file inside `patterns/` is a snapshot (versioned and/or prod)
 * rather than an editable draft. Discovery uses this to keep version files
 * out of `listPatterns`/`listAppTrees`.
 */
export function isVersionFileName(file: string): boolean {
  if (!file.endsWith(".mjs")) return false;
  const base = file.slice(0, -".mjs".length);
  if (base.endsWith(".test")) return false;
  const parsed = parseTreeBase(base);
  return !!parsed && (parsed.version !== null || parsed.prod);
}

/** Sort `vN` ids numerically, ascending. */
export function compareVersions(a: string, b: string): number {
  const na = parseInt(a.replace(/^v/, ""), 10);
  const nb = parseInt(b.replace(/^v/, ""), 10);
  return na - nb;
}

/** Internal tree name for a file: draft keeps the bare logical name. */
export function internalNameFor(logical: string, version: string | null): string {
  return version ? `${logical}.${version}` : logical;
}

// ── scanning ──────────────────────────────────────────────────────────

/** Every draft + snapshot file in the workspace, both kinds. */
export async function listTreeEntries(workspaceDir: string): Promise<VersionEntry[]> {
  const out: VersionEntry[] = [];

  const patternsDir = path.join(workspaceDir, PATTERNS_DIR);
  try {
    const files = await readdir(patternsDir);
    const present = new Set(files);
    for (const f of files) {
      const parsed = parsePatternFileName(f);
      if (!parsed) continue;
      const specName = f.replace(/\.mjs$/, ".spec.md");
      const hasSpec = present.has(specName);
      out.push({
        logical: parsed.logical,
        kind: "pattern",
        file: `${PATTERNS_DIR}/${f}`,
        abs: path.join(patternsDir, f),
        version: parsed.version,
        prod: parsed.prod,
        draft: parsed.version === null && !parsed.prod,
        specFile: hasSpec ? `${PATTERNS_DIR}/${specName}` : null,
        specAbs: hasSpec ? path.join(patternsDir, specName) : null,
      });
    }
  } catch {
    // no patterns directory
  }

  const appDir = path.join(workspaceDir, APP_DIR);
  try {
    for (const entry of await readdir(appDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(appDir, entry.name);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      const present = new Set(files);
      for (const f of files) {
        const parsed = parseAppTreeFileName(f);
        if (!parsed) continue;
        const specName = f.replace(/\.mjs$/, ".spec.md");
        const hasSpec = present.has(specName);
        out.push({
          logical: entry.name,
          kind: "app",
          file: `${APP_DIR}/${entry.name}/${f}`,
          abs: path.join(dir, f),
          version: parsed.version,
          prod: parsed.prod,
          draft: parsed.version === null && !parsed.prod,
          specFile: hasSpec ? `${APP_DIR}/${entry.name}/${specName}` : null,
          specAbs: hasSpec ? path.join(dir, specName) : null,
        });
      }
    }
  } catch {
    // no app directory
  }

  return out;
}

/** Group entries by logical tree and summarize versions. */
export async function scanTreeVersions(workspaceDir: string): Promise<TreeCatalogEntry[]> {
  const byLogical = new Map<string, VersionEntry[]>();
  for (const entry of await listTreeEntries(workspaceDir)) {
    const list = byLogical.get(entry.logical) ?? [];
    list.push(entry);
    byLogical.set(entry.logical, list);
  }
  const out: TreeCatalogEntry[] = [];
  for (const [logical, files] of byLogical) {
    const prod = files.find((f) => f.prod);
    const versions = files
      .map((f) => f.version)
      .filter((v): v is string => v !== null)
      .sort(compareVersions);
    const specVersions = files
      .filter((f) => f.specFile && f.version !== null)
      .map((f) => f.version as string)
      .sort(compareVersions);
    out.push({
      logical,
      kind: files[0].kind,
      draft: files.some((f) => f.draft),
      hasProd: !!prod,
      prodVersion: prod?.version ?? null,
      versions: [...new Set(versions)],
      specVersions: [...new Set(specVersions)],
      draftSpec: files.some((f) => f.draft && !!f.specFile),
    });
  }
  return out.sort((a, b) => a.logical.localeCompare(b.logical));
}

// ── ref resolution ────────────────────────────────────────────────────

/** Normalize a ref (`undefined`, `prod`, `draft`, `v3`, `@v3`) to its kind. */
export function normalizeRef(ref?: string | null): "prod" | "draft" | string {
  const raw = (ref ?? "").trim().replace(/^@/, "");
  if (!raw || raw === "prod") return "prod";
  if (raw === "draft") return "draft";
  return raw;
}

/**
 * Resolve a logical name + optional ref to a file on disk.
 *  - default / `prod` → the `.prod` snapshot, else the draft
 *  - `vN`             → the `vN` snapshot (prod or candidate)
 *  - `draft`          → the working file
 * Returns `null` when the tree (or the pinned version) does not exist.
 */
export async function resolveTreeEntry(
  workspaceDir: string,
  logical: string,
  ref?: string | null,
): Promise<ResolvedTree | null> {
  const entries = (await listTreeEntries(workspaceDir)).filter((e) => e.logical === logical);
  if (!entries.length) return null;

  const want = normalizeRef(ref);
  const draft = entries.find((e) => e.draft);
  const prod = entries.find((e) => e.prod);

  let entry: VersionEntry | undefined;
  if (want === "draft") entry = draft;
  else if (/^v[0-9]+$/.test(want)) entry = entries.find((e) => e.version === want && !e.draft);
  else entry = prod ?? draft;

  if (!entry) return null;
  return {
    logical,
    version: entry.version,
    prod: entry.prod,
    draft: entry.draft,
    kind: entry.kind,
    file: entry.file,
    abs: entry.abs,
    internalName: internalNameFor(logical, entry.version),
    specFile: entry.specFile,
    specAbs: entry.specAbs,
  };
}

// ── mutation (serialized per logical tree) ────────────────────────────

const locks = new Map<string, Promise<unknown>>();

/** Serialize version mutations for one logical tree (writes stay atomic). */
function withLock<T>(logical: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(logical) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const gate = run.then(
    () => {},
    () => {},
  );
  locks.set(logical, gate);
  return run.finally(() => {
    if (locks.get(logical) === gate) locks.delete(logical);
  }) as Promise<T>;
}

async function writeAtomic(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, { mode: 0o644 });
  await rename(tmp, abs);
}

function snapshotPath(logical: string, kind: TreeKind, version: string, prod: boolean): string {
  const suffix = prod ? ".prod" : "";
  if (kind === "app") return path.join(APP_DIR, logical, `${TREE_FILE}.${version}${suffix}.mjs`);
  return path.join(PATTERNS_DIR, `${logical}.${version}${suffix}.mjs`);
}

function nextVersion(entries: VersionEntry[]): string {
  const max = entries
    .map((e) => e.version)
    .filter((v): v is string => v !== null)
    .reduce((acc, v) => Math.max(acc, parseInt(v.replace(/^v/, ""), 10)), 0);
  return `v${max + 1}`;
}

export interface SnapshotResult {
  logical: string;
  version: string;
  file: string;
  /** Paired spec file captured with the snapshot, or null when none existed. */
  spec: string | null;
  /** False when an identical snapshot already existed (dedupe). */
  created: boolean;
}

/** Identity of a snapshot: its tree bytes plus its spec bytes. */
function snapshotHash(content: string, spec: string): string {
  return crypto.createHash("sha256").update(content).update("\0").update(spec).digest("hex");
}

/**
 * Snapshot the draft of `logical` into the next immutable version, capturing
 * its paired `.spec.md` (the behavior source of truth) alongside the `.mjs`.
 * Unchanged tree+spec returns the existing version id instead of a duplicate.
 */
export async function snapshotTree(
  workspaceDir: string,
  logical: string,
): Promise<SnapshotResult> {
  return withLock(logical, async () => {
    const entries = (await listTreeEntries(workspaceDir)).filter((e) => e.logical === logical);
    const draft = entries.find((e) => e.draft);
    if (!draft) throw new Error(`no draft to snapshot for '${logical}'`);

    const content = await readFile(draft.abs, "utf8");
    const spec = draft.specAbs ? await readFile(draft.specAbs, "utf8") : null;
    const hash = snapshotHash(content, spec ?? "");
    for (const entry of entries) {
      if (entry.draft) continue;
      try {
        const existing = await readFile(entry.abs, "utf8");
        const existingSpec = entry.specAbs ? await readFile(entry.specAbs, "utf8") : "";
        if (snapshotHash(existing, existingSpec) === hash) {
          return { logical, version: entry.version!, file: entry.file, spec: entry.specFile, created: false };
        }
      } catch {
        // unreadable snapshot: treat as absent
      }
    }

    const version = nextVersion(entries);
    const rel = snapshotPath(logical, draft.kind, version, false);
    await writeAtomic(path.join(workspaceDir, rel), content);
    let specRel: string | null = null;
    if (spec !== null) {
      specRel = specPathForTree(rel);
      await writeAtomic(path.join(workspaceDir, specRel), spec);
    }
    return { logical, version, file: rel, spec: specRel, created: true };
  });
}

/**
 * Promote a candidate version to production: rename it to `.prod` and demote
 * the previous prod back to a plain candidate. Internal names already match
 * their refs, so no session checkpoint is invalidated.
 */
export async function promoteTree(
  workspaceDir: string,
  logical: string,
  version: string,
): Promise<{ promoted: string; demoted: string | null }> {
  const want = normalizeRef(version);
  if (!/^v[0-9]+$/.test(want)) throw new Error(`not a version id: '${version}'`);

  return withLock(logical, async () => {
    const entries = (await listTreeEntries(workspaceDir)).filter((e) => e.logical === logical);
    const candidate = entries.find((e) => e.version === want && !e.prod);
    const current = entries.find((e) => e.prod);

    if (!candidate) {
      if (current?.version === want) return { promoted: want, demoted: null };
      throw new Error(`version '${want}' not found for '${logical}'`);
    }

    const kind = candidate.kind;
    const prodRel = snapshotPath(logical, kind, want, true);
    const candidateRel = snapshotPath(logical, kind, want, false);
    const abs = (rel: string) => path.join(workspaceDir, rel);

    // Demote first: the old prod moves to its own candidate filename, then
    // the candidate takes the prod name. Both targets are free. Each move
    // carries the version's paired `.spec.md` with it.
    let demoted: string | null = null;
    if (current && current.version && current.version !== want) {
      const demoteRel = snapshotPath(logical, kind, current.version, false);
      await rename(abs(current.file), abs(demoteRel));
      if (current.specAbs) await rename(current.specAbs, abs(specPathForTree(demoteRel)));
      demoted = current.version;
    } else if (current && current.version === null) {
      // A bare `.prod` with no version: drop it out of the way.
      await unlink(abs(current.file));
      if (current.specAbs) await unlink(current.specAbs);
    }

    await rename(abs(candidateRel), abs(prodRel));
    if (candidate.specAbs) await rename(candidate.specAbs, abs(specPathForTree(prodRel)));
    return { promoted: want, demoted };
  });
}

/**
 * Prune old snapshots: keep prod, the newest `keep` versions, and anything
 * pinned by a live session. Returns the version ids removed.
 */
export async function pruneVersions(
  workspaceDir: string,
  logical: string,
  keep: number = KEEP_VERSIONS,
  protectedVersions: string[] = [],
): Promise<string[]> {
  return withLock(logical, async () => {
    const entries = (await listTreeEntries(workspaceDir)).filter((e) => e.logical === logical);
    const protectedSet = new Set(protectedVersions.map((v) => normalizeRef(v)));
    const versions = [...new Set(entries.map((e) => e.version).filter((v): v is string => v !== null))].sort(
      compareVersions,
    );
    // `slice(-0)` is the whole array, so keep=0 must be special-cased.
    const keepCount = Math.max(0, keep);
    const keepSet = new Set(keepCount === 0 ? [] : versions.slice(-keepCount));
    const removed: string[] = [];
    for (const entry of entries) {
      if (entry.draft || entry.version === null) continue;
      if (entry.prod) continue;
      if (keepSet.has(entry.version)) continue;
      if (protectedSet.has(entry.version)) continue;
      await unlink(entry.abs);
      if (entry.specAbs) await unlink(entry.specAbs);
      // Only report a version once, even though each has one file.
      if (!removed.includes(entry.version)) removed.push(entry.version);
    }
    return removed;
  });
}
