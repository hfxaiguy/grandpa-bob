# web/ — browser target

A second target for grandpa-bob that runs **entirely in a browser tab**: no
server, sandboxed virtual filesystem (OPFS), WASM SQLite, workspace persisted
in browser storage.

> **Additive.** The Node target (`src/`, `npm start`) is unchanged and keeps
> Telegram, the real shell, native SQLite, the git CLI, `opencode`, and
> the HTTP admin server. This directory only *adds* a browser build.

See the design plan: `~/.opencode/plan/bob-in-browser.md`.

## Serving modes (`BOB_WEB`)

`npm start` serves this build at `:8080` in one of two modes:

- **static — default** (`BOB_WEB` unset or `0`): the port serves only
  `web/dist`, and every `/api/*` answers `503 {"admin": false}`. The tab boots
  the in-browser backend (`web/src/server/local-backend.ts`), so chat **and the
  settings page** run client-side. The settings page probes
  `/api/capabilities` once and keeps server-only controls (restart, Telegram
  follow, bot logs, service health) visible but disabled, with a *browser only*
  chip. A direct `/settings` hit redirects to `/` — the settings page is an
  in-page iframe there.
- **api** (`BOB_WEB=1`): the full admin server on the same
  port — chat SSE, the settings API against the real `.env`/secrets, the
  Telegram bridge and the monitors. `npm run dev` stays in static mode but
  keeps Vite HMR; use `npm run dev:with-server` for dev + admin.

To run the UI with no BOB process at all, use `npm run web:standalone`
(`web/scripts/serve.mjs`; `PORT`/`HOST` overridable).

Shortcuts for the admin mode: `npm run start:with-server` (built `dist/`) and
`npm run dev:with-server` (tsx + Vite HMR) export `BOB_WEB=1` before starting.
`npm run dev` alone is already in api mode — `BOB_DEV=1` implies it.

## Status — milestone 1 (virtual FS / platform seam)

| Piece | State |
|---|---|
| Shared pure path shim (`src/platform/paths.ts`) | done, tested vs `node:path.posix` |
| Shared pure SHA-256 (`src/platform/sha256.ts`) | done, tested vs `node:crypto` |
| Platform interfaces (`src/platform/types.ts`) | done |
| Node adapter (`src/platform/node.ts`) | done |
| In-memory adapter (`src/platform/memory.ts`) | done, used by tests |
| OPFS `FileSystem` (`web/src/platform/corefs.ts`) | done — **verified in real Chromium** |
| Browser adapter (`web/src/platform/browser.ts`) | fs/path/crypto wired; shell + git stubbed |
| `FileTools` over Platform | done (`test:platform`) |
| `attachments` over Platform | done (`test:attachments`) |
| Pure model parser (`src/model-config.ts`) | done (`test:models`) |
| `node:*` shims + Vite aliases (`web/src/shims/*`) | done — existing shared modules bundle |
| `tree-sources` + `tree-versions` in the browser | done — **verified in real Chromium** |
| `grandma-kat` runtime in the browser | done — **verified in real Chromium** (`knit()` with `logger:false`) |
| `SqliteTools` over `Platform.sqlite` | done; Node adapter (`test:sqlite`) + **browser sqlite-wasm worker, verified in real Chromium** |
| Virtual coreutils (`src/platform/coreutils.ts`) | done (`test:coreutils`); browser `Shell` uses them |
| Agent worker + tool registry + event stream | done — **verified in real Chromium** (streams events, runs file/SQL/shell tools) |
| Pattern module loader (OPFS + grandma-kat/node injection) | done — **verified in real Chromium** (loads a pattern and runs Prompt+Call) |
| Remote LLM (`models.json` from OPFS + settings) | done — **verified in real Chromium** against a mock OpenAI-compatible endpoint |
| Durability (persist request + workspace export/import) | done — toolbar Export/Import; **verified in real Chromium** (export download + merge import) |
| Chat UI driving the agent worker | done — **verified in real Chromium** (smoke types a message, gets the LLM reply) |
| Git auto-commit (`isomorphic-git` over OPFS) | done — **verified in real Chromium** (`git: auto-commit 5be3f65`) |
| Clone from a CORS git remote into OPFS | done — **verified in real Chromium** (`clone: … -> 5 trees (trunk: true)`) |
| Git tools BOB can call (`git_status/log/commit/fetch/push`) | done — **verified in real Chromium** (`git-tools: branch=master changes=186 commits=5`) |
| Multi-file patterns (relative imports + named exports + node shims) | done — **verified in real Chromium** (`read/the notes file`) |
| Real `trunk` (scratch builder, app `src/*`, `appTreeNames()` scan) | not yet |

## Main-and-only UI (2026-10-19)

The web target is now the primary interface. Machine-tagged emits —
`Emit("input: …", flag("machine"))` in a tree — appear in app chats as faded,
teal-tinted notes by default; the toolbar **machine** button (or the same
checkbox in the session drawer) hides them. This keeps tree input, waiting
notes and hand-offs visible without mixing them into the normal reply stream.

| Piece | State |
|---|---|
| `File System Access` adapter (`web/src/platform/fsaccess.ts`) | done — folder picked once, handle in IndexedDB, one-click re-grant |
| Handle filesystem shared with OPFS (`web/src/platform/handle-fs.ts`) | done — `test:fsaccess` |
| isomorphic-git over a real folder (`web/src/platform/git-handle.ts`) | done — `test:fsaccess` |
| SQLite over the real `.db` files (`initSqlite(handle, {writeBack})`) | done — read-only by default, `SQL writes` toggle |
| Served at `:8080` by the admin server (chat = front page) | done — falls back to `ui/dist` when `web/dist` is missing |
| Voice input (mic button) | **removed** — transcription is Telegram-only; the web UI ships no STT, no in-browser model (`/api/transcribe*` answers 501 in browser mode) |

### Telegram bridge (browser target)

The session drawer's *bridge this chat to Telegram while the tab is open*
toggle connects the OPFS conversation to a Telegram chat two ways. The tab is
the brain: turns run against the OPFS continuation and memory, and the
`/api/telegram/*` endpoints on the admin only relay text (heartbeat, inbox,
relay). Nothing is stored server-side — no session adoption, no log writes,
no follow binding; the OPFS session never exists outside the page.

While the tab heartbeats the bot defers that chat's messages to the browser.
If the tab goes away (closed, asleep, or the toggle is turned off) the bot
answers in its own session after 15 s, prefixing the first reply with a
one-line marker — a fallback identity, not the same conversation. Relays that
arrive after such a fallback are dropped. Text only for now: voice notes and
photos still run server-side. The one-way *✈ telegram* push is hidden in this
target (the bridge replaces it); it remains for server-served sessions.

### Session memory panels after reload / restart

The tiled memory panel is process state: the Node admin keeps it in memory, the
browser target keeps it in the page. Both would come up empty — the admin after
a process restart, the tab after a reload — so both rebuild it lazily from the
run log the first time a session is viewed. One tracker serves both hosts
(`src/memory-track.ts`; wired in `src/admin.ts` and
`web/src/server/local-backend.ts`), and `?session=` on `/api/tree/memory`
selects the conversation being rebuilt/served.

The rebuild reads **raw** `calls` rows for each turn's seq bounds
(`WebLog.memoryWrites` / `log-store.memoryWrites`), not the sanitized per-turn
event window:

> **Known limitation — event-window tail cap.** The per-turn event window
> (`turnEvents` in `src/web-log.ts` and `web/src/agent/log-store.ts`, exposed as
> `getTurns(..., { withEvents: true })`) keeps only the last
> `MAX_TURN_EVENTS` = 500 events of a turn, and sanitization truncates strings
> (`MAX_EVENT_STR` = 400) and collapses arrays for streaming. Anything derived
> from that window only sees the tail of a very long turn: a slot written early
> in one would be missing, and its value would be lossy. That is why the memory
> rebuild has its own raw, uncapped read — a slot written at any point in a long
> turn still restores.
>
> Remaining memory-rebuild limits: turns whose markers have no run bounds
> (legacy/migrated rows) cannot be replayed, and the live map holds at most 32
> sessions (LRU; an evicted session rebuilds from the log when viewed again).

### Direct folder mode (Chromium)

```sh
npm --prefix web run build      # or: npm run build:web (rerun after changes)
npm start                       # http://127.0.0.1:8080 -> Storage: Desktop (direct folder)
```

Pick the workspace folder once. The handle is stored in IndexedDB; after a
reload the browser only needs one click to re-grant permission (a browser rule,
not an app choice). The tab then reads and writes the **real** folder — file
tools, patterns, tree versions, the file browser and `git_status` all operate in
place, with no storage-server process.

`SQL writes` is off by default: querying `contacts.db` / `comms.db` / `email.db`
works, mutation tools report that writes are disabled, and `logs/grandma-kat.db`
stays writable for BOB's own run log. Enable it to let `sql_write` persist
changes to the real `.db` files (single tab at a time; the file is imported on
open and exported after a mutation).

Firefox has no File System Access API: pick **Desktop (local server)** there —
the bridge implements the same `Platform` interface over loopback HTTP.


## `node:*` shims

Existing NodeNext shared modules bundle unchanged via Vite aliases:

| Import | Browser target |
|---|---|
| `node:fs` / `node:fs/promises` | OPFS (`corefs.ts`) |
| `node:path` | shared pure POSIX shim |
| `node:crypto` | shared pure SHA-256 + WebCrypto |
| `node:os`, `node:util`, `node:url` | small shims |
| `node:sqlite` | throwing stub (milestone 2) |
| `node:child_process` | throwing stub (milestone 5) |

The demo (`src/main.ts`) runs the real `listTreeSources`, `snapshotTree`, and
`promoteTree` over OPFS, proving the alias approach.

## Run

The browser target is normally served by grandpa-bob's admin (`npm run dev` in
the repo root → `http://localhost:8080`, or `ADMIN_PORT`). To run it with the
admin stopped, see [Standalone](#standalone-no-admin).

```sh
cd web
npm install
npm run make-seed /path/to/grandma-workspace   # pack workspace -> public/seed
npm run smoke      # headless end-to-end check against :8080
```

`npm run make-seed` turns a real grandpa-bob workspace (default
`$WORKSPACE_DIR` or `../../workspace`) into `web/public/seed/workspace.json`.
On first load the app imports it into OPFS (`?reseed=1` forces a re-import);
after that the browser workspace persists on its own.

### Clone from a git remote instead

Browsers cannot use `git://` (no raw TCP), so serve a repo over CORS-enabled
HTTP. `npm run git-server` fronts `git http-backend`:

```sh
npm run git-server /home/love        # -> http://127.0.0.1:8790/grandma-workspace.git
```

Then point the app at it (persisted in localStorage) or per load:

```
http://localhost:8080/?remote=http://127.0.0.1:8790/grandma-workspace.git
http://localhost:8080/?remote=...&reclone=1   # clear OPFS and clone fresh
```

The app clones into `/workspace` when it has no `.git`. To also **push** back
(copy browser → desktop), enable receive-pack on the bare repo:
`git -C <repo>.git config http.receivepack true` (loopback only; add auth before
exposing it).

### Browser tools (local Chrome)

`browser_exec`, `browser_clickables`, `browser_body` and `browser_click` run
in the agent worker and drive a local Chrome over CDP. The verbs themselves
(names, descriptions, schemas, bodies, cursor-listener confirmation) are the
workspace app's `app/browser/src/verbs.js`, evaluated through the module loader;
the worker supplies only the transport. A worker cannot
launch Chrome, and the `/json/*` discovery endpoints are CORS-gated, so one
script does both: it starts Chrome with a debug port and
`--remote-allow-origins` (and no startup window — the automation window appears
when a tool first opens a page), then opens the app in **FireDragon** (or the
first installed FireDragon/Firefox, or `BOB_BROWSER_BIN`) with the browser-level
WebSocket URL in `?cdp=…` (persisted in localStorage).

FireDragon is Firefox-based and has no CDP endpoint, so it is only the display
browser — the automation Chrome stays in the background. The four tools drive
Chrome, not FireDragon.

```sh
npm run chrome                                  # FireDragon + background Chrome
BOB_BROWSER_BIN=/usr/bin/firefox npm run chrome # choose the display browser
BOB_NO_CDP=1 npm run chrome                     # no Chrome; browser_* tools off
BOB_NO_OPEN=1 npm run chrome                    # print the URL only
BOB_APP_URL=http://127.0.0.1:8080 npm run chrome  # explicit app URL (e.g. standalone)
```

It reuses a Chrome already listening on the port, prints the URL, and runs
headless with `BROWSER_HEADLESS=1`. Without a `?cdp=` endpoint the four tools
return a "run `npm run chrome`" error instead of dying on `node:child_process`.

### Storage backend selector (browser OPFS vs desktop)

The header has a **Storage** selector:

- **Browser (OPFS)** — everything lives in the browser (the mode above).
- **Desktop (direct folder)** — a real folder picked with the File System
  Access API (Chromium only). The tab reads/writes it in place; no server.
  See [Direct folder mode](#direct-folder-mode-chromium) above.
- **Desktop (local server)** — BOB's file/shell/git tools operate on the real
  workspace via a loopback bridge (works in any browser, including Firefox):

```sh
npm run storage-server /home/love/grandma-workspace   # -> http://127.0.0.1:8795
# then pick "Desktop (local server)" in the header (persisted in localStorage)
# or load ?storage=desktop&server=http://127.0.0.1:8795
```

The bridge is sandboxed to the workspace root and loopback-only. In desktop
mode BOB operates on the real workspace:

- **files + shell + git** via the bridge (`platform.fs`/`platform.git`);
- **SQLite** via the bridge's `node:sqlite` routes, so `sql_*` tools work;
- **discovery follows the backend** — the `node:fs` shim is repointed with
  `setActiveFs()`, so `tree-sources`/`tree-versions` read the desktop workspace;
- **git sync to a branch** — `git_push` takes a `branch` (default `main`) and
  the bridge runs `git push <remote> HEAD:refs/heads/<branch>`.

The chat uses the workspace's **real `trunk` tree when present** (else the
`sync` assistant). The worker keeps a per-pattern session and drives trunk's
`Human("main_input")` pause/resume across messages, surfacing emits as the
assistant reply. Trunk's tool list includes `git_status`/`git_commit`/
`git_push`/`git_fetch` and its system prompt explains the sync flow, so with a
tool-calling model “sync workspace git to main” commits then pushes.

There is also a **Sync** button in the header: it stages every change (including
deletions), commits, and pushes to the remote + branch you enter
(`git commitAll` + `git_push`). In desktop mode the remote can be a local bare
path (e.g. `/home/love/grandma-workspace.git`); in browser mode it must be a
CORS http url. `?gitremote=…&gitbranch=…` preconfigures it.

`npm run smoke` needs a Chromium/Chrome binary (override with `CHROME_BIN`) and
the admin running. It exercises OPFS writes/rename, `tree-versions`
snapshot/promote, `grandma-kat knit()`, WASM SQLite persistence, and a real LLM
round-trip — this is the older demo runner (`#out`). The storage-mode checks are
`npm run smoke:browser` and `npm run smoke:direct` (both need the admin and
Chromium; `smoke:direct` fakes the folder picker to a real OPFS directory
and asserts file writes plus the sqlite read-only/write-back behavior).

The LLM smoke also needs the mock endpoint: `npm run mock-llm` (port 8787) in a
second terminal, plus a registry that points at it. On the standalone server
paste the three `:8787` mock slots into Settings → Models JSON (Settings
overrides the seeded template); when the admin serves the page, its
`models.json` is authoritative.

### Workspace backup and restore (Browser OPFS)

The toolbar has **Export** and **Import** in Browser (OPFS) mode; both are
hidden in Desktop mode, where the workspace is the real folder. OPFS is
evictable unless the browser grants persistent storage, so this backup is a
first-class control.

- **Export** downloads the whole tab workspace as `bob-workspace-<date>.json`:
  every file in OPFS — `app/`, `patterns/`, `lib/`, the app `.db` files and
  `logs/grandma-kat.db` (which holds the browser chat sessions). The format is
  the same `WorkspaceArchive` v1 the seed uses, so a `make-seed` file can be
  imported too.
- **Import** merges an archive over the current workspace: files with the same
  path are overwritten, files the archive does not carry are kept. It validates
  the archive first, asks for confirmation, then reloads the tab so the
  platform, fs index and sqlite worker re-read the restored files. When the
  archive has no `.seeded` marker one is written, so the shipped seed cannot
  re-import over the restored workspace on the next boot.

The archive is base64-in-JSON (binary-safe, dependency-free), so expect it to be
about a third larger than the workspace and to be built in memory.

## Standalone (no admin)

The browser target can run with grandpa-bob's admin completely stopped:

```sh
npm run build:web          # or: npm --prefix web run build
npm run web:standalone     # http://localhost:8080
```

`web/scripts/serve.mjs` is a zero-dependency loopback static server for
`web/dist`; it answers `/api/*` with 404 because there is no admin API. Use
Browser (OPFS) storage — or Desktop (direct folder) — neither needs a server
for files, SQL, git or patterns. Telegram, transcription, the storage bridge
and the `/api/llm` proxy are server-only and stay unavailable by design.

If port 8080 is taken (usually by the admin), stop it or choose another origin:
`PORT=8090 npm run web:standalone`.

### Models in standalone

The seed carries `models.json` from `web/public/models.standalone.json`: the
neuralwatt slots (`v4`, `v4.1`) with `cheap → v4` and `strong → v4.1`. Keys are
`${NEURALWATT_API_KEY}` — paste the key into **Settings → Credentials &
.env → Neuralwatt API key**; it is stored in this browser profile
(localStorage), never in the workspace or the seed. The Settings **Models JSON**
editor overrides the seed file, and the **Test** button probes an endpoint from
the tab.

The picker marks the auto-generated `:8787` registry ("mock models only") when
no real registry is configured. Profiles seeded before this change are upgraded
automatically while their `models.json` is still that old mock file; a
hand-edited registry is never overwritten. `?reseed=1` re-imports the whole
seed. A tab that was loaded from the admin also falls back to this browser
registry if the admin stops mid-session.

Ollama Cloud (`ollama.com`) is intentionally not in the standalone registry: it
sends no `access-control-allow-origin` header (the preflight answers `405` on
both `/api/chat` and `/v1/chat/completions`), so a browser cannot call it
directly. The `gemma` slot remains available when the admin serves the page.
neuralwatt answers `access-control-allow-origin: *`, so direct browser calls
work.

## Architecture

```
                     shared core (src/)
        (agent loop, tool registry, tree logic, prompts)
                    /                    \
        Node target                    browser target (web/)
   src/index.ts (unchanged)         web/src/main.ts (+ Worker, later)
   node:fs / node:sqlite            OPFS / sqlite-wasm
   child_process / git CLI          virtual coreutils / isomorphic-git
   HTTP + SSE                       MessagePort (milestone 3)
   grammy (Telegram)                (none)
```

Shared code depends on the interfaces in `src/platform/types.ts`; each target
injects its adapter. The pure modules (`paths`, `sha256`) contain no Node
builtins, so they run in both.

## Why a pure SHA-256

grandma-kat's `definitionId` calls `createHash("sha256")` **synchronously** from
inside `knit()`, but WebCrypto's `crypto.subtle.digest` is async. The shared
`src/platform/sha256.ts` gives the browser a synchronous hash; the Node adapter
keeps using `node:crypto`. Both are checked against `node:crypto` vectors.
