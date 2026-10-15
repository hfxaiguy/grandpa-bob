# Changelog

Newest first. One dated section per change.

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
