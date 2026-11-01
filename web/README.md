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
| Peer mailbox | `:8795` `/api/v1/sync/*`, `/admin/*` | BobSwap-shaped pairing channels + loopback admin API for `npm run pair`; STT/health stay |
| STT | `:8795` `/stt` (`BOB_STT=1`) | raw audio bytes → ffmpeg → whisper-server → transcript (used by the composer) |
| Whisper | `npm run whisper:up` (`:8178`) | the transcription backend both paths call |

The same modules keep their standalone CLIs (`npm run storage-server`,
`npm run web:standalone`) for debugging a listener in isolation.

Same-origin tabs sync live (BroadcastChannel) when they share a profile.
Different profiles are different workspaces and pair through the
Sync… → Live sync dialog (WebRTC; BobSwap REST or manual paste). A profile may
also pair with a **desktop/server peer** (same channel flow, SAS, mirror and
allowlisted ops). The full model — profiles, git vs replica sync, pairing, the verification phrase,
and troubleshooting — is in
[docs/pairing-and-sync.md](../docs/pairing-and-sync.md).

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

## Emit components — app UI in the chat (2026-11-01)

An app tree can render a visual component in its chat tile instead of a text
bubble. The component lives beside the tree, in the app folder, under the same
child-module rules the module editor enforces:

```
app/contacts/
  tree.prod.mjs               ← the contacts app tree
  ui.mjs                      ← the contacts tile's component
  app/graph/                  ← a boilerplate input → emit sub-app
    tree.prod.mjs
    ui.mjs                    ← the contacts.graph tile's component
  ui/                         ← optional extra components (allowed: any .mjs)
    graph-card.mjs
```

Nested `app/` folders belong to sub-apps, so each sub-app keeps its own
`ui.mjs`; resolution is app-relative, which means `ui.mjs` emitted from
`contacts.graph` is `app/contacts/app/graph/ui.mjs`. Files must already exist
and must end in `.mjs` — the same confined-write rule as any child module.

Tool access follows the same nesting: the trunk sees only top-level app trees,
and an app tree automatically gets the app trees directly below it as tools.
`contacts.graph` is a tool of `contacts`, never of the trunk.

The emit attaches the component and still carries the fallback text. The
portable shape works anywhere a tree runs (including plain `node --test`):

```js
Emit({
  text: "Keith · 3 calls",
  component: "ui.mjs",
  props: { who: "Keith", count: 3 },
})
```

In BOB's browser host there is also sugar — the module loader injects a
component-aware `Emit` and a virtual `bob/ui` module:

```js
import { Emit } from "grandma-kat";
import { component } from "bob/ui";

Emit({ text: "Keith · 3 calls", who: "Keith", count: 3 }, component("ui.mjs"))
```

It merges into the same value: `props` is the object data minus
`text`/`buttons`/`level`, and `component("ui.mjs", props)` overrides the props
explicitly. The `bob/ui` import exists only in the browser loader, so a tree
that must also knit under Node should use the plain object shape. A path
starting with `app/` or `patterns/` is workspace-relative; trunk emits resolve
that way.

The module contract is vanilla JavaScript:

```js
// app/contacts/ui.mjs — runs in the sandboxed guest, default export:
export default function render(root, props, api) {
  root.textContent = `${props.who}: ${props.count} calls`;
  // api.action("value") feeds a reply back as if the user typed it
}
```

The chat fetches the source through `/api/component` and mounts it in an
iframe with `sandbox="allow-scripts"` — **no** `allow-same-origin` — so
workspace code is an opaque origin and can never touch the host tab, OPFS,
keys or sync. The guest reports its own height, and its messages come back
over postMessage (`bob-component-size`, `bob-component-ready`,
`bob-component-action`, `bob-component-error`, `bob-component-escape`). Each
component bubble also has a `⤢` control: it opens the same guest in a
near-fullscreen modal, mounted with fill mode so the component can use the
whole frame. The full-screen copy is a second sandboxed iframe (the inline one
is not moved), and Escape or the backdrop closes it. The emitted `text` is the
fallback whenever the source cannot be loaded or rendered, and it is what
Telegram shows — always include it. A failed view also shows a dim
`view unavailable — <reason>` line under that text (the full message stays in
the tooltip), so a missing module or a guest error is visible instead of
silently degrading. Turns persisted before components existed have no
`components` field in their marker; replay rehydrates it from the run log's
raw emit rows, so their graphs still appear after a reload. Components are
single-file for now: the guest imports one data-URL module, so sibling
imports do not resolve.

Tests: `npm run test:emit-value` (parsing/fallback) and
`npm run test:emit-component` (the sandboxed guest document).

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
context was not available.

### Desktop/server peer (optional)

The workspace always lives in the tab's OPFS. A profile can pair with a
desktop/server as another WebRTC peer; see
[Desktop/server peer](#desktopserver-peer-optional) below for the flow.


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
npm run make-seed /path/to/profile/folder      # pack workspace -> public/seed
npm run smoke      # headless end-to-end check against :8080
```

`npm run make-seed` turns a desktop profile folder (default
`$BOB_WORKSPACE/folders/seed`; `BOB_WORKSPACE` defaults to `~/.bobkat`) into
`web/public/seed/workspace.json`.
On first load the app first tries the public shelf named by
`web/public/seed-bootstrap.json` (see below), then imports the bundled archive
into OPFS (`?reseed=1` forces the bundled re-import). After that the browser
workspace persists on its own. The sidecar `seed/meta.json` records `sha256`
and `size` beside `createdAt`, so the toolbar can offer an update even when a
re-pack happens to reuse the same timestamp.

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
BOB_NO_OPEN=1 npm run chrome                    # print the URL and ?cdp= parameter only
BOB_APP_URL=http://127.0.0.1:8080 npm run chrome  # explicit app URL (e.g. standalone)
```

It reuses a Chrome already listening on the port, prints the URL and the
`?cdp=…` query parameter to append manually, and runs headless with
`BROWSER_HEADLESS=1`. Without a `?cdp=` endpoint the four tools
return a "run `npm run chrome`" error instead of dying on `node:child_process`.

**Hosted users** (no repo, no Node) use **Sync… → Connect browser…** instead:
the dialog copies a launcher command for Windows, macOS or Linux, and the
served scripts (`/scripts/bob-browser.sh`, `/scripts/bob-browser.ps1`) start a
separate automation Chrome, read the debugger socket and open the app with
`?cdp=…` — the same transport the launcher uses. The origin allowlist is set
from the app URL passed to the script, and on first connect Chrome may ask for
local-network access (`ws://127.0.0.1`); allow it. The opened URL contains the
machine's automation socket — it is local-only, but should not be shared.

### Message provenance — the ⓘ on a bot bubble

Every non-machine reply bubble carries an ⓘ that opens **"written from"**: the
prompt that produced the message, the memory slots and other pieces that prompt
read (with the row that wrote each), `ref://` handles inside the prompt, and the
ground facts the walk bottoms out on. **Trace deeper** walks the writers' own
reads another level (up to 6).

It is computed on click from the run log alone — nothing is written, and the
engine never reads it. `GET /api/provenance?turnId=&bubble=&text=&depth=`
(`web/src/server/local-backend.ts`) asks the worker (which owns the log DB) for
the walk (`web/src/provenance.ts`). The bubble is anchored by its text, falling
back to its emit index; a turn with no engine run answers a 404 the UI shows
as-is. A turn that is still running is traced from the page's own event rows,
so ⓘ works mid-turn before the logger's next flush. Regression:
`npm run test:provenance` knits a real tree (two memory slots + a prompt) and
asserts the prompt link, the depth walk, the nearest fallback and the endpoint.

### Desktop/server peer (optional)

There is no storage-backend selector: the workspace always lives in OPFS. A
profile can pair with a desktop/server using the **same channel flow as two
browsers** — a code, a DTLS verification phrase, then the same `SyncEngine`.

- On the desktop/server, `npm run pair` creates a mailbox channel on the
  existing `:8795` and prints a single-use 8-digit code, the mirror folder and
  requested exec allowlist. `--exec git,make,…` grants ops; `--list` and
  `--revoke <profile>` manage paired profiles. The code and session live in
  the bridge process: restarting `npm run bob` invalidates them, so run
  `npm run pair` again after a restart.
  Add `--debug` (`npm run pair -- --debug`, or `BOB_PAIR_DEBUG=1`) to log the
  admin calls and every pairing event: `waiting-offer`, `offer-received`,
  `answer-sent`, `channel-open`, `connected`, the control `hello`, and errors.
- In the tab: **Sync… → Pair… → Pair with a code**, select **My desktop /
  server**, and enter the code. Both sides show the same SAS; nothing syncs
  or executes before the operator approves on the console.
- First pairing: if the desktop folder already holds a workspace it replaces
  the profile's files; an empty folder receives the tab's workspace. Approval
  mints a per-profile client key and the tab pins a per-profile server proof
  key, so later boots reconnect without a human step.
- Mirror sync runs through the multi-peer engine (journal on the server lives
  outside the folder); conflicts keep both copies, and a convergence barrier
  makes an op's changed files visible before the tool result returns.
- Exec is `src/tools/shell.ts`: allowlisted `execFile`, cwd locked to the
  folder, argument path-escape guard, git deny-list, timeout/output caps. The
  agent worker routes only allowlisted commands to the peer over a
  `MessagePort`; everything else keeps using the local virtual shell.
- The Node peer uses werift and the same provider/`rtcPeer`/engine; local and
  remote deployments differ only in mailbox URL and ICE servers. To expose the
  mailbox beyond loopback:
  ```sh
  BOB_CHANNEL_HOST=0.0.0.0              # default is 127.0.0.1; put HTTPS in front
  BOB_APP_ORIGINS=https://bob.example.com
  BOB_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"}]'
  npm run bob
  ```
  The default `BOB_APP_ORIGINS` is
  `http://localhost:8080,http://127.0.0.1:8080,https://bobkat.hfxaiguy.com`;
  setting the variable replaces that list. The peer mailbox also accepts any
  loopback hostname/port. The admin API stays loopback-only; the
  mailbox/Telegram/STT share the port, so an operator exposing it must front it
  with HTTPS and a firewall. CORS preflights opt into Chrome's Local Network
  Access with `Access-Control-Allow-Private-Network: true`; the browser still
  asks the user to allow Local Network Access for a public HTTPS origin the
  first time.
- `/fs`, `/git`, `/sql` and `/roots` are **not mounted** by the product
  process. The standalone `storage-server.mjs` CLI keeps them for tests/debug;
  `/health` and the opt-in `/stt` remain on the channel server.

`npm run smoke` needs a Chromium/Chrome binary (override with `CHROME_BIN`) and
the admin running. It exercises OPFS writes/rename, tree discovery,
`grandma-kat knit()`, WASM SQLite persistence, and a real LLM
round-trip — this is the older demo runner (`#out`). `npm run smoke:browser`
needs the admin and Chromium. The profile flows have two more headless checks
against the standalone build (`npm run web:standalone` from the repo root, port
8080): `npm run smoke:profiles` (pre-profile migration, create/switch, export
scoping, seed-binding persistence) and `npm run smoke:seed-update` (banner,
apply, run-log
preservation and version recording against a fake BobSwap service). Both accept
`CHROME_BIN` like the other smokes.

The desktop/server peer has an end-to-end check (`npm run smoke:peer`): it
spawns the combined process, drives the real pair dialog, matches the SAS,
approves the mirror and exec capabilities, verifies mirror push/pull, runs an
allowlisted shell op with convergence, and reloads to test silent reconnect.

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

The toolbar has **Export** and **Import** for the workspace (Sync… → Transfer);
OPFS is evictable unless the browser grants persistent storage, so this backup
is a first-class control.

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
- The toolbar's **Profiles** dialog creates a new workspace only after an
  explicit seed pick — the bundled snapshot or any seed
  listed on a configured BobSwap service (a binding is stored and its archive is
  pulled immediately). A copy of the current profile needs no seed; a
  paired desktop/server profile starts from its folder (first pairing pulls it in).
  Deleting non-active profiles is also there. Each profile has its own
  `workspace/`, run log, chats, patterns and git history.
- **Hidden… except: is per profile.** **Profiles** → **Hidden… except:** picks
  the top-level apps that stay on the board; every other app starts in the
  hidden rail. Pick `contacts` and `files` to hide `kinit`, `email` and the
  rest, or leave every box unchecked for trunk alone. **Use trunk-only
  default** clears the list. Exceptions are re-applied on each load, each
  profile keeps its own board layout, and active apps can raise up to two tiles
  beside trunk.
- **Export**/**Import** and the BobSwap flows act on the **active** profile.
  Archive paths stay `workspace/...`, so the same file can be imported into any
  profile, any device, or packed by `make-seed`.
- A profile can pair with **one** desktop/server; the mirror folder is stored in
  the registry (`kind: "desktop"`, `folder`). Unbinding clears the local link;
  `npm run pair -- --revoke` removes the server credential.

## Seed sources (BobSwap seed shelf)

A profile can be bound to a seed on a BobSwap service, so updates can arrive
later (**Profiles** → **Seed…**). New browser profiles pick their seed up
front: **Profiles** offers the bundled snapshot plus every
seed returned by `GET /api/v1/<account>/seeds` on each configured service, and
pulls the chosen archive before the profile is created (nothing is created if
the pull fails). The pick has no default — Create stays blocked until a seed is
chosen. Listing that shelf (`/seeds`) needs a read key; a bound profile can
still follow a public newest version without one (see below).

**Fresh browsers** (no `.seeded` marker and no trunk tree) read
`web/public/seed-bootstrap.json` and try that shelf's newest public archive
before the bundled snapshot:

```json
{ "baseUrl": "https://bobswap.hfxaiguy.com", "account": "personal", "seedName": "trunk" }
```

That resolves to
`https://bobswap.hfxaiguy.com/api/v1/personal/trunk/latest` (the client always
appends `/api/v1/<account>/<seedName>/latest`).

The keyless pull verifies the archive against the response `ETag`, applies it,
and stores the seed binding + version so later boots keep watching the shelf.
If the newest version is private, the service is offline, or the pull exceeds
8 seconds, boot falls back to `/seed/workspace.json`. `?bootstrap=<account>/<seed>`
and `?bootstrap-url=<origin>` override the file for one tab; `npm run
smoke:bootstrap` uses them to point a fresh browser at a fake public service,
then repeats with the shelf private to check the bundled fallback. Forks that
do not publish to BobSwap can delete the file. The shelf must expose `/latest`
anonymously: mark the seed **public latest** in the BobSwap dashboard (future
uploads included), or mark the individual newest version public — no read key
is shipped.

- The **BobSwap…** dialog stores the service URL, account and API keys in this
  browser's localStorage (`bob:swap`); **Seed…** only asks which service and the
  seed name. Keys never enter the workspace or an export. New setups prefill the
  deployed service at `https://bobswap.hfxaiguy.com`; any saved service overrides
  it. API keys are operator-issued (`read`/`upload`/`manage` scopes); there is no
  public signup.
- On boot — and every five minutes while the tab stays open, plus whenever it
  becomes visible again — the profile asks `/api/v1/<account>/<seed>/latest/meta`
  (with a read key) and, when the seed is newer, shows the usual **Workspace
  update available** banner (never applies silently). A publish cannot push to
  an open tab, so the periodic check is what makes a shelf update arrive without
  a reload (`?seedpoll=<ms>` shortens it for tests). Each check logs a
  `[seed-check]` line naming the local and remote sha/timestamp and the decision,
  so a refused key or a malformed response is visible instead of looking like
  "current". Applying merges the archive and **keeps the local run log and chat
  history**; saved walk positions reset once.
- **Public versions need no key.** The operator can mark individual versions
  public in BobSwap's Seed shelf; a keyless client then reads `/latest` (only
  while the newest version itself is public) and verifies the archive against
  the response `ETag`, which carries the same SHA-256 as `/latest/meta`.
  Without a read key the check sends `If-None-Match`, so an unchanged public
  seed costs a 304 rather than a download. Listing the shelf and reading
  private versions still require a key; publishing a new private version locks
  `/latest` again for keyless clients.
- **Publish this profile** uploads the current workspace as a new version
  (`<sha12>-<compact createdAt>`), **Check now** compares on demand.
- `X-Seed-Version` and ETag/304 keep repeat checks cheap; public versions work
  from a plain link with no key, and `?key=` URLs remain supported for keyed
  services.

## Moving a workspace between devices

Two REST/peer paths cover this; neither stores workspace bytes on BobSwap:

- **New device:** bind it to a seed (**Profiles** → **Seed…** or the new-profile
  picker). The client downloads the newest version over plain REST and verifies
  its SHA-256. A public version needs no key; private versions need a read key.
- **Two live tabs:** **Sync…** → **Pair…** opens a WebRTC DataChannel and
  reconciles changes peer-to-peer. Signaling is either the BobSwap REST mailbox
  (a single-use 8-digit code exchanged out-of-band; channel ids stay internal)
  or a manual paste; the mailbox carries SDP/ICE only. Both sides show the same
  6-word verification phrase before any data moves; a MITM relay changes the
  DTLS fingerprints and the phrases stop matching.
- **No service at all:** **Sync…** → **Export**/**Import** moves a JSON archive
  by hand.

Pairing codes must never be put in URLs (the service rejects URL API keys and
this would leak the secret). See `/docs/agents` on the service for the
authoritative API reference.

## Standalone (historical: there is no admin to stop)
The standalone-vs-admin split is gone — `npm run web:standalone` is simply *the* run command. The notes below describe the old mode boundary and stay for the record:
The browser target can run with grandpa-bob's admin completely stopped:

```sh
npm run build:web          # or: npm --prefix web run build
npm run web:standalone     # http://localhost:8080
```

`web/scripts/serve.mjs` is a zero-dependency loopback static server for
`web/dist`; it answers `/api/*` with 404 because there is no admin API. The
workspace (files, SQL, git, patterns) needs no server. Telegram, transcription,
the peer mailbox/desktop ops and the `/api/llm` proxy are server-only and stay
unavailable by design.

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
