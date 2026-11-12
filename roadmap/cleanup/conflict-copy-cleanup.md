# Conflict-copy cleanup / retention

**Status:** open
**Created:** 2026-11-08
**Updated:** 2026-11-08
**Context:** replica sync preserves the losing bytes of a same-path conflict as
`<path>.conflict-<timestamp>` (`docs/pairing-and-sync.md` §3). The files are
deliberately excluded from sync by `web/src/sync/hashmap.ts`, but nothing ever
removes them. This note covers inventory, manual cleanup, and an optional
retention policy.

---

## Current behaviour

- `web/src/sync/engine.ts` writes a conflict copy in `applyRemoteWrite()` and in
  the equal-lamport push path. There is no cleanup call after a round.
- `web/src/sync/hashmap.ts` excludes `/\.conflict-[0-9T-]+$/` from both the
  outbound map and incoming ops, so copies never round-trip between replicas.
- The Sync dialog's conflict counter (`web/src/sync-ui.ts`) is the in-memory
  list for the current round; it is not a persisted inventory and has no
  actions.
- The same pattern is used by seed-version conflicts
  (`.seeded.conflict-*`, `.seed-sha.conflict-*`) and DB-dump conflicts
  (`db/*.db.sql.conflict-*`).
- Because the paths are excluded from sync, cleanup is **per replica**:
  deleting a copy in the desktop mirror does not delete the browser's copy,
  and vice versa.

Observed snapshot on 2026-11-08 (counts change as syncs run):

| Replica | Conflict copies |
|---|---:|
| `centre` desktop mirror | 3 |
| `centre` browser OPFS | 60 |
| `php` desktop mirror | 161 |
| `php-responses` desktop mirror | 99 |
| `socials` desktop mirror | 65 |
| `linkedin` desktop mirror | 31 |
| `seed` desktop mirror | 0 |

The `centre` mirror dropped from 127 to 3 during the same session, but there
are no delete tombstones for those paths in
`~/.bobkat/peers/centre/.gpb-sync/journal.jsonl`; that was not a sync-engine
GC. Treat these numbers as a snapshot, not a stable total.

## Problem

1. Conflict copies are the only copy of the losing bytes; silently deleting
   them loses recovery data.
2. They are never surfaced outside the per-round counter, so users cannot see
   what is accumulating.
3. Repeated conflicts on the same path (a stale replica or a bad journal) keep
   adding copies with no bound.
4. The current design has no answer for "is it safe to delete this?" other than
   reading the file and comparing it manually.

## Proposed feature

### 1. Shared inventory (browser + Node)

Add `web/src/sync/conflicts.ts` (shared, imports only `Platform` and the sync
helpers; `web/src` must not import `src/`):

```ts
interface ConflictFile {
  path: string;        // workspace-relative, e.g. app/knit/tools.mjs.conflict-…
  base: string;        // path without the conflict suffix
  stamp: string;       // timestamp from the name
  bytes: number;
  hash: string;        // content hash for duplicate detection
  mtimeMs: number;
}

listConflictCopies(platform: Platform): Promise<ConflictFile[]>

cleanConflictCopies(platform: Platform, opts: {
  dryRun?: boolean;
  olderThanMs?: number;       // by mtime or name stamp
  dedupe?: boolean;           // keep one copy per (base, hash)
  keepPerPath?: number;       // newest N per base
  include?: ("app" | "patterns" | "db" | "seed" | "other")[];
  confirm?: boolean;
}): Promise<{
  scanned: number;
  groups: number;
  unique: number;
  duplicates: number;
  bytes: number;
  removed: number;
  bytesRemoved: number;
  errors: string[];
}>
```

Implementation notes:

- Walk the workspace with `platform.fs`, not `buildHashmap` (which excludes the
  copies).
- Only regular files whose name matches `\.conflict-[0-9T-]+$`; skip
  directories, symlinks, and paths outside the workspace.
- Reuse the existing byte hash (`hashBytes`/`sha256hex`) so duplicate detection
  matches sync hashes.
- Dedupe by `(base, hash)`: identical bytes for the same original path are
  interchangeable. Do not dedupe across different base paths without an
  explicit option.
- `olderThanMs` uses the file mtime; fall back to the timestamp in the name
  when mtime is unavailable.
- `dryRun` is the default for the CLI; `confirm` is required for any actual
  removal in code.

### 2. Desktop CLI

`scripts/clean-conflicts.ts` using `createNodePlatform(folder)` from
`src/platform/node.ts`:

```sh
npm run clean:conflicts -- --workspace ~/.bobkat/folders/centre
npm run clean:conflicts -- --workspace ~/.bobkat/folders/centre --dedupe --yes
npm run clean:conflicts -- --workspace ~/.bobkat/folders/centre --older-than 30d --yes
```

- Default invocation is a dry run: count, bytes, groups, duplicate hashes, and
  the ten largest copies.
- `--yes` is required to delete; the command prints what it will remove first.
- `--json` for scripts/tests.
- Handle errors per file and keep going; report the failures.

### 3. Browser action

Add a **Conflict copies** row to Sync… → Live sync → Diagnostics (next to the
existing conflict count):

```
Conflict copies: 60 · 2.1 MB   [Review…]
```

The Review modal lists groups by base path with timestamp, size, and duplicate
badge; actions:

- **Remove identical duplicates** (safe, keeps one per base+hash)
- **Remove older than…** (30 days / 90 days / all)
- **Remove selected**
- Always shows the count and bytes before confirmation; no silent deletion.

The modal uses `listConflictCopies` / `cleanConflictCopies` through the worker
or the page's platform, so the browser OPFS and desktop mirror use the same
rules. The existing in-memory `state.conflicts` remains the round indicator;
the inventory is a separate persisted scan when the dialog opens.

### 4. Retention (optional, off by default)

Do **not** auto-delete unique copies in v1. If retention is wanted later:

- setting: `conflicts.retentionDays` (default `0` = disabled) and
  `conflicts.autoDedupe` (default `false`)
- run after a successful sync round or on boot, never in the middle of one
- only dedupe identical copies automatically; age-based deletion stays manual
- report removals via the normal emit/log path, not silently

The reason for caution: a conflict copy is the only record of the losing side.
Automatic age cleanup is a data-loss policy, not housekeeping.

## Safety rules

- Never touch a path that does not match the conflict suffix.
- Cleanup deletions are local: `noteMutation` already skips excluded paths, so
  no tombstone or remote delete is produced.
- Keep at least one copy per `(base, hash)` unless the user explicitly chooses
  "remove all".
- Treat DB-dump conflicts (`db/*.db.sql.conflict-*`) and seed conflicts
  (`.seeded.conflict-*`, `.seed-sha.conflict-*`) as separate categories in the
  UI; a DB dump may be the only recoverable snapshot.
- Do not use `buildHashmap` to find them; it excludes them by design.
- Do not run cleanup while a file is being written by sync; take the inventory
  first, confirm, then remove. Missing files during removal are not errors.
- Conflict cleanup does not prevent future conflicts. Repeated copies on one
  path mean a stale replica or a journal issue; that is a separate
  investigation.

## Acceptance

- A dry run reports the same count as `find <workspace> -name '*.conflict-*'`
  and reports bytes without deleting anything.
- Dedupe removes only byte-identical copies for the same base path and keeps
  one representative; unique copies remain.
- Age-based cleanup uses mtime/timestamp and never removes a copy newer than
  the cutoff.
- The same inventory/cleanup logic runs in the browser and in the Node CLI.
- Cleaning one replica does not change another replica and produces no sync
  ops/tombstones for the removed paths.
- The UI shows the before/after count and bytes, and requires confirmation.
- Tests cover: matcher, base/stamp parsing, dedupe, cutoff, skip symlinks,
  per-file errors, and a dry run that removes nothing.
- `npm run test:standalone` still holds (`web/src` imports nothing from
  `src/`).

**Estimate:** ~1–1.5 focused days for inventory + CLI + tests, plus ~0.5 day
for the browser modal. Retention (optional) is another ~0.5 day.

## Open questions

1. **Default policy:** manual-only cleanup vs automatic dedupe. Recommendation:
   manual-only for v1; automatic dedupe is safe but still surprising.
2. **Scope:** include `db/` and `.seeded` conflicts in the first version, or
   start with `app/` + `patterns/`? Recommendation: include all, but group
   them and default the destructive action to app/pattern copies.
3. **Where the browser count lives:** Sync dialog diagnostics vs Settings →
   Storage. Sync is the natural place because it explains why the copies exist.
4. **Keep newest per path:** useful for repeated identical conflicts, but it
   destroys older distinct versions; expose it only as an explicit option.
5. **Should the cleanup action be available on the desktop mirror from the
   browser?** The mirror is machine-local and not part of sync; the CLI is the
   safer surface. Do not add a remote delete op for it.

## References

- `docs/pairing-and-sync.md` — conflict preservation and exclusion from sync.
- `feature-plans/standalone-only.md` — the rule that conflict copies are
  sync-generated and excluded.
- `web/src/sync/engine.ts` — `conflictCopyOf`, `applyRemoteWrite`.
- `web/src/sync/hashmap.ts` — `EXCLUDED` / `excluded()`.
- `web/src/sync-ui.ts` — the existing conflict counter.
- `src/platform/node.ts` — `createNodePlatform` for the CLI.
