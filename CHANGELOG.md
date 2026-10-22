# Changelog

Newest first. One dated section per change.

## 2026-10-22 — refs are minted by the engine; folds no longer write the grammar

`grandma-kat`'s `Each` records now carry `itemRefs` — the finished
`ref://<name>.<seq>` handle for every item, minted with `refs.mjs` `formatRef`
beside the `map_item` row it addresses. The workspace's shared tool-policy fold
reads those handles (`rowRef`) instead of composing `ref://<label>.<seq>` from
`itemSeqs`, so the grammar has one writer and a label cannot drift from its row.
`refClause` is now just the `[full value: …]` bracket; `shapeToolResult` /
`refFor` prefer a provided handle and add only the policy `/list` path. An item
replayed on resume stays null — its row belongs to the previous run.

`rowRef` keeps a one-cycle fallback for records logged by an older engine; it
and the engine's `itemSeqs` carry `RETIRE` notes and should be deleted once no
session can resume across this change. No bot source change: BOB only resolves
and renders handles. Tests: the `grandma-kat` suite (323) and the workspace's
`tests/tool-result-refs.test.mjs` (17).

## 2026-10-22 — the browser offers a workspace update when the seed is newer

A browser profile imports `seed/workspace.json` once, when OPFS is empty, and
never again — so a fixed tree could sit in `web/public/seed` while the tab kept
running the old one, silently. The toolbar now compares the workspace's
recorded seed stamp with the shipped seed's build time: when the seed is newer,
a **Workspace update available** button appears next to Export/Import (with
both dates in its tooltip). It is strictly manual — click, confirm, and the
seed is overlaid; the run log and chat history are preserved, and saved walk
positions reset once as the resumed trees re-derive. Declining remembers that
seed build so it does not prompt again; a newer build re-offers.

- `make-seed` now also writes a tiny `seed/meta.json` (`version`, `createdAt`,
  `fileCount`) so the boot check costs a few hundred bytes, not the archive.
- `.seeded` records the seed's own `createdAt` (not the apply time). A manual
  workspace import now stamps the import time, so an older shipped seed is not
  offered over a newer imported workspace.
- Pure `seedFreshness()` in `web/src/seed-version.ts`, unit-tested by
  `npm run test:seed-freshness` (clock-skew tolerance, legacy stamps, imports).

## 2026-10-22 — git sync defaults to `main`; the `master` branch is gone

The workspace's `master` branch was an Oct-17 snapshot while development lived
on `main`; the sync repo's `master` was frozen even earlier, and its `HEAD`
pointed there — so a fresh clone or pull got a weeks-old workspace. `master` is
removed from the workspace and the bare `sync` repo, whose `HEAD` now points at
`main`. The admin sync page, its API defaults and the README commands now use
`main`.

## 2026-10-22 — the global event stream marks where each turn begins

The right-hand event stream used to flatten every event of every turn into one
undivided list. Each turn's block now opens with a hairline *turn N* divider
(`.log-sep`), so scrolling back shows where a turn begins and which events
belong to it.

A divider is a synthetic row — no event backs it — so it is cached per `Turn`
object (`WeakMap`) instead of per event. That keeps its reference stable across
recomputes, the same `<For>` identity contract the event cache already relies on
(an unstable row remounts the whole window and closes an opened `<details>`).
Divider rows are excluded from the header's *event stream* count; prompts,
tool-call and token totals were already kind-filtered.

The input reads on the row right under the divider: a delivered `human` event
carries the message in `value`, and the collapsed line now renders that text
instead of the slot name, which read `main_input (delivered)` on every turn.
Pause events (nothing delivered yet) keep the slot name, and the full payload
stays in the expandable detail. Tests: `npm run test:ui-describe` (divider
stability across arrivals, numbering, delivered text).

## 2026-10-21 — the phone bridges to the browser chat (two-way)

Browser-target conversations (OPFS) can now be *bridged* to a Telegram chat
from the session drawer: messages typed on either end continue the same
conversation, and that conversation never leaves the tab. The browser is the
brain — every turn runs against the OPFS continuation and memory. The admin
only relays text, through four stateless endpoints (`/api/telegram/bridge`,
`inbox`, `relay`, plus the existing chat stream for display). No session is
adopted, nothing is written to the server's log, and no follow binding is
created; `web-settings.json` stays untouched.

Ownership: while the tab heartbeats (4 s visible, 10 s hidden), `bot.ts`
defers the chat's text messages to the browser instead of running the tree.
The phone sees `🖥️ bridged — …` once on connect. If the heartbeat stops (tab
closed, laptop asleep) the sweep hands every deferred message to the bot's own
session after 15 s and sends `🖥️ the browser went away — …` first, so the
phone is never left hanging. That fallback is a different thread (the server's
own continuation), which is why the marker exists. A reply relayed by a
resumed tab after a fallback (old epoch) is dropped, not duplicated.

The bridge replaces the one-way *✈ telegram* push in the browser target (the
button remains for server-served sessions); the drawer toggle is *bridge this
chat to Telegram while the tab is open*. Text only for now: voice notes and
photos still run server-side. Tests: `npm run test:telegram-bridge` (relay
protocol, fallback, away marker, epoch drop, chunking, no-write assertion).

## 2026-10-21 — server-only controls carry a server glyph

The controls that only work when the page is talking to the admin server are
now labelled with a little server icon (an inline SVG, `title="Needs the admin
server (BOB_WEB=1)"`), so the boundary is visible even while the admin is up:
settings — service health, the *webui follows telegram* toggle, *Restart bot*,
and the `bot.log`/`sherpa.log` buttons; the chat drawer — the *follow the live
Telegram conversation* toggle and the *✈ telegram* push. With no admin the same
icon explains why the control is disabled, and the composer's audio path says
so directly instead of failing on `/api/transcribe-stream` (audio transcription
is admin-only; every other attach still works in-tab).

The icon is declarative: settings elements carry `data-srv` and
`markServerFeatures()` appends the glyph at load; the chat UI renders a
`ServerIcon` next to the two Telegram controls, gated by `state.adminOnline`
from the `/api/capabilities` probe.

Everything else stays unlabelled on purpose: env, secrets, sync, commit, model
slots and tree patterns are all served by the in-browser backend and do not
need the server.

## 2026-10-21 — the admin server is optional; the web UI always loads

The server on `ADMIN_PORT` (default :8080) used to start the whole admin — chat
SSE, settings API, Telegram bridge, monitors — unconditionally. `BOB_WEB` now
gates it: unset/`0` (the default) starts a **static-only** listener that serves
the built browser UI and answers every `/api/*` with `503 {"admin": false}`;
`BOB_WEB=1` (or `BOB_DEV=1`) restores the admin. `startAdmin` keeps the full
admin as its default (`mode: "api"`), so direct callers and tests are unchanged.

The browser target already serves the settings endpoints in-tab
(`local-backend.ts`: env, secrets, sync, commit, models), so with the admin off
the settings page is answered entirely client-side. A new `/api/capabilities`
probe tells the shared settings page which host it is on (the admin answers
`{admin:true}`, the in-browser backend mirrors the boot-time
`servedByAdmin()` signal, the static listener answers 503); without an admin
the page shows a **browser only** chip and keeps the server-only controls —
restart, Telegram follow, bot logs, service health — visible but disabled. The
chat drawer's *✈ telegram* button disables the same way. The static listener
redirects a direct `/settings` hit to `/` (the settings page is an in-page
iframe there). Convenience scripts set the flag: `npm run start:with-server`
(built `dist/`) and `npm run dev:with-server` (tsx + Vite HMR). Plain
`npm run dev` is static-only as well — `BOB_DEV` only adds the Vite HMR
middleware to that listener, it no longer implies the API.

Tests: `npm run test:web-static` (UI served at `/`, `/api/*` 503 with
`admin:false`, `/settings` → `/`, traversal refused, API mode still answers
`{admin:true}`); `test:ui-serve` unchanged and green.

## 2026-10-21 — tile drag is pointer-based; the FireDragon fix above didn't hold

The HTML5 drag-and-drop fix below did not work in FireDragon: with the header
text `user-select: none`, Firefox 156 starts no drag at all (Chromium walks up
to the `draggable` ancestor, Firefox does not), so grabbing the handle still
did nothing.

- Tile reordering no longer uses native drag events. `pointerdown` on a tile —
  outside buttons, form fields, links, chat bubbles, token lines and the
  memory/event panels — arms a drag; 5 px of movement starts it: a
  `.tile-ghost` label follows the cursor, `elementFromPoint` picks the landing
  tile, and release calls the same `moveTile()`/`gpb.tiled.layout` as before.
- The chat body stays selectable (bubbles and token lines opt out of the
  drag), and a `body.dragging-tile` class locks the cursor and the selection
  while a tile is in flight. Same behavior in Chromium and Firefox.

## 2026-10-21 — tile drag works in FireDragon (Firefox)

Tile reordering used HTML5 drag-and-drop on the whole tile, which Chromium
starts from anywhere — but Firefox does not: when the mousedown lands on
selectable text (the header name, the status, the description, a chat bubble),
Firefox begins a text-selection drag and the ancestor's `draggable` never gets
its `dragstart`. In FireDragon, grabbing a tile by its text did nothing at all.

- `.tile-head` and `.tile-desc` are now `user-select: none`: the header is the
  drag handle (`cursor: grab`), and the chat body stays selectable for copying.
- `dragstart` sets `text/plain` and `effectAllowed = "move"` before touching
  reactive state — Firefox cancels a drag whose start handler mutates the DOM
  first; the dragged name also goes to a shared signal because `dragenter`
  cannot read the data store (protected until drop).
- `dragenter`/`dragleave` (ignoring child-to-child transitions via
  `relatedTarget`) toggle a new `.tile.drop-target` accent outline, and
  `dragend` clears it, so the landing tile is visible.
- `moveTile()` and the `gpb.tiled.layout` persistence are unchanged.

## 2026-10-21 — one session store: `sessions.json` is gone

The admin kept conversation state in two places: the log DB (turn history,
labels, checkpoints) and `logs/sessions.json` (continuation pointers, model
overrides, pinned refs, paused tree path/signature) — while the browser target
had only ever used the log DB. Two designs, two failure modes to debug. The
Node side now uses the browser's design:

- **Continuations derive from the engine's own trace.** The latest `runs` row
  per `session_id`, and that run's `checkpoints` row, is the live pause — a
  finished run has no checkpoint (the engine deletes it on resume), so "latest
  run with a checkpoint" is exactly the resumable session. On the real 449 MB
  log this is a 3 ms indexed query, and it derives the same 17 live sessions
  the file held.
- **What the trace cannot carry moves to marker rows** —
  `web_session_meta` (kind shared via `src/web-log-types.ts`, `WebLog` writes
  it): resume hash, per-role model overrides, pinned version ref, paused
  tree path + subtree signature. Latest marker per key wins. `clear()` writes
  a `clearedAt` tombstone so a restart cannot resurrect the key (the engine
  leaves the orphaned checkpoint behind), and model overrides clear the same
  way.
- `Agent` builds its own `WebLog` over `logs/grandma-kat.db` and restores at
  construction — no injection, no admin coupling, so agent-only scripts and
  headless runs behave identically. `saveSessions()`/`loadSessions()` and the
  file are deleted; the partial marker index is rebuilt to include the meta
  kind (a one-time `DROP`+`CREATE`, since `IF NOT EXISTS` would keep the old
  `WHERE`), and `checkpoints(run_id)` gets an index when the engine has
  created the table.
- No legacy import: pre-upgrade pauses still restore (the meta-less restore
  skips the resume-hash comparison until the next pause records one); model
  overrides and pins for sessions from before the change revert once to
  defaults.

Tests: `test:sessions` reworked for DB-derived state (restart resume, a
checkpoint deleted after restore, `clear()` tombstone, model-override
persistence, no `sessions.json` written); `test:model-switch`, `test:fallback`,
`test:tree-pinning` assert restart persistence through the markers. Also green:
`test:web-memory`, `test:web-turns`, `test:runs-table`, `test:provenance`,
`test:admin-models`, `test:telegram-follow-restart`, `test:trees`,
`test:tree-versions`, `test:tree-nested`, `test:tree-api`, `test:stop`,
`test:agent-done`, `typecheck`.

## 2026-10-21 — the memory panel can no longer show another session's values

`turn_end` fires `void refreshMemory()`; clicking "new chat" right after started
a second fetch. Responses carried no session, so when the old (usually larger,
slower) one resolved last it repainted the fresh chat with the previous
conversation's values — where they stayed until the next turn ended, which reads
exactly like "memory values survived switching to another session".
`refreshMemory()` now captures the session it is for plus a monotonic token and
drops a response that lost to a newer fetch or a session switch; with no session
on screen it clears instead of asking the server (whose active session may be
the old one). `refreshSession()` clears the map the moment the active key
changes, so a switch never shows the previous values while the new fetch runs.
The live SSE `memory` push is strict: it merges only when `msg.session` is the
active one and the panel already reflects that session; otherwise it refetches
rather than blending maps. The panel header names its source
(`memory · resumed web:f0e7f63f`), so a resumed conversation reads as resumed
instead of as values that outlived a switch.

The in-browser agent worker now passes `sessionId: chatKey` to the engine, so a
tree invoked as a tool keeps its slots per conversation there too — the Node
host already did (`src/agent.ts`); without it the browser target re-seeded every
tree tool on each call.

Tests: `npm run test:memory-race` (new: the switch race, the no-session clear,
and SSE session gating; it fails against the previous store), `npm run
test:web-memory`, `npm run typecheck`, `npm --prefix ui run typecheck`,
`npm --prefix ui run build`.

## 2026-10-21 — one writer per database, and the app-DB guard reaches bob-web

`sql_write` opened its own SQLite connection per call while app code held a
long-lived cached writer. In the browser that is two connections over the OPFS
seam, which can each keep a different snapshot of `sqlite_sequence`: a raw
insert minted profiles 7–12 and the app store then handed **id 7** to a new
person, because its snapshot still said 6. `SqliteTools` now takes the host's
app store (`src/tools/sqlite.ts`) and routes a write to a root-level `<name>.db`
through its cached writable handle — one writer per file per worker. The
registry accepts the store (`ToolRegistry(..., appStore)`), and `src/index.ts`,
`src/debug/repl.ts` and the browser worker all create it once and pass the same
instance to app tools and SQL tools. `markDatabaseDirty` still runs for every
write (the store's wrapper does not treat a row-returning write as a write),
and the tool closes only handles it opened itself.

The app-owned-database guard was Node-only: bob-web's tool map exposed
`sql_query` / `sql_write` with no ownership check, so the trunk could raw-write
`contacts.db` / `comms.db` / `email.db`. The guard's constants and refusal moved
to `src/tools/app-dbs.ts` and both targets now use them; the browser tools take
the engine's per-call context and refuse the owning stores unless the call is
inside an app tree (`ctx.boundary`), exactly like the Node registry. With the
raw path closed, the contacts app's gate needed its other half — a relation that
names an existing contact id is a link, not a company creation, so a hand-off
can attach a person to an existing company without falling back to `sql_write`
(see the contacts app's CHANGELOG).

Tests: `npm run test:sqlite` (counts writable opens — SQL tools and app code
share one handle, and the app insert sees the raw insert's sequence),
`npm run test:browser-sql-guard` (trunk refused, basename match, app exempt,
unowned reachable), `npm run test:app-db-guard` unchanged.

## 2026-10-21 — a nested app call is its own tile (app attribution)

A turn's events are tagged with the app (tile) they belong to. The rule was
"the OUTERMOST tree tool is the app; everything nested is a capability of it" —
written when only the trunk called apps. Apps now call other apps as tools
(enrich-profile's `resolve_contact` / `save_run` call the contacts app), so that
rule folded a whole nested app run — its `input:` echo, bubbles, memory writes,
exits and pauses — onto the calling app's tile.

Attribution now treats the workspace's app trees as **boundaries at any depth**:
a nested app opens its own boundary and its events land on its own tile, while
a tree tool that is not an app (email's `answer`, contacts' `contacts_query`)
still stays with the app around it. The current app is the topmost boundary,
`tree_exit` tags the leaver (an app's exit is its own completion event), and a
`tree_suspend` inside a nested app makes that app own the human-input pause.
`retagEvents` reconstructs the same tags for stored turns, and both replay paths
(`WebLog.getTurns` / `turnEvents`, the browser `log-store`) re-derive a stored
turn's `emitApps` from the run log when every stored bubble has one emit event —
so turns recorded under the old rule heal on load.

The registry comes from `listAppTrees`: the Node admin caches it (primed at
startup, refreshed per web turn and by `/api/apps`), the browser backend
refreshes it per turn, and both replay paths (`WebLog.memoryWrites` /
`turnEvents`, the browser `log-store`) thread the same names through. The UI's
running-tile walk now reuses `src/app-attribution.ts` instead of mirroring the
old rule. Without the registry (a host that has not been updated) the walk keeps
the legacy outermost rule, so nothing breaks.

A tree can already opt into its own chat section independently of the registry:
an enter event carrying `ownTile: true` is a boundary too. That is the seam for
the engine's future per-tree marker; today only app-tree roots are boundaries.

Tests: `npm run test:app-attribution` (nested app enter/exit/emit/memory/suspend,
capability-in-nested-app, legacy mode, `ownTile`, `retagEvents`, SSE tags,
stale-marker heal).

## 2026-10-21 — per-turn token totals in the chat tiles

Each finished turn now carries `tokens: { input, output, calls }` — the sum of
the `llm_call` usage the engine reports (input counts the full prompt on every
round, i.e. the billed amount). The host folds in every event before the turn's
500-event window caps, so long turns keep their early rounds; the total rides
on `turn_end` and is persisted on the turn marker (`web_turn_end`), so a
reload derives the same numbers. Both hosts count (Node admin and the browser
worker). A turn the endpoint never reports usage for (a mock model) shows
nothing. The tile prints it under the turn's final reply, e.g.
`⇅ 12.3k in · 1.2k out · 3 calls`.

Tests: `npm run test:tokens` (sums skip silent calls, live `turn_end` carries
the total, `/api/turns` re-derives it from the marker).

## 2026-10-21 — memory panels rebuild after a restart / reload

The per-app memory panel showed nothing after reloading the browser tab (OPFS
target) and after restarting the Node admin: the tracked map is process state,
and nothing refilled it. Both hosts now share one tracker
(`src/memory-track.ts`) and rebuild a session's map lazily from the run log the
first time it is viewed — the browser via a new `memoryWrites` log op, the admin
via `WebLog.memoryWrites`. `?session=` on `/api/tree/memory` now names the
conversation in the browser target too (it was ignored, so sessions shared one
map there).

The rebuild reads raw `calls` rows, not the sanitized per-turn event window:
that window is tail-capped at `MAX_TURN_EVENTS` = 500 and truncates
strings/arrays for streaming, which would lose early writes and large values.
Documented in `web/README.md` → "Session memory panels after reload / restart"
(the cap still applies to anything else derived from the event window).

Tests: `npm run test:memory-track` (fresh tracker + `memoryWrites` reproduces a
live panel; 1 000-char value untruncated; a write before 600 trailing rows still
rebuilds; LRU/clear/session isolation) and the browser smoke's post-reload
memory check. `npm run test:web-memory` still passes.

## 2026-10-21 — workspace export/import in the standalone web UI

The browser target's toolbar now has **Export** / **Import** in Browser (OPFS)
mode (hidden in Desktop mode, where the workspace is the real folder):

- **Export** downloads the whole tab workspace as `bob-workspace-<date>.json` —
  the same dependency-free, base64-in-JSON `WorkspaceArchive` v1 the seed uses,
  covering `app/`, `patterns/`, `lib/`, the app `.db` files and the run log with
  the browser chat sessions.
- **Import** validates the archive (`validateWorkspaceArchive`), confirms, merges
  it over the workspace (same paths are overwritten, files the archive lacks are
  kept) and reloads so the platform, fs index and sqlite worker re-read the
  restored files. A `.seeded` marker is written when the archive lacks one, so
  the shipped seed cannot re-import over the restored workspace.

`exportWorkspace()` had been unused since the shared-UI milestone retired the
demo page. Tests: `npm run test:workspace-transfer` (base64, shape guard, blob)
and the browser smoke's export-download/import-merge check.
Docs: `web/README.md` → "Workspace backup and restore".

## 2026-10-21 — `csv_query` replaces DuckDB

CSV/TSV querying is now SQLite, shared by both targets: `csv_query` loads one
`.csv`/`.tsv` as the table `csv` in a scratch `:memory:` database and runs one
read-only statement (SELECT/WITH/EXPLAIN/PRAGMA) with the same 100-row /
500-char result shaping as the old tool. The parser is a new zero-dependency
module (`src/platform/csv.ts`): RFC 4180 quotes, BOM/CRLF, numeric coercion
that leaves leading-zero ids as text, quoted-empty vs empty. The browser
worker injects its wasm factory as the scratch engine, so this also works in
desktop-bridge storage mode. Removed: `src/tools/duckdb.ts`, the
`@duckdb/node-api` dependency (~70 MB of native bindings), the DuckDB BOM
test, and `duckdb_query` from the browser stub list. Tests: `npm run test:csv`.
The `sqlite` factory's `open()` gained an optional `scratch` flag (the tab's
worker keeps such databases in memory and never persists them).

## 2026-10-21 — app-entry machine notes, faded by default

Every top-level app now emits a `flag("machine")` note immediately after its
initial input (`Needs(...)`), naming the request the app received. This covers
`caller-list`, `contacts`, `email`, `enrich-profile`, `files`, and both `knit`
tree versions.

Machine bubbles are visible by default and are always rendered faded and
teal-tinted with a dashed border — whether the tree is showing an input,
waiting, or a hand-off. The toolbar **machine** button or the session-drawer
checkbox hides/shows them, persisted in `localStorage`. `app/knit`'s spec
prompt and the workspace guides describe `<<!` as this input note.

## 2026-10-21 — browser tools share the workspace app's verbs

The worker no longer carries a hand-copied set of `browser_*` tool definitions.
`web/src/agent/browser-cdp.ts` now loads `app/browser/src/verbs.js` from the
workspace through the module loader and supplies only the browser-level CDP
transport; names, descriptions, schemas, bodies and the cursor-listener
confirmation come from that one file (also used by the app's Node target). The
worker-level hint (`npm run chrome`) is the only added wording. A load failure
still yields per-tool stubs instead of breaking the worker. Tests:
`npm run test:browser-tools` (fake socket; skipped without a workspace copy).

## 2026-10-21 — Emit flags and a machine-note toggle

`grandma-kat` emits now accept a channel flag:
`Emit("input: …", flag("machine"))` or
`Emit((m) => ({ text: … }), flag("machine"))`. The emitted value gains
`level: "machine"`; strings are wrapped as `{ text, level }`. Literals are
allowed only with a flag so a missing function is still caught at build time.

The web UI hides `level: "machine"` bubbles by default and persists a
**machine** toggle in the toolbar and session drawer. Turn on the toggle to see
tree narration — app inputs, waiting notes, hand-offs — without mixing it into
the normal reply stream. `app/knit`'s generated prelude can now import `flag`;
`<<!` in a spec maps to `Emit(..., flag("machine"))`. Tests:
`node --test tests/emit-flag.test.mjs` in `grandma-kat`; BOB's UI typecheck and
web build cover the toggle.

## 2026-10-21 — `npm run chrome` opens BOB in FireDragon

The launcher now opens the app in **FireDragon** (falling back to an installed
Firefox, then the OS opener) instead of whatever `xdg-open` points at. Chrome is
still launched/reused for the CDP endpoint the `browser_*` tools drive, but it
stays a background automation process — FireDragon is Firefox-based and has no
CDP server, so it is only the display browser. `BOB_BROWSER_BIN` chooses a
different display browser, `BOB_NO_CDP=1` skips Chrome entirely (the four
browser tools report no endpoint) and clears a persisted `?cdp=` socket, and
`BOB_NO_OPEN=1` keeps printing the URL without launching anything. Docs:
`web/README.md` → "Browser tools (local Chrome)". `web/scripts/chrome.mjs`,
`web/src/main.ts` (empty `?cdp=` clears the saved value).

## 2026-10-21 — standalone web target (no admin)

The browser target can now run with grandpa-bob's admin stopped:
`npm run web:standalone` serves `web/dist` from a zero-dependency loopback
static server (`web/scripts/serve.mjs`, default `:8080`, `PORT`/`HOST`
overrides) and answers `/api/*` with 404 because there is no admin API. The
check also fails fast when `web/dist` is missing, and names the admin when the
port is already taken.

The seed now packs `workspace/models.json` from
`web/public/models.standalone.json` — neuralwatt `v4`/`v4.1` plus
`cheap`/`strong` aliases, with `${NEURALWATT_API_KEY}` substituted from
Settings → Credentials & .env, so no key is committed and the workspace's real
`models.json` (desktop endpoints/keys) is still never seeded. The credentials
card gained a Neuralwatt key shortcut, and the browser `/api/status` now reports
the env map so the all-keys editor works without a server. Older browser
profiles whose `models.json` is still the auto-generated `:8787` mock are
upgraded to the template; a hand-edited registry is left alone.

Standalone additions:
- `POST /api/models/test` in the browser backend: reachability + model ids from
  the tab, same shape as the admin, so Settings → **Test** works with no
  server. A browser CORS rejection is named in the error instead of looking
  like a dead endpoint.
- the picker flags a mock-only registry (`mockOnly`) instead of presenting
  `:8787` entries as real models.
- a tab loaded from the admin no longer goes model-less when the admin stops
  mid-session: `/api/models` and `/api/models/slots` fall back to the
  browser-local registry, matching the agent worker's existing fallback.
- the status line appends `standalone` when the admin is not serving the page.

Ollama Cloud stays server-mode only: it sends no CORS headers (the preflight
answers `405` on both `/api/chat` and `/v1/chat/completions`), while neuralwatt
answers `access-control-allow-origin: *` — verified with preflight and GET, so
the standalone template uses neuralwatt only. Docs:
`web/README.md` → "Standalone (no admin)".

## 2026-10-21 — `inspect_memory` in the client-only web UI

The browser target now registers grandma-kat's `inspect_memory` host tool, so a
turn running entirely in the tab can resolve a `ref://` handle or read a live
memory slot instead of falling through to the "not available in the browser
target" stub. The worker's plain tool map already receives the engine's
`view`/`readRef`/`scopeInfo` ctx in `execute`, so it needs no special dispatch
like the Node registry. Also fixed in KAT: a direct
`Call('…', 'inspect_memory', …)` now gets the same ctx as the auto tool loop.

## 2026-10-20 — stop a running tree

The chat composer now shows **Stop** while a turn is running. It calls
`/api/chat/stop`; both targets abort the in-flight model request, reject the
current tool call, and make the engine's next logged step throw, so the tree
cannot advance. A stopped turn is recorded as `stopped` (not an error) and the
previous checkpoint remains the resume point, so the conversation keeps
working. Browser mode keeps the worker alive; Node mode aborts only the
signalled turn via `AsyncLocalStorage`, and the admin's `/api/llm` proxy also
aborts its upstream request on client disconnect. Regression test:
`npm run test:stop`.

## 2026-10-20 — workspace spec lint moves into BOB

`patterns/spec-lint.mjs` is now `scripts/spec-lint.ts` here. It lints the
workspace's `patterns/*.spec.md` and `app/*/tree.spec.md`, defaults to
`$WORKSPACE_DIR` or `~/grandma-workspace`, and is available as
`npm run lint:specs` (with `npm run test:spec-lint` for its unit tests). It no
longer appears in the pattern picker, and `lib/` stays runtime-only.

## 2026-10-20 — the open session lives in the URL

The chat page now mirrors the active session into `?session=<key>` and resumes
it on load, so a reload (or a bookmark) returns to the conversation that was on
screen instead of opening a new chat. The first visit still opens a fresh chat;
`new chat`, opening/renaming/deleting a session and the Telegram follow all keep
the address bar in step (`replaceState`, so other query params survive and Back
does not walk session history). A key that no longer exists falls back to a
fresh chat and rewrites the URL. Re-selecting the already-active session is now
a no-op on the admin API too — a freshly minted chat has no log markers, and a
reload arrives as exactly that request.

## 2026-10-20 — inspect exact LLM prompt/output in the event stream

`llm_call` rows now preview the model's output when collapsed. Expanding one
auto-loads the raw run-log row (`/api/ref`) so the complete `messages` array,
output, reasoning and tool-call arguments are visible; the detail also has
copy-event and copy-messages actions. The live sanitized event keeps output,
reasoning and tool calls intact (only the message array stays summarized
until the full row is fetched).

## 2026-10-20 — copy/download the full event stream

The stream panel only keeps a tail in memory. Its header now has **copy** and
**↓** actions: both refetch `/api/turns` and dump the full raw turn/event JSON
for the active session, ready to paste into an agent/debug chat. Copy falls
back to a JSON download when the clipboard is unavailable (insecure origin or
headless browser).

Note: `/api/turns` exposes the latest 20 turns; the dump covers those with
every event per turn. Older history remains in the run log.

## 2026-10-20 — Telegram command sync retries; IPv4-first startup

`setMyCommands` at startup could hit a transient `ETIMEDOUT` (IPv6 to
`api.telegram.org` has no route on this machine). The command sync now retries
each scope with backoff, and `npm run dev` / `npm start` pin Node to
IPv4-first DNS. The failure was already non-fatal — the bot kept running — but
the slash-command menu could be left stale.

## 2026-10-20 — browser seed is code-only (1.9 MB)

`make-seed` now packs only the three trees the browser runs — `app/`,
`patterns/`, `lib/` — plus an empty `logs/grandma-kat.db` (schema only).
Database dumps, `knowledge/`, scraped pages, assets, root notes and
`models.json` are desktop-only. The seed drops from 28 MB to ~1.9 MB.

- The browser starts with an empty contacts store. The contacts app now
  initializes its schema when its tools load (`appReady`), before a tree can
  query it, so `sql_query` against `contacts.db` works on a first boot.
- Both app-tool loaders await an app's optional `ready` promise before exposing
  its tools.
- Browser saves still create `db/*.sql` dumps when a database changes; the
  desktop's existing data is simply not preloaded.
- `npm run make-seed` at the repo root regenerates the seed (defaults to
  `$HOME/grandma-workspace`; override with `WORKSPACE_DIR=…`).

## 2026-10-20 — one dev server: Vite HMR on :8080

`npm run dev` now starts the admin server with Vite in middleware mode on the
same port. The web app is served from source with real HMR; `/api/*`,
`/settings` and Telegram stay in the same process. Production `npm start`
still serves the built `web/dist`, and `npm run build` remains the only step
needed before it. The separate `:5173` Vite server is no longer part of the
normal workflow.

## 2026-10-20 — browser app trees: host-owned stores and app tools

`enrich-profile` could not load in browser mode. Two layers were missing: the
module loader did not handle ESM re-exports (`app/contacts/src/index.js`), and
the app opened its own `node:sqlite` connection at module load — impossible in
the browser, where OPFS SQLite is asynchronous and lives behind the platform.

- The browser module loader now handles named, aliased, default, star and
  namespace re-exports, plus `export async function`.
- `src/app-store.ts` is the host-owned app database seam: apps ask it for a DB
  by workspace name, it uses `Platform.sqlite` (Node or sqlite-wasm), caches
  writable handles and marks writes dirty for the existing dump/sync path.
  The Node entry point and the browser agent worker install it as
  `globalThis.__BOB_STORE__`.
- The browser agent worker also loads each `app/*/tools.mjs` through the module
  loader. App tools such as `upsert_contact`, `get_contact`,
  `company_context` and `log_message` are now available to app trees alongside
  the host tools (stubs still cover target-only tools).
- The workspace's contacts app is async and store-backed; its schema and
  queries are unchanged. Its Node tests and the caller-list/enrich-profile
  fixtures were updated for the async API.
- `npm run test:module-loader` covers the loader cases.

Other apps that still import `node:sqlite` directly remain Node-only in the
browser; they are skipped by the app-tool loader until they adopt the store.

## 2026-10-19 — browser refs are on-disk addresses again

The in-tab logger numbered events with its own per-session counter starting at
1, while the log DB assigned AUTOINCREMENT rowids. Every `ref://<label>.<seq>`
minted by a tree (and by the engine's own truncation shaper) therefore pointed
at a row that did not exist — or at an unrelated one. The logger also had no
`readRow`, so knit's `refsResolvable()` was false and the engine neither minted
nor resolved refs in the browser.

The logger now allocates the seq the log DB will use: one cursor per log file,
seeded from `MAX(seq)` before the first event and shared by every session
logger and turn marker in the worker. Flushes insert explicit seqs (so memory
and disk agree), and a flush that sees foreign rows — a Telegram turn through
the desktop bridge — re-keys its pending batch from the DB's new max. A
`readRow(seq)` method turns `refsResolvable()` on, so the engine mints and
resolves handles exactly as it does on the Node target.

`/api/ref` now asks the worker (`readRow`, through the same serialized
connection as the log writes) so it reads the log DB of the **selected
storage** — OPFS or the real workspace through the bridge. The streamed events
remain only as the fallback for a row that has not flushed yet. Replayed turn
events also keep their `seq`, so a reloaded chat can still navigate refs.

Types for the session log moved to `src/web-log-types.ts`, so the web tsconfig
no longer type-checks the Node `web-log.ts` against the browser's `node:sqlite`
stub (a pre-existing web typecheck failure).

The browser smoke now reloads, then resolves a logged seq through `/api/ref`
and checks the row kind, proving the address survived the in-memory session.

## 2026-10-19 — transcription is Telegram-only; voice input removed from the web UI

The composer's 🎙 mic button (record → `/api/transcribe` → send) is gone from
the web UI, and the browser target no longer runs whisper in-tab: the
Transformers.js pipeline (`web/src/stt/browser-whisper.ts`) was pulling the
entire STT model into the browser tab on first use. Audio transcription stays
where it belongs for now — Telegram voice messages on the Node target, via the
GPU whisper backend.

- `ui/src/components.tsx`: mic button and all MediaRecorder state removed; the
  composer is text + file attachment only.
- `ui/src/store.ts`: `transcribeAudio` (voice-blob helper) removed.
  `transcribeFileStream` stays: attaching an audio *file* still streams a
  transcript from the Node server's whisper backend (server-side, nothing
  downloaded into the browser).
- `web/src/server/local-backend.ts`: the in-tab `/api/transcribe` route is
  deleted; `/api/transcribe*` now falls through to the standard 501
  "not available in browser mode", like restart-bot and telegram.
- `web/src/stt/` directory removed from the browser bundle.
- Node target unchanged: `src/stt.ts`, `src/bot.ts` (Telegram), and
  `src/admin.ts`'s `/api/transcribe*` routes are untouched.

Revisit browser voice input later via a remote STT API — never an in-tab model.

## 2026-10-19 — drop the File System Access ("direct folder") storage mode

The browser header offered three storage backends; the third read a real
folder picked with `showDirectoryPicker()`. It was Chromium-only and the one
mode with no page-level SQLite path: the picked folder has no sync access
handle, so every mutation had to export the whole database file. That made it
the only place where the run log could be clobbered by the Node server writing
the same file, and it could never be made disk-truth without routing the log
through the bridge anyway.

Two backends remain: **Browser (OPFS)** and **Desktop (local server)**. The
FSA adapter, its git client, the folder gate, the "SQL writes" opt-in and the
`test:fsaccess` / direct smoke are gone; a stored `bob:storage=direct` falls
back to OPFS. Nothing else used the API — the upload button already writes
through `/api/files/upload`, not a directory picker.

## 2026-10-19 — browser workspaces get their app databases

The OPFS seed ships `db/*.db.sql` dumps, but the browser's SQLite adapter
opens a missing database as an empty in-memory DB instead of throwing. The
replay compared that empty dump with the committed one, called it a conflict,
and skipped it — so a fresh browser workspace had no `contacts.db` /
`comms.db` / `email.db`, and the bot reported `no such table: profiles`.

- `applyDatabaseDumps` checks for the database file itself and replays the
  dump only when it is missing. An existing database is left alone, even if
  it has no tables.
- The browser logs a warning when the dumps cannot be applied instead of
  swallowing the error.
- `npm run test:db-sync` emulates the browser's missing-file behavior, checks
  that the dump creates the DB, that an existing (empty) DB is not replaced,
  and that a locally edited DB is still preserved as a conflict.

## 2026-10-19 — fresh browser seed; snapshot age in the status line

The OPFS sandbox was still running the Oct 3 seed. Its `patterns/trunk.mjs`
was the old auto-tool-loop design; with a real model a trivial "remember X"
wandered the workspace for twelve rounds and died on the tree's own
`tool-iteration limit: stuck`. The seed has been regenerated from the live
workspace (`make-seed`), so the browser now runs the current
`trunk.prod.mjs` — the same turn answers in one round.

Two related fixes:

- `seedWorkspace` checked for the literal `patterns/trunk.mjs`. The live
  workspace ships `trunk.prod.mjs`, so with the fresh archive that guard
  would have re-imported the whole 27 MB seed on every boot. It now resolves
  the trunk through the version catalog.
- `?reseed` no longer imports the archive's empty `logs/grandma-kat.db` when
  the workspace already has one: the log now holds the browser's chat
  sessions, and reseeding a sandbox must not wipe them.
- The browser status line shows the snapshot date (`browser · snapshot Oct 3`)
  and calls the seed stale after 14 days, so an old sandbox is visible instead
  of silently changing how the bot behaves.

## 2026-10-19 — web sessions persist in the workspace KAT log

The browser's chat was a single in-memory `web:local` session: every reload
started empty and the drawer had one entry. Sessions now live where the
workspace lives, as the same `web_turn_end` / `web_session_label` /
`web_session_delete` marker rows the admin's `src/web-log.ts` uses in
`logs/grandma-kat.db`:

- **OPFS** (browser) → the sandbox workspace's log
- **Desktop** (bridge) → the real workspace's log, on disk
- **Direct folder** → the picked folder's log (the log is internal, so it is
  written even when SQL write-back is off)

New/select/rename/delete work per session; the drawer lists older chats with
labels derived from their first message, and reopening one replays its turns
from the log (event tails are sanitized exactly like the admin's). A page load
still opens a fresh chat by design; the old ones stay in the drawer.

The agent worker now owns every session-log read and write, sharing one
serialized connection with the engine's event flush so a turn marker cannot
race the events it describes. Tree continuations are keyed by chat session too,
so two chats on the same pattern no longer share a pause checkpoint.

## 2026-10-19 — app tiles get their bubbles; refs resolve in the page

The browser host wrapped every app tree in a plain function tool whose
`execute()` called `knit()` itself. The engine therefore never saw a tree
tool: no `tree_enter`/`tree_exit` rows, so `tagEventApp()` kept the app stack
at "trunk" and every app emit landed on the trunk tile. A run that used the
contacts app showed its summary on the trunk and left the contacts tile empty.
The host now hands the engine a `tree: <name>` tool (like the Node target); the
engine runs the tree, logs the enter/exit pair, and the emit carries the app
name.

`/api/ref` had no browser implementation: the shim forwarded it to the admin,
which reads the workspace log DB. The in-tab engine's refs use the seqs its
logger assigns while streaming, and those do not match the on-disk
AUTOINCREMENT rows, so every handle inspected a different row (or 404'd). The
local backend now resolves a ref from the events it received, using the same
`refTargetFromRow()` as the Node reader (moved to `src/ref-target.ts`, so the
browser does not pull in `node:sqlite`).

Verified in a browser-mode run at `:8080`: the contacts emit is tagged
`contacts`, and `/api/ref?seq=<row>` returns that row's kind and value in the
page.

## 2026-10-19 — one live event stream (duplicate run cards fixed)

The tiled UI opened a new `/api/events` subscription on every mount and never
closed it. The Node admin serves chat and settings as separate pages, but the
browser target swaps them in place, so a trip to Settings and back left the old
`EventSource` subscribed: every engine event was then appended to the same turn
twice and the run log showed each step (for example `llm…response — calling
strong`) as two identical cards. The engine and the model call were never
duplicated — the run log has a single `llm_start` for the turn.

`store.ts` now owns the single stream (`openLiveStream()` closes the previous
one before opening, `closeLiveStream()` closes it for good), and `mountApp()`'s
dispose calls it. One subscriber survives a chat ↔ settings remount.

## 2026-10-19 — browser model calls go through the admin's registry

When `web/dist` is served by grandpa-bob's admin, the in-tab agent now reads
that process's `models.json` and sends its model calls through the same-origin
`/api/llm/<slot>/{chat/completions|api/chat}` proxy. Before, the browser used
the workspace `models.json` (the mock in the live workspace), so the same page
at `:8080` could answer through a different model set than Telegram. Now there
is one registry, the request uses the server-side network (Ollama Cloud works
despite having no browser CORS), and the API keys never reach the page. The
proxy refuses non-POST requests, unknown slots/endpoints, and cross-origin
callers (`Origin` ≠ the served host). Standalone (Vite/static) keeps the
workspace `models.json` + Settings JSON fallback.

## 2026-10-19 — model slots can be aliases; the web picker lists them

A `models.json` entry may now be a string naming another slot:

```json
"v4.1":  { "baseURL": "https://api.neuralwatt.com/v1", "model": "deepseek-v4.1-flash", "apiKey": "…" },
"strong": "v4.1"
```

`parseModels` resolves alias chains and rejects cycles and unknown targets, so
a role the trees reference (`Model("strong")`) can track another slot without
duplicating its endpoint or key. The settings editor gained an **alias of**
field; its Test button follows the target.

The browser target's `/api/models/slots` only read the browser Settings JSON and
ignored the workspace `models.json`, while `/api/chat/model` was a no-op — the
chat picker therefore offered only "default" and forgot the choice. Slots now
come from the effective registry (the admin's when served by it, else the
workspace file), and role→slot overrides are kept per session and applied by
the worker. `smoke:browser` pins slots + override.

## 2026-10-19 — named ref handles in provenance; `inspect_memory` registered

Provenance scanning matched only bare `ref://<seq>` handles; the engine now
mints `ref://<tool>.<seq>[/path]`, so the scan accepts an optional name segment
and keeps the seq as the resolution key. `scripts/provenance-test.ts` pins both
forms (a bare handle and a named one, each resolving to its own row).

`inspect_memory` (grandma-kat) is registered as a built-in tool and offered to
the trunk via `TOOL_NAMES`. It is dispatched **specially**: its execute needs
the engine's tool ctx (`view`/`readRef`/`scopeInfo`), which the app-tool path
replaces with the app's secrets context — so it cannot be a `tools.mjs` app
tool. A `HOST_GUIDES` entry teaches the model to peek at a handle (or live slot)
instead of re-querying, and to pass the ref on to hand over the whole value.

## 2026-10-19 — a dead model endpoint now names itself

`agent run failed: NetworkError when attempting to fetch resource.` was
Firefox's wording for *any* failed `fetch`, surfaced by the worker's catch-all
without context — so a stopped model server, a CORS block, and a broken
workspace all looked identical. `knit()`/`resume()` now run through a
`withModelContext` wrapper that, on a network-class error, appends the
configured slots (`default=… @ http://…`), the mock-server hint, and the CORS
note into the same message.

## 2026-10-19 — trunk is discovered again, and the toolbar names the active pattern

Two pattern-discovery/status fixes:

- `listPatterns` skipped every `.prod`/`.vN` file as a snapshot, which hid
  trees that exist **only** as a prod file — the live workspace's `trunk` is
  `patterns/trunk.prod.mjs` with no draft. Boot detection therefore picked the
  alphabetically-first draft (`context_manager`) as the default pattern, and
  the pattern picker could not offer trunk at all. Prod snapshots are now listed
  when the tree has no editable draft (drafts still win when both exist).
- The web UI's `detectPattern` now reads the same `scanTreeVersions` catalog the
  Node target uses, preferring `trunk` whether it is a draft or prod-only, and
  returns the logical name. `patternCatalog` compares `activePattern` by logical
  name, so a boot path no longer resets the selection to `names[0]`.
- The toolbar status shows the logical name (`trunk`, not `trunk.mjs`) and
  updates when the picker changes pattern (the in-browser backend emits
  `bob:pattern`), instead of showing the boot-time value forever.
- `test:pattern-path` now asserts prod-only discovery; `smoke:direct` asserts
  the status line follows a switch.

## 2026-10-19 — first turn after a reload resolves a picked pattern against the right backend

`resolvePatternPath` reads the tree catalog through the `node:fs` shim, but the
agent worker pointed that shim at the selected storage *after* resolving. A
fresh worker starts on OPFS, so the first turn after a page load looked for
`patterns/context_manager.mjs` in the browser sandbox, found nothing, and fell
back to a path that does not exist — failing with ENOENT even though the
workspace had `context_manager.prod.mjs` (later turns worked because the shim
was already repointed). `setActiveFs(platform.fs)` now runs before resolution.
A name that resolves nowhere now fails with `unknown pattern '<name>' —
available: …` instead of a bare ENOENT, and `smoke:direct` runs a first-turn
name-picked pattern end to end so the ordering cannot regress.

## 2026-10-19 — high-contrast toolbar (the storage bridge URL input)

The storage toolbar used the browser's default light controls over a dark app,
so the bridge URL input was low-contrast and in a mismatched font. It now uses
the tiled app's palette (`--bg/--panel/--card/--border/--fg`), explicit
foreground/background/border on every control, a visible focus ring, a
high-contrast placeholder, and a monospace font for the URL field. The outer
page is `color-scheme: dark` so select popups and checkboxes match too.

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

## 2026-10-17 — the event log and stream show a prompts count beside tool calls

The tiled UI's panel headers counted events and tool calls; a prompt count
tells you how many model calls a run made without opening it. Both headers now
read `events N · prompts M · tool calls K`, where `M` counts `llm_call` events
(one per round, so a tool-looping prompt contributes more than one) and `K`
counts `tool_call` events as before. The count is taken from the same
`LOG_WINDOW`/stream line arrays the panel already builds, so it stays O(window).

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
