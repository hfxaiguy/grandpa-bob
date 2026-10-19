# Changelog

Newest first. One dated section per change.

## 2026-10-19 — a pattern picked from the dropdown loads by name, not by raw path

The pattern picker sends a logical name (`context_manager`, optionally
`name@draft`), while boot detection sends a workspace path
(`patterns/trunk.mjs`). The agent worker treated every value as a path, so
switching patterns in the UI made the module loader open
`<workspace>/context_manager` and every turn failed with
`cannot load pattern context_manager: ENOENT`. `resolvePatternPath()` now
resolves bare names through the version-aware tree catalog
(`context_manager` → `patterns/context_manager.prod.mjs`) and passes real paths
through unchanged; the session key uses the resolved file so the same pattern
picked by name or path shares one conversation. `test:pattern-path` pins the
name/ref/path/empty/missing cases, and the misleading "is the workspace
seeded?" hint is gone from the load error.

## 2026-10-19 — header upload button: put files into the workspace from the browser

The tiled UI header (shared by the web UI and the Node admin UI) has an
**upload** button: a normal OS file picker (multi-select), then a prompt for the
destination folder — pre-filled with the last one used and suggested from the
folders already in the workspace. Each file POSTs to the existing
`/api/files/upload`, so it lands wherever the active storage backend writes:
the picked real folder in direct mode, the OPFS sandbox, the storage bridge, or
the Node workspace. The folder may not contain `..`.

`smoke:browser` and `smoke:direct` now drive the button end to end (file →
prompt → upload) and assert the file arrives under the chosen folder.

## 2026-10-19 — the browser UI is the main interface, and it can use the real folder

The web target (`web/`) is now what `http://<host>:8080` serves (the legacy
`ui/dist` remains only as a fallback when `web/dist` is missing), and `npm run
build` builds it. Telegram is unchanged.

New storage mode **Desktop (direct folder)**: a File System Access adapter
(`web/src/platform/fsaccess.ts`) lets the fully client-side UI read and write a
real folder on the hard drive **in place, with no server process**. The picked
handle is persisted in IndexedDB and re-granted with one click after a reload.
The handle-backed filesystem is shared with OPFS (`handle-fs.ts`), so patterns,
tree versions, the file browser, virtual coreutils and `git_status` follow the
selected storage automatically; isomorphic-git commits are now proven over a
real folder (`scripts/fsaccess-test.ts`, `npm run test:fsaccess`).

SQLite follows the same seam: the sqlite worker can be pointed at the picked
folder and imports/exports the real `.db` files. Direct mode is read-only for
app databases by default (`SQL writes` in the toolbar enables write-back);
`logs/grandma-kat.db` stays writable. Firefox keeps using the existing loopback
storage bridge, which implements the same Platform interface.

Voice in the web UI no longer needs a server: `/api/transcribe` runs whisper in
the tab with Transformers.js (WebGPU when available, WASM otherwise; the model
is downloaded once and cached). The Vulkan whisper-server is still what Telegram
voice notes use.

## 2026-10-15 — promoting an app tree now drops a paused session that depended on it

The session staleness hash (`resumeHash`) covers only the root pattern's
skeleton. A tree attached **by name** — `From("contacts")`, or an app tree the
trunk calls as a tool — is resolved from disk at run time and never appears in
that skeleton, so promoting or editing it while a session was paused resumed
the session against changed code (or died on a stale sub-tree name). The live
log shows a caller-list walk failing with `cannot resume: tree '' is not
registered`.

A waiting result now carries `treePath` — the paused stack's `branch_path`
(grandma-kat). The agent persists it and a **content signature** of its named
segments: each non-auto segment (`#` marks a positional auto-name, covered by
its parent) is loaded and hashed with `resumeHash`. On the next turn the
signature is recomputed from the current files; a change drops the session with
"a tree it depends on changed since it paused" and grows a fresh tree, instead
of resuming into it. `test:sessions` pins it (edit a ported leaf, the pause
drops; without the check the session resumes into the stale tree).

The engine-side recovery for a genuinely stale name is the companion change in
grandma-kat (resume re-derives a level from its parent's child index).

## 2026-10-15 — a resume that cannot rebuild its tree starts fresh instead of erroring

A paused session resumes by rebuilding the tree stack named in its checkpoint.
When that stack can no longer be rebuilt — a stale sub-tree auto-name, or an
app/pattern tree edited or re-versioned while the session was paused —
grandma-kat throws `cannot resume: tree '…' is not registered`. The resume
guard only recognised `/checkpoint/i` (a missing checkpoint row), so this error
escaped as-is and reached the user: the live log shows a caller-list walk dying
with `status:"error"` on the input "number not in service".

The guard now also treats `cannot resume` as a dead checkpoint via
`isDroppableContinuationError()`: the continuation is dropped, the drop is
announced with a position-specific reason, and the turn grows a fresh tree and
delivers the message. `test:sessions` pins the predicate (droppable vs a real
failure such as a missing `Needs` slot).

The engine-side cause of the empty-name variant is fixed in grandma-kat
(`loadNamedTree` auto-names a registry fallback); this guard is the safety net
for the general resume-resolution failure.

## 2026-10-15 — the served index is read per request: `build:ui` while running no longer 404s the page

`startAdmin` read `ui/dist/index.html` once at startup. A `build:ui` while the
server was up (a manual build, or any other checkout's build) rewrote the index
to new content hashes and deleted the old files from `ui/dist/assets/`, so the
running server kept serving HTML that referenced deleted bundles — every asset
404'd (`/assets/index-*.css`) and the page stayed blank until a restart.

The index is now read at request time (the page was already served `no-store`),
so the next reload picks up the fresh HTML and its live assets; a first build
appearing after startup is picked up the same way. `test:ui-serve` pins it: a
rebuild mid-run serves the new marker and its bundle, and the replaced bundle
is gone.

## 2026-10-15 — message provenance: every bot bubble answers "what was this written from?"

Each bot bubble in the tiled UI now has an ⓘ button. It opens a **written
from** panel built from the run log (`src/provenance.ts` + `GET
/api/provenance`): the prompt that produced the message, the **memory slots
and other pieces it read**, who wrote each piece, the ground facts, `ref://`
handles, and a **view prompt** expander showing the exact messages sent.
"Trace deeper" walks the read-graph one level per click (depth 6 max,
breadth-capped at 60 pieces).

How the anchor is found: the message's text is traced through the `record`
rows that carried it (a prompt's result, a Memory() capture) to the `llm_call`
whose output matches — following the causal chain, not just the nearest call;
when no exact match exists the nearest prompt is shown and **flagged as
uncertain**. From there the walk uses the engine's own `reads` provenance
(`{ name, scope, seq }` on every llm_call and memory write):
`read-link` (the write row the read named), `latest-write` (a slot written
before a resume, so the read carries no seq — the latest memory write for the
same run + scope fills in, so `state`/`priorities`/etc. show real values
instead of "no write recorded"), `human` (a delivered `.human()` row, which
carries no write link), or `host-seed`. Both fallbacks stay inside the read's
own run, so another conversation's identically named slot never leaks in.

UI: `ui/src/components.tsx` (the ⓘ button and the modal), `store.ts`
(`fetchProvenance`), `styles.css`. The bubble→log-row alignment goes through
the turn's `(fromSeq, toSeq]` bounds + run id, so a bubble re-run/rewound mid
pass anchors on its **last** matching emit. The SSE `event`/`turn_end` frames
now carry the turn's `runId` too, so a bubble's icon appears as soon as the
engine run behind it exists; machine narration bubbles and turns with no
recorded run (old markers, never-ran turns) get no icon, and a stale click
still gets a clean 404 message.

Tests: `test:provenance` — one real tree through the Agent (memory writes →
prompt → emits, machine narration included), asserting the exact-text anchor,
the pieces and their writers, the depth-2 walk, the "nearest" fallback, a
synthetic `ref://` resolution, `pickEmitAnchor`, `WebLog.findTurn`, and the
endpoint end to end (persisted turn + 404). Verified read-only against the
production log: a trunk reply traced to its `response` prompt, its `messages`
slot write, and seven underlying slots.

## 2026-10-15 — the run registry works again: `startRun` through the telemetry wrapper

The web picker and tree tooling resolve "which runs belong to this session?"
through `runs.session_id`. knit calls `exec.logger.startRun(runId, sessionId)`
once per run — but the telemetry wrapper `wrapLogger` installs for onEvent
turns (every web and telegram turn) delegated checkpoints/events/readRow and
forgot `startRun`. The engine's `startRun?.()` is silent when missing, so the
whole registry went unwritten in production (0 rows since forever).

Fix: forward `startRun` like the other methods. `runs-table-test.ts` pins the
production shape (shared logger object + `onEvent`): a run registers its
conversation key, a resume keeps the original row, and the no-onEvent base
path registers too.

Companion engine fix (grandma-kat): a resumed `knit()` used to register a
phantom fresh run id before resuming — now the resume registers exactly once,
under the original run id. Production's `runs` table was backfilled with one
row per live session's current run (older runs are not recoverable).

## 2026-10-15 — web chat: `web-turns.json` is gone; session state lives in the log DB

The 5.2 MB web-channel store was 93% copies of engine events, stringified and
sync-written wholesale on every turn boundary (web turns, mirrored telegram
turns, session ops) — the event-loop stall behind the "UI hangs / very slow"
report. It is replaced by host markers written to `calls` in the workspace log
DB (`src/web-log.ts`), so the log is the single source for the web UI:

- `web_turn_end` — one row per finished turn with what the UI shows (input,
  bubbles, status, buttons) plus the real runId and its `(fromSeq, toSeq]`
  bounds; turns are SEGMENTS of a run (a resumed conversation keeps its run
  id, split by human pause/delivery events), so each marker scopes the event
  tail the log window replays.
- `web_session_label` — sparse label override (latest wins; empty re-derives
  from the first message).
- `web_session_delete` — a tombstone: hidden from the picker, trace preserved
  for the tree viewer.
- `web_session_open` — a foreign key (telegram) adopted into the drawer.

Markers ride `run_id = <session key>` (real run ids are timestamped — no
collision), so per-session reads seek on `(run_id, kind)` and a host-owned
partial index covers cross-session roll-ups. Event tails are read back on
demand and sanitized by the same code the live SSE path uses
(`src/sanitize.ts`, extracted from admin). In memory only the running turn
remains.

Behaviour changes: `clear` starts a fresh session (the old chat stays pickable
and resumable); delete tombstones instead of purging; the 10-session cap is a
display bound, never destructive. A legacy `web-turns.json` is imported once
at startup — labels as overrides, turns matched to their run by delivered-input
equality so matched turns keep their log windows — then renamed
`web-turns.json.migrated` and never read again. No host tables anywhere:
deletion/rename/adoption are rows in the same log.

Also: `agent.sessionContinuationIds()` (the key→run map the migration needs),
and the workspace gitignore keeps `web-turns.json*` out of history.

Tests: `web-turns-test.ts` rewritten (7 scenarios incl. crash-without-marker,
migration with matched bounds, and a no-file-written assertion);
`admin-sessions-test.ts` adapted (no file, non-destructive cap);
`app-attribution-test.ts`'s mock now writes engine-like rows like the real
engine.

## 2026-10-15 — the web UI's memory panel is scoped per session

Every run re-seeds its trunk memory slots at `scope_id 0`, so the UI's tracked
memory — keyed by `(scope_id, name)` in one global map — was last-write-wins
across *all* live conversations. With a web session and a followed Telegram
session both running (2026-10-14), the "trunk" panel showed the Telegram
call-list's `priorities` beside the web enrich run's `state`: a chimera of two
conversations, because both wrote the same slot keys.

`webMemoryValues`/`webMemoryPaths` now nest under the conversation key,
`trackMemoryWrite` takes the key, `/api/tree/memory` serves the session in view
(`?session=` overrides it), and the SSE push names its session so the client
drops a stray one. Switching sessions no longer wipes the panel — each session
keeps its own values — a deleted session drops its slots, and the maps are
bounded at 32 conversations.

## 2026-10-15 — tool-result refs pass through the logger wrapper

`ref://<seq>` handles (grandma-kat's new way of handing an oversized tool
result to another tree without it fitting the model's context) need the run's
logger to be readable: the engine checks `logger.readRow` and resolves refs
with it. BOB's `wrapLogger` telemetry wrapper delegated checkpoints and events
but not `readRow`, so with `onEvent` active (the web UI live view) refs would
never mint and every large result stayed a dead-end "narrow the query" note.
The wrapper now forwards `readRow` like the other read methods.
