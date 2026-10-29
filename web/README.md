# web/ — the app

The browser target is **the product**: the only UI and the only agent host.
`src/` now contains pass-through channels only (telegram mailbox, storage
bridge, STT) — there is no admin server, no `BOB_WEB`, and no Node agent.

```
npm run build:web        # vite build -> web/dist
npm run web:standalone   # static loopback server on :8080 (PORT/HOST override)
```

Every `/api/*` call is answered by the in-browser backend
(`web/src/server/local-backend.ts`). Settings, credentials (localStorage, per
browser), models, profiles and the tiled app all run client-side.

Companion channels — one process, one port (`npm run bob`, loopback only):

| Channel | Route | What it does |
|---|---|---|
| Telegram | `:8795` `/api/*` | grammY long-poll; parks text + channel-side voice transcripts in a file mailbox (`~/.bobkat/telegram/`); the tab claims and answers them |
| Storage bridge | `:8795` `/roots`, `/fs/*`, `/git`, `/sql/*` | real folders as desktop profiles; `POST /roots` registers them, requests select one with `x-bob-root` |
| STT | `:8795` `/stt` (`BOB_STT=1`) | raw audio bytes → ffmpeg → whisper-server → transcript (used by the composer) |
| Whisper | `npm run whisper:up` (`:8178`) | the transcription backend both paths call |

The same modules keep their standalone CLIs (`npm run storage-server`,
`npm run web:standalone`) for debugging a listener in isolation.

Same-origin tabs sync live (BroadcastChannel); cross-device pairs through the
Sync… → Live sync dialog (WebRTC; BobSwap REST or manual paste).

> The sections below grew with the milestones and are kept as the record of
> how the browser target reached parity — the *current* contract is the one
> above plus the root `README.md` and `feature-plans/standalone-only.md`.


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
| `tree-sources` + `tree-files` in the browser | done — **verified in real Chromium** |
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
telegram channel (`src/index.ts`, loopback `:8795`) only parks and forwards
text (inbox, ack, relay, host heartbeat; state under `~/.bobkat/telegram`).
Nothing is stored in the workspace — no session adoption, no log writes; the
OPFS session never exists outside the page.

While the tab heartbeats, the channel binds its chat to this page's profile
and parks new messages for it; the tab claims them, answers in this page's
session, relays the reply, then acks. Turns typed in the web chat mirror
their answer to the phone the same way — output only, in relay order, so the
phone reads the same thread without echoing what the browser already shows.
A second tab that takes the chat over bumps the epoch; relays carrying an
older one (a suspended tab answering late) are dropped. Voice notes are
transcribed channel-side and parked as text; photos and documents get a
text-only reply. The one-way *✈ telegram* push dumps a transcript and pins
the bridge to the session it was sent from.

### Session memory panels after reload / restart

The tiled memory panel is process state: the Node admin keeps it in memory, the
browser target keeps it in the page. Both would come up empty — the admin after
a process restart, the tab after a reload — so both rebuild it lazily from the
run log the first time a session is viewed. One tracker serves both hosts
(`src/memory-track.ts`; wired in `src/admin.ts` and
`web/src/server/local-backend.ts`), and `?session=` on `/api/tree/memory`
selects the conversation being rebuilt/served. While a turn runs, both hosts
stream `memory` pushes naming the session, so the panel merges writes
mid-turn.

A rebuild replays the log rows and then re-applies the values this page tracked
live, so the order does not matter: a panel fetch that overlaps a running turn
still restores the earlier turns' slots (the old one-shot skip dropped them for
the page's lifetime), and a value the log does not hold yet — a mid-turn write
— survives the replay. A pattern switch resets the tracked values unsealed, so
each session's next view replays the log again; only deleting a session keeps
its map dropped for good.

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

### A paused turn resumes across a reload

The engine pauses a tree at `Human()` with a **checkpoint**; BOB's browser
logger shadows it into the run log's `checkpoints` table (grandma-kat's
portable `createSessionLogStore`, wired in `web/src/agent/logger.ts`). On the
first turn of a fresh worker the host asks `resumableCheckpoint` which pause
belongs to the chat — the last turn marker's run, while that run still has a
checkpoint and no delete tombstone follows it — then `restore()` hydrates the
run's replay window and the engine's own `resume()` continues the conversation.
Same run id, same memory slots; the tracker is not involved.

A missing or torn checkpoint (a flush killed mid-write) drops to a fresh tree
with a logged reason instead of resuming into a partial log. Each turn records
`runMode` (`resumed` / `restored` / `fresh`) and `contextLost`, so the chat can
say "continued the paused session from before the reload" or warn that prior
context was not available. Restore is browser-storage only: in desktop-bridge
mode the shared log's continuation policy belongs to the Node agent.

### Direct folder mode (Chromium)

```sh
npm --prefix web run build      # or: npm run build:web (rerun after changes)
npm start                       # http://127.0.0.1:8080 -> Storage: Desktop (direct folder)
```

Pick the workspace folder once. The handle is stored in IndexedDB; after a
reload the browser only needs one click to re-grant permission (a browser rule,
not an app choice). The tab then reads and writes the **real** folder — file
tools, patterns, the file browser and `git_status` all operate in
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

The demo (`src/main.ts`) runs the real `listTreeSources` and tree loading
over OPFS, proving the alias approach.

## Run

The browser target is served by the combined process (`npm run bob` in the
repo root → `http://localhost:8080`), or by `npm run web:standalone` when you
want the app alone. See [Standalone](#standalone-no-admin).

```sh
cd web
npm install
npm run make-seed /path/to/grandma-workspace   # pack workspace -> public/seed
npm run smoke      # headless end-to-end check against :8080
```

`npm run make-seed` turns a real grandpa-bob workspace (default
`$WORKSPACE_DIR` or `../../workspace`) into `web/public/seed/workspace.json`.
On first load the app imports it into OPFS (`?reseed=1` forces a re-import);
after that the browser workspace persists on its own. The sidecar
`seed/meta.json` now records `sha256` and `size` beside `createdAt`, so the
toolbar can offer an update even when a re-pack happens to reuse the same
timestamp.

To ship that packed seed to a BobSwap shelf without it drifting, publish the
exact bytes (from the repo root). The first interactive run asks for the
account, seed name and upload key (input hidden) and offers to save them in
`~/.bobkat/bobswap.json` (0600); the key is only remembered once the
service has accepted it, so later runs need no arguments:

```sh
npm run seed:ship                     # make-seed, then publish
npm run seed:publish -- --dry-run     # validate + print only
```

A publish without `--pack` ships the existing file unchanged. Interactive runs
now warn about that, and every successful publish prints the shelf's resolved
`latest` (version label, `createdAt`, sha) — the exact record browsers compare
against — so a stale or shadowed upload is visible immediately.

Non-interactive/CI: `BOBSWAP_ACCOUNT=… BOBSWAP_SEED=… BOBSWAP_UPLOAD_KEY=… npm
run seed:publish`. `--url` defaults to `https://bobswap.hfxaiguy.com`; `--file`,
`--version`, `--pack` and `--no-save` are available (`npm run seed:publish --
--help`; `BOBSWAP_CONFIG` moves the saved file). The script computes the
content-addressed version (`<sha12>-<compact createdAt>`), warns if `meta.json`
is stale, and reports 200 (identical), 201 (new) or 409 (conflict) from the
service.

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
  `setActiveFs()`, so `tree-sources`/`tree-files` read the desktop workspace;
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
the admin running. It exercises OPFS writes/rename, tree discovery,
`grandma-kat knit()`, WASM SQLite persistence, and a real LLM
round-trip — this is the older demo runner (`#out`). The storage-mode checks are
`npm run smoke:browser` and `npm run smoke:direct` (both need the admin and
Chromium; `smoke:direct` fakes the folder picker to a real OPFS directory
and asserts file writes plus the sqlite read-only/write-back behavior).
The profile flows have two more headless checks against the standalone build
(`npm run web:standalone` from the repo root, port 8080):
`npm run smoke:profiles` (pre-profile migration, create/switch, export scoping,
seed-binding persistence) and `npm run smoke:seed-update` (banner, apply, run-log
preservation and version recording against a fake BobSwap service). Both accept
`CHROME_BIN` like the other smokes.

The pairing phrase (short authentication string) has its own check that needs
no app build or server: `npm run smoke:pairing` starts a throwaway Vite dev
server, completes a real two-peer WebRTC offer/answer in headless Chromium, and
asserts both sides derive the same six words and that a substituted certificate
fingerprint changes them.

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

- **Export** downloads the active profile's workspace as `bob-workspace-<date>.json`:
  every file in that profile — `app/`, `patterns/`, `lib/`, the app `.db` files and
  `logs/grandma-kat.db` (which holds the browser chat sessions). The run log is
  exported as a logical SQLite snapshot, not as the streaming VFS's internal
  files; an import stages that snapshot and the next boot replaces the
  profile's log with it. The format is the same `WorkspaceArchive` v1 the seed
  uses, so a `make-seed` file can be imported too.
- **Import** merges an archive over the active profile: files with the same
  path are overwritten, files the archive does not carry are kept. It validates
  the archive first, asks for confirmation, then reloads the tab so the
  platform, fs index and sqlite worker re-read the restored files. When the
  archive has no `.seeded` marker one is written, so the shipped seed cannot
  re-import over the restored workspace on the next boot.

The archive is base64-in-JSON (binary-safe, dependency-free), so expect it to be
about a third larger than the workspace and to be built in memory.

## Workspace profiles (browser OPFS)

The browser target keeps several **profiles**: independent workspaces in the
same origin's OPFS, switched from the toolbar's **Profile** picker (switching
reloads the tab).

- Every profile lives at `/profiles/<name>/`; `/profiles.json` in the OPFS root
  is the registry (name, timestamps, optional seed source). The active name is
  in localStorage (`bob:profile`), so each browser/phone keeps its own selection.
- An installation from before profiles is moved once into
  `/profiles/default/`. The move is marked in `/migration.json`, resumes if the
  tab closes mid-copy, verifies file count and total bytes, and only then removes
  the originals — a failed verification keeps both copies and refuses to boot.
- The **Profiles…** entry in the toolbar's **Sync…** dialog creates a new
  workspace only after an explicit seed pick — the bundled snapshot or any seed
  listed on a configured BobSwap service (a binding is stored and its archive is
  pulled immediately). A copy of the current profile and desktop folder profiles
  don't need a seed. Deleting non-active profiles is also there. Each profile
  has its own `workspace/`, run log, chats, patterns and git history.
- **Export**/**Import** and the BobSwap flows act on the **active** profile.
  Archive paths stay `workspace/...`, so the same file can be imported into any
  profile, any device, or packed by `make-seed`.
- Desktop (local server) mode is unchanged: one workspace, profile controls
  hidden.

## Seed sources (BobSwap seed shelf)

A profile can be bound to a seed on a BobSwap service, so updates can arrive
later (`Sync…` → `Profiles…` → **Seed…**). New browser profiles pick their seed
up front: **Profiles… → New profile** offers the bundled snapshot plus every
seed returned by `GET /api/v1/<account>/seeds` on each configured service, and
pulls the chosen archive before the profile is created (nothing is created if
the pull fails). The pick has no default — Create stays blocked until a seed is
chosen.

- The **BobSwap…** dialog stores the service URL, realtime endpoint/key, account
  and API keys in this browser's localStorage (`bob:swap`); **Seed…** only asks
  which service and the seed name. Keys never enter the workspace or an
  export. New setups prefill the deployed service at
  `https://bobswap.hfxaiguy.com`; any saved service overrides it. API keys are
  operator-issued (`read`/`upload`/`manage` scopes); there is no public signup.
- On boot — and every five minutes while the tab stays open, plus whenever it
  becomes visible again — the profile asks
  `/api/v1/<account>/<seed>/latest/meta` and, when the seed is newer, shows the
  usual **Workspace update available** banner (never applies silently). A
  publish cannot push to an open tab, so the periodic check is what makes a
  shelf update arrive without a reload (`?seedpoll=<ms>` shortens it for
  tests). Each check logs a `[seed-check]` line naming the local and remote
  sha/timestamp and the decision, so a refused key or a malformed response is
  visible instead of looking like "current". Applying merges the archive and
  **keeps the local run log and chat history**; saved walk positions reset
  once.
- **Publish this profile** uploads the current workspace as a new version
  (`<sha12>-<compact createdAt>`), **Check now** compares on demand.
- `X-Seed-Version` and ETag/304 keep repeat checks cheap; `?key=` URLs make the
  same flow usable from a phone link.

## Sharing a workspace between devices (zero storage)

Toolbar **Sync…** → **Send…**/**Receive…** move a workspace copy between two
open tabs through a BobSwap relay:

- Each share creates a fresh channel; the sender shows a 6-digit pairing code
  and a 4-character visual check that must match on both screens. Nothing is
  stored on the service — both tabs must stay open, and losing a connection
  discards the transfer (nothing to resume). Copy mode only; ownership swaps are
  a later step.
- Data is sliced into 192 KiB chunks (~256 KiB base64 messages) over the
  ephemeral broadcast topic named by the service (event `relay`), acked
  individually and verified with SHA-256. The receiving tab reassembles in
  memory and only then imports. The control plane (state, status, delete) is
  driven with the role tokens from the offer/join responses.
- The receiver chooses **current profile** or **as a new profile** (created on
  the spot). Relay copies include `workspace/logs/`; seed *updates* do not
  overwrite an existing log.
- Pairing codes must never be put in URLs (the service rejects URL API keys and
  this would leak the secret). Share the channel id and code out-of-band.
- The default service's realtime endpoint is Supabase (`iqrsezxlgcfqxaiytsjj`)
  with its public publishable key; both fields are editable in the BobSwap…
  dialog for other deployments. See `/docs/agents` on the service for the
  authoritative API reference.

## Standalone (historical: there is no admin to stop)
The standalone-vs-admin split is gone — `npm run web:standalone` is simply *the* run command. The notes below describe the old mode boundary and stay for the record:
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
(localStorage), never in the workspace or the seed. For a key without a
shortcut field, press **+ Add key** — the name goes in the left box, the value
on the right — then **Save all keys**. The Settings **Models JSON** editor
overrides the seed file, and the **Test** button probes an endpoint from the
tab.

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

Exa web search (`exa_search`) *does* work in the browser: `api.exa.ai` answers
the preflight for `POST` with `authorization` + `content-type`, so the tool
calls it directly from the tab (no proxy). Paste the key under **Settings →
Credentials & .env → Exa search API key**; it is `EXO_API_KEY` in `.env`, the
name the Node target has always read. Without a key the tool stays in the
registry and answers `error: web search not configured`, exactly like Node.
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
