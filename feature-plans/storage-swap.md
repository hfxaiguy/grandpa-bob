# Feature plan — storage swap: profile archives and database transport

Status as of 2026-10-27. **Proposal only; no code changed.** Scope: the
`WorkspaceArchive` v1 envelope shared by browser profile export/import,
`make-seed` and seed boot, BobSwap publish/fetch, and the relay. Out of scope:
the live storage engine (OPFS / sqlite-wasm), the git database-sync protocol,
and profile migration.

Decision in one line: **keep v1 JSON for compatibility, add a v2 ZIP container
for export/seeds, and keep databases as native SQLite images (stored, not
base64-inflated); SQL text dumps stay a git-sync tool, not a backup format.**

---

## Current state

`WorkspaceArchive` v1 (`web/src/workspace-transfer.ts:14-18`) is:

```json
{
  "version": 1,
  "createdAt": "2026-10-27T…",
  "files": [{ "path": "workspace/…", "base64": "…" }]
}
```

Every consumer uses the same shape:

| Consumer | Code | Transport |
|---|---|---|
| Profile export/import | `web/src/main.ts`, `web/src/profile-ui.ts` | `.json` download / file input |
| `make-seed` | `web/scripts/make-seed.mjs` | `web/public/seed/workspace.json` |
| Browser seed boot | `web/src/main.ts:296-319` | `fetch("/seed/workspace.json")` |
| BobSwap seed shelf | `web/src/swap.ts:228-300` | `application/json` PUT/GET |
| BobSwap relay | `web/src/swap.ts:604-723` | JSON frames, base64 chunks |
| Git app-DB sync | `src/db-sync.ts` | separate `db/<name>.db.sql` text files |

### Why JSON + base64 today

- **Browser-native and dependency-free.** Export runs in the tab; there is no
  Node filesystem or archive library. `JSON.parse`/`JSON.stringify`, `btoa`/
  `atob`, `Blob` and `fetch` are enough.
- **One format for every path.** A `make-seed` archive can be imported into a
  profile; a profile export can be published as a seed; the relay carries the
  same bytes. There is one validator (`validateWorkspaceArchive`) and one
  import merge.
- **Binary-safe.** `.db` files and run-log snapshots survive because every file
  is base64 in the JSON array.
- **Exact-byte hashing.** Seed freshness and relay verification hash the exact
  JSON bytes (`seed-version.ts`, `swap.ts:282-300`); no normalisation step.

### What it costs

`web/README.md:368-369` already records the tradeoff: base64 is about **one
third larger** than the workspace, and the archive is built and parsed
**entirely in memory**. There is no compression and no streaming. JSON syntax
adds a little more, especially for many small files.

This is a deliberate tradeoff, not an accident. Any replacement must preserve
the one-format property or explicitly version the split.

---

## How databases travel today

The archive container and the database serialization are independent: every
`.db` is still a normal SQLite file; base64 is only how it is embedded in v1.

### App databases (`*.db`)

They are collected like any other file (`collect()` in
`web/src/workspace-transfer.ts:94-112`), so the archive carries the **raw SQLite
page image** base64-encoded. Import writes those bytes back and reloads the tab;
the sqlite worker then opens the file normally
(`web/src/platform/sqlite-worker.ts`). This is byte-for-byte restore, not a
logical replay. (The git sync in `src/db-sync.ts` is narrower: it handles only
workspace-root `*.db` files.)

### Run log (`logs/grandma-kat.db`)

The streaming VFS keeps its internal layout under `.gpb-runlog`, so copying
OPFS files is not a valid SQLite image. `buildBrowserArchive` excludes that
directory and appends a logical snapshot produced by
`sqlite3_js_db_export` (`web/src/agent/log-store.ts:526-535`,
`web/src/platform/sqlite-worker.ts:420-428`). Import stages the snapshot and
the next boot migrates it into the pool. This is still a binary SQLite image,
not SQL text.

### The SQL-text alternative already exists — for git sync

`src/db-sync.ts` serializes root-level app DBs to deterministic SQL:

- `dumpDatabase()` writes DROP/CREATE statements, then one `INSERT` per row in
  rowid order, then `sqlite_sequence` (`src/db-sync.ts:98-156`).
- `writeDatabaseDumps()` writes `db/<name>.db.sql`.
- `applyDatabaseDumps()` replays a dump after pull, with conflict detection so a
  dirty local DB is not silently overwritten (`src/db-sync.ts:267-311`).
- It intentionally excludes `logs/grandma-kat.db`: append-only and large
  (`src/db-sync.ts:17-18`).

It is the right tool for **git-diffable, last-writer-wins app-DB sync**. It is
not the right tool for profile backup/restore:

- **Not fully faithful.** Virtual-table rows are excluded from the row dump
  (only the `CREATE VIRTUAL TABLE` statement is replayed), and an arbitrary
  third-party schema is not guaranteed to round-trip exactly. A backup must
  restore exactly what was there.
- **Usually larger for binary data.** BLOBs become hex literals (`X'…'`, 2× the
  raw bytes) versus base64's ~1.33×, plus per-row SQL overhead.
- **Slower and more fragile to restore.** Replay needs a live SQLite engine,
  correct statement ordering, and transaction handling. Writing the image is
  just a file write.
- **Different semantics.** Import is a path-level merge/replace; DB dumps would
  require DB-aware replay and conflict policy. That is a sync feature, not a
  backup feature.
- **Coverage.** `listSyncDatabases()` only sees workspace-root `*.db`; nested
  DBs and the run log are out of scope.

One consequence worth noting: because `db/` is inside the workspace, a v1
archive can already contain **both** `foo.db` and `db/foo.db.sql`. The dump is
redundant in a backup; v2 should not add another copy.

---

## Options

| Option | What changes | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Status quo** | None | Zero work; proven; one format | +33% for every binary; in-memory only; no compression | Keep as fallback/import path |
| **B. v2 ZIP** | New container: `manifest.json` + native file entries | Removes base64 overhead; deflates text; DBs stay exact; standard tooling | New dependency; new validator; BobSwap binary contract; old readers cannot open it | **Recommended** |
| **C. Gzip the JSON** | `.json.gz` or `Content-Encoding: gzip` | No format redesign; network/disk shrink; JSON unchanged after inflate | Still base64 in memory; still whole-file parse; not a smaller *unpacked* backup | Cheap interim only |
| **D. SQL dumps in the archive** | DB entries become `.sql` | Human-readable/diffable; reuses `db-sync.ts` | Lossy for virtual tables; larger BLOBs; slow replay; DB-aware import required | No for backups |
| **E. Manifest + separate binary parts** | JSON manifest plus multipart/individual DB blobs | No base64 for DBs; can stream large DBs | Two-phase transfer/atomicity; service changes; more code paths | Only if streaming is required |
| **F. Out-of-band large DBs** | Exclude logs from seeds/publish, or upload to object storage and reference | Tiny seeds; fast; privacy win | Not a full backup; external dependency; restore ordering | Pair with B for publish, not for backup |

### Recommendation

1. **Keep v1 import indefinitely.** It is cheap, already tested, and old seeds
   and devices depend on it.
2. **Add v2 as a ZIP container.** Store `.db` entries as native files (likely
   ZIP "store", no deflate), deflate text/JS/JSON/Markdown, and keep
   `workspace/...` paths unchanged so the existing merge semantics survive.
3. **Keep raw SQLite images for databases.** Optionally checkpoint/VACUUM before
   snapshotting. Do not replace them with SQL dumps in backups.
4. **Roll out in stages:** profile export first, then seed packing/boot, then
   BobSwap upload/relay once the service's binary content-type support is
   confirmed.
5. **Measure before committing to the library.** Phase 0 below decides whether
   the size win justifies the dependency and code.

The base64 problem and the DB-format problem are independent. ZIP solves the
first; SQLite's own image is already the right answer for the second.

---

## v2 design sketch

### Container layout

```text
bob-workspace-2026-10-27.zip
├── manifest.json                 { format, version: 2, createdAt, generator }
└── workspace/
    ├── app/…
    ├── patterns/…
    ├── lib/…
    ├── *.db                      native SQLite images
    └── logs/grandma-kat.db       logical snapshot (not .gpb-runlog)
```

Paths stay `workspace/...`, matching v1, so an archive remains importable into
any profile, device, or seed shelf.

### Detection and validation

- Detect by bytes, not filename: first non-whitespace `{` → v1 JSON; `PK\x03\x04`
  → v2 ZIP; anything else → a clear "not a workspace archive" error.
- Keep `validateWorkspaceArchive()` for v1. Add a ZIP validator that:
  - requires `manifest.json` with `format`/`version`;
  - rejects absolute paths, `..` segments, backslashes, duplicate entries, and
    symlinks;
  - caps uncompressed size and entry count (zip-bomb guard);
  - ignores directory entries and `manifest.json` when building the internal
    `WorkspaceArchive`.
- Import remains a merge: same-path entries are overwritten, files the archive
  lacks are kept; `.gpb-runlog` stays excluded; `.seeded` backfill is unchanged.

### Database policy

- **App DBs:** native ZIP entries, stored rather than deflated unless a
  measurement shows deflate helps. This is exact and fast.
- **Run log:** keep the current logical snapshot. Never archive
  `.gpb-runlog` internals.
- **Optional compaction:** call `VACUUM` (or `VACUUM INTO`) before exporting an
  app DB where the platform supports it; the run log already compacts through
  `runlog-retention.ts`. This is an independent size win and can land before v2.
- **Git dumps:** `db/*.sql` are ordinary files; they can be included as text but
  are not a substitute for the `.db` image.

### Hashing, freshness, and metadata

- Hash the exact container bytes (ZIP file or JSON file), as today.
- Extend seed `meta.json` with `format` (`"json-v1"` | `"zip-v2"`) and the file
  name. Boot reads `meta.json` first and chooses the matching file; it must not
  guess between `workspace.json` and `workspace.zip`.
- `.seed-sha` written at apply time records the container hash. A format change
  naturally looks like a new seed once; document that so it is not mistaken for
  seed drift.
- Relay channel metadata (`size`, `sha256`, `file_count`) continues to describe
  the bytes actually transported.

### Transport

- **Profile download:** `.zip`, `application/zip`.
- **File input:** accept both `.json` and `.zip`; detect by content.
- **BobSwap publish/fetch:** current client sends `application/json` and reads
  `res.text()` (`web/src/swap.ts:240-251, 282-298`). ZIP requires the service to
  accept `application/zip` or `application/octet-stream`; confirm against
  `/docs/agents` before implementing. If it cannot, keep v1 on the shelf and use
  v2 only for local export until the contract changes.
- **Relay:** the realtime frame format is JSON with base64 chunks
  (`swap.ts:500, 604-605, 722-723`). A ZIP archive can still be chunked as
  base64; the payload is smaller than v1, so this is a net win, but it does not
  remove base64 from the relay itself. Binary frames are a separate protocol
  change and not required for v2.

### Compatibility matrix

| Reader | v1 JSON | v2 ZIP |
|---|---|---|
| Current (before this work) | yes | no |
| New | yes | yes |

Exporting v2 to an older tab/device will fail its import. Either ship both
readers together (preferred, since the web app updates as a unit) or keep v1 as
the default export until the seed/relay consumers are upgraded.

---

## Work breakdown

### Phase 0 — measure and confirm (no format change)

- [ ] Add a throwaway benchmark (or extend `scripts/workspace-transfer-test.ts`)
      that reports, for a representative profile: raw workspace bytes, v1 JSON,
      JSON gzip, ZIP store, ZIP deflate-text.
- [ ] Record the size and build-time delta; decide whether v2 is worth it.
- [ ] Confirm BobSwap's accepted content types from `/docs/agents`; record the
      answer in this file.
- [ ] Confirm the standalone server serves `.zip` with a usable MIME type
      (not strictly required for `arrayBuffer`, but good for downloads).

**Acceptance:** numbers in this plan; a go/no-go on ZIP and on BobSwap binary
upload.

### Phase 1 — v2 writer and profile export

- [ ] Add one small ZIP implementation/dependency (evaluate `fflate` first for
      bundle size; `zip.js` only if streaming/worker support is needed).
- [ ] Add `buildWorkspaceZipArchive()` / `archiveToZipBlob()` alongside the v1
      functions in `web/src/workspace-transfer.ts`.
- [ ] Keep `WorkspaceArchive` as the in-memory model; the ZIP layer only
      serialises/deserialises it.
- [ ] Add a format preference in the export UI (or default to ZIP with a
      "legacy JSON" option).
- [ ] Preserve the run-log snapshot and `.gpb-runlog` exclusion.

**Files:** `web/src/workspace-transfer.ts`, `web/src/main.ts`,
`web/src/profile-ui.ts`, `web/index.html`, `web/package.json`.
**Acceptance:** exporting a profile produces a ZIP that contains the same file
set as v1, including DBs and the log snapshot; a v1 import still works.

### Phase 2 — v2 reader and round-trip tests

- [ ] Add format detection, ZIP validation, and an import path that reconstructs
      `WorkspaceArchive`.
- [ ] Reject path traversal, duplicate entries, symlinks, and oversized/unusual
      archives before touching OPFS.
- [ ] Extend `scripts/workspace-transfer-test.ts`:
      - binary round-trip (BLOB bytes unchanged);
      - v1 → v2 and v2 → import equivalence;
      - traversal and malformed-manifest rejection;
      - merge semantics (archive files overwrite, unlisted files survive).
- [ ] Extend `web/scripts/profile-smoke.mjs` to download/import a real ZIP and
      verify the file count/scope assertions still hold.

**Acceptance:** v1 and v2 archives restore to the same workspace; a hostile ZIP
is rejected without writes; `npm run test:workspace-transfer` and
`npm run smoke:profiles` pass.

### Phase 3 — seeds and `make-seed`

- [ ] Teach `make-seed` to write a v2 ZIP (opt-in first:
      `--format zip`), with `meta.json` carrying `format`, `sha256`, `size`.
- [ ] Update boot to read `seed/meta.json` first and fetch the named file; keep
      the v1 JSON fallback.
- [ ] Update `scripts/publish-seed.ts` and `web/scripts/serve.mjs` for the new
      filename/MIME and exact-byte hashing.
- [ ] Keep the curated content selection unchanged (`app/`, `patterns/`, `lib/`,
      empty run log, models template); v2 is only a container swap.

**Files:** `web/scripts/make-seed.mjs`, `web/src/main.ts`,
`web/src/seed-version.ts`, `scripts/publish-seed.ts`, `package.json`.
**Acceptance:** a fresh profile boots from a ZIP seed; the update banner appears
when the ZIP changes; a v1 seed still boots; `npm run smoke:seed-update` passes.

### Phase 4 — BobSwap and relay

- [ ] If the service accepts binary: publish/fetch ZIP with
      `content-type: application/zip`, hash the exact bytes, and use
      `arrayBuffer()` instead of `text()`.
- [ ] If not: keep JSON uploads for now; document the limitation and revisit.
- [ ] For relay, feed the ZIP bytes through the existing base64 chunk framing;
      keep the 192 KiB input chunks and sha check. Binary frames are explicitly
      out of scope.
- [ ] Add a v2 relay smoke (fake bus or two-profile browser test) asserting the
      receiver restores the same file set and DB integrity.

**Files:** `web/src/swap.ts`, `web/src/profile-ui.ts`,
`web/scripts/relay-protocol-test.mjs` (when it exists).
**Acceptance:** publish → fetch → import preserves DBs and log; relay of a
5 MB workspace succeeds with matching sha; no base64 regression in the frame
protocol.

### Phase 5 — docs and deprecation

- [ ] Update `web/README.md` → "Workspace backup and restore" and the seed
      sections: format, size expectations, compatibility.
- [ ] Update `CHANGELOG.md` when the format ships.
- [ ] Decide whether v1 export stays as an option or becomes import-only after
      one release.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| ZIP dependency grows the bundle | Prefer a small library; v2 is lazy-loaded only on export/import if needed |
| Peak memory: raw + ZIP + base64 for relay | Build the ZIP once; avoid retaining v1 JSON; stream to a Blob if measurements show pressure; relay from the ZIP bytes directly |
| Zip-slip / zip bomb | Central validation before any OPFS write: no `..`, absolute paths, symlinks, duplicate names; cap entries and uncompressed bytes |
| Hashing drift between formats | `meta.json` records `format` + exact-byte sha; boot selects by `format`, never by trying both blindly |
| Old clients cannot read v2 | Ship reader and writer together; keep v1 import; document the export compatibility floor |
| BobSwap only accepts JSON | Keep v1 upload until the service contract supports binary; do not base64-wrap ZIP (defeats the purpose) |
| SQLite image is larger than expected | Measure; SQLite pages often contain compressible text, so try deflate on `.db` in Phase 0 and decide per extension |
| Archive includes both `.db` and `db/*.sql` | Treat dumps as ordinary text; do not let them replace the authoritative DB image |

---

## Open decisions

1. **Is the size win material?** Phase 0 decides. If the profile is mostly
   SQLite images and they do not compress, ZIP still removes ~25% of the
   encoded size, but the absolute win may not justify a new reader.
2. **BobSwap binary support.** If it is JSON-only, v2 remains a local/seed
   format and the shelf stays v1.
3. **Default export format.** ZIP by default with a legacy JSON option, or
   JSON by default until seeds/relay also move?
4. **Compression policy.** Store all `.db` entries vs. deflate everything and
   measure; the latter is simpler but may waste CPU on incompressible pages.
5. **Run log in exports.** Keep it by default for a true profile backup, or
   exclude it like publish does (privacy and size)? This is the same question
   as P0-B in `bob-profiles-seeds-relay-remaining.md`.
6. **Streaming requirement.** Is an in-memory ZIP acceptable indefinitely, or
   do large profiles require a streaming writer/reader (`zip.js`/File System
   Access API)? Current v1 is already in-memory, so v2 is not a regression.
7. **SQL dump uptake.** If app DBs ever need mergeable backups, revisit SQL
   dumps as an *additional* `db/*.sql` entry, not as a replacement for the
   `.db` image.

---

## References

- `web/src/workspace-transfer.ts` — v1 model, base64, build/import, platform
  archive.
- `web/src/swap.ts` — seed shelf, content hashing, relay framing.
- `web/src/agent/log-store.ts` — run-log snapshot.
- `web/src/platform/sqlite-worker.ts` — `sqlite3_js_db_export`,
  `MAX_MEMORY_DB_BYTES`.
- `src/db-sync.ts` — SQL dump/replay used by git sync.
- `web/scripts/make-seed.mjs` — curated seed contents and `meta.json`.
- `web/README.md` — "Workspace backup and restore", "Workspace profiles",
  "Seed sources".
- `web/README.md:368-369` — documented JSON/base64 size and memory tradeoff.
