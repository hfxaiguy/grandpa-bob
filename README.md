# Grandpa Bob Bot

_BOB = **B**etter **O**rganizational **B**ot_

> **Standalone-only (2026-10)** — the browser app (`web/` + `ui/`) is the only
> UI and the only agent host. Node processes are **pass-through channels**:
> the **telegram channel** (grammY long-poll; messages are *parked* in a
> file-backed mailbox and answered by your browser tab — Node never runs the
> agent), the **peer mailbox** (`:8795` — desktop/server pairing, mirror and
> allowlisted ops; standalone `storage-server.mjs` is debug-only), plus opt-in
> STT with `BOB_STT=1`),
> and **BobSwap** (seed shelf). The shared core lives in
> `web/src` now; `web/` imports nothing outside `web/` + `ui/`
> (`npm run test:standalone` is the gate).
>
> Run one command:
> ```sh
> npm run bob              # app :8080 + peer mailbox/telegram :8795
> npm run whisper:up       # optional voice backend (:8178)
> ```
> `npm run bob` serves the built app and both channel APIs from **one
> process**; a missing `TELEGRAM_BOT_TOKEN` only leaves the bot off. The old
> single-purpose commands (`web:standalone`, `storage-server`) still work for
> debugging a listener in isolation.
>
> Work progressed against `feature-plans/standalone-only.md` — read it for the
> target architecture, the verification gates and current gaps. The sections
> below still describe parts of the pre-refactor harness where the refactor
> did not reach; where they disagree with this banner, the banner wins.

A local agent harness you chat with from Telegram — text, voice, photos, or files. It can
read, write and organize files on this machine inside a sandboxed workspace, and
every change it makes is **git-committed automatically**.

- **Telegram**: long polling via grammY. Works in DMs and in **forum-topic groups** —
  each topic is an independent conversation with its own history. In the
  standalone-only model the channel **parks** messages (including locally
  transcribed voice notes — `heard: "…"` never needs a browser tab) and your
  browser tab drains them: no tab connected means messages simply wait in the
  mailbox, surviving channel restarts.
- **Web UI** — the only interface, served by `npm run web:standalone` at
  `http://<host>:8080` (loopback static server; every `/api/*` call runs the
  **in-browser backend**). The workspace always lives in the tab's private
  OPFS sandbox, seeded from the workspace, with toolbar **Export**/**Import**
  for a whole-workspace JSON backup; **profiles** keep separate OPFS
  workspaces (switchable in the toolbar, each with its own chats, patterns, log
  and git history), and a profile can be bound to a **BobSwap seed** for
  updates.
  - A profile can **pair with a desktop/server** as another WebRTC peer: the
    desktop runs `npm run pair`, prints a single-use 8-digit code, and both
    sides compare the DTLS verification phrase before approval. The desktop
    folder becomes the profile's mirror and an allowlisted exec surface; the
    per-profile keys are pinned for silent reconnects. Local and remote servers
    use the same code-only flow.
  A **single-host lease** guarantees only one tab runs the agent per workspace
  (a second tab is read-only, with a *take over* button). A tab can also answer
  Telegram: the "bridge" toggle drains the channel's mailbox against a web
  session — `send to telegram` pushes a session transcript to the linked chat.
- **Voice → text**: Telegram voice notes are transcribed **channel-side** (the
  Vulkan whisper-server); the web UI routes its recordings through the bridge's
  opt-in `/stt` (no in-tab model download) — the Transformers.js path is not
  built.
- **Brain**: any OpenAI-compatible endpoint (default: Hugging Face router running
  Gemma 4), switchable via the browser settings; keys live per-browser
  (localStorage), never in the workspace.
- **Attachments**: web uploads are stored under `assets/inbox/` and passed to
  the tree as workspace-relative paths (excluded from git history). Telegram
  attachments are text-only in v1 — the phone is told to send them in the web
  chat.
- **Tools**: sandboxed file tools + an allowlist of shell commands.

## Architecture

```
┌───────────── browser tab — the only UI and the only agent host ─────────────┐
│  web/ + ui/  ·  agent tree runs here  ·  workspace: OPFS (per profile)     │
│  a profile can pair with a desktop/server that mirrors its folder          │
└──────┬───────────────────┬──────────────────────────┬──────────────────────┘
       │                   │                          │
  channels: one process (`npm run bob`)
  :8795  peer mailbox     ·  telegram mailbox API  sync channel (peer-to-peer)
   · folders (profiles)    · grammY long-poll      BroadcastChannel (same origin)
   · /stt (BOB_STT=1)      · park & forward mailbox WebRTC DataChannel (cross-device;
   · loopback only         · no agent               BobSwap REST or manual-paste
                                                    signaling; 6-word verify)
```

Everything is a **pass-through channel**: small loopback processes with no UI
and no agent. The browser tab runs the agent, holds the OPFS workspace, drains
the Telegram mailbox, and syncs with other replicas; a paired desktop/server
peer mirrors that workspace to a real folder and runs allowlisted desktop ops. BobSwap remains the
seed shelf it always was. The shared core lives in
`web/src` — `web/` must never import outside `web/` + `ui/`
(`npm run test:standalone` enforces it).

### How the continuous tree works

The agent runs as a single **grandma-kat tree** inside the browser worker:

```
Tree.name("agent")
  .human("main_input")           ← pause: wait for user input
  .memoryUpdate("messages", …)   ← append user message to history
  .branch(classify)              ← cheap model: "tools" | "direct"
  .branch(when "direct", direct) ← cheap model: text-only answer
  .branch(when "tools", tools)   ← strong model: tool-using loop
  .emit(…)                       ← non-blocking output to the tile
  .until(true)                   ← loop back to .human()
```

- **`.human()`** pauses the tree and checkpoints it into the renderer's run
  log (`.gpb-runlog`, the OPFS-backed SQLite stream). A reload restores a
  paused run; `/clear` (or a new chat) starts fresh. The run log always lives
  in the profile's OPFS directory; a desktop mirror never carries it.
- **`.emit()`** streams output to the tile without stopping the tree.
- **History** lives in the tree's `messages` memory slot; the continuation
  token persists the full scope chain (memory, history, execution position)
  in the run log.

### Journey of a voice message ("add milk to shopping.md")

1. The **telegram channel** (`src/index.ts`) receives the voice note; the auth
   gate checks your user ID and the topic becomes the conversation key.
2. The channel downloads the `.ogg`, converts it with ffmpeg to 16 kHz mono
   WAV, and POSTs it to whisper-server — transcription happens channel-side,
   so it works with no browser tab open.
3. The channel replies `heard: "add milk to shopping.md"` in the topic and
   **parks** the transcript in its file mailbox (`~/.bobkat/telegram/`).
4. Your browser tab claims the mailbox (the "bridge" toggle), runs the turn on
   its own workspace, and relays the answer back to the phone. No tab open?
   The message waits on disk until one connects.
5. The tree's classify branch routes to the tools branch. Gemma decides to call
   `read_file` → `edit_file`; each tool error goes back to the model as a
   normal string so it can retry.
6. `edit_file` writes the file, git-commits just that path, and the commit hash
   flows back into the tool result — isomorphic-git writes the OPFS repo; the
   mirrored folder carries a copy, not the live history.
7. The `.emit()` child streams the answer into the tile and the relay sends it
   to Telegram. The tree loops back to `.human()` and pauses.

### Layout

```
src/                 Node channels only (never the agent)
  index.ts           combined entry: app :8080 + channel APIs :8795
                     (grammY long-poll, mailbox/bindings; bridge mounted)
  bot.ts             telegram glue: auth gate, topics, channel-side STT, parking
  telegram-bridge.ts the file mailbox + chat→profile bindings (Lamport-free)
  stt.ts             whisper/sherpa transcription for the channel
  config.ts          channel env (token, allowlist, STT, state dir)
  platform/node.ts   Node adapter (scripts + channel tests)
web/                 the app — UI host + agent host + shared core
  src/main.ts        boot: profiles, platform, lease, sync, UI host
  src/server/        the in-browser backend (all /api/* answered client-side)
  src/agent/         worker: tree runner, tools, run log
  src/platform/      OPFS adapter + bridge clients, sqlite-wasm worker
  src/profiles.ts    OPFS profiles + paired-server bindings, registry
  src/server-link.ts browser side of server pairing (mailbox, SAS, reconnect)
  src/bridge/        Node peer: mailbox, werift channel, engine, exec ops
  src/host-lease.ts  single-host lease per workspace (Web Locks + heartbeat)
  src/sync/          Lamport journal + pull-only reconcile + transports
  src/swap.ts        BobSwap seed shelf client
  scripts/           serve / pairing CLI / make-seed / smokes
ui/                  SolidJS tiled UI (bundled into web)
scripts/             offline tests for the shared core and channels
workspace/ patterns  (seed content lives in the workspace, not the repo)
```

### Design principle: patterns live in the workspace

The agent's behavior is defined by a single `.mjs` file in the workspace:
`workspace/patterns/agent.mjs`. This file exports a function that receives
the grandma-kat Tree builder API and returns a Tree definition.

The agent loads the pattern on each turn, so changes take effect immediately
— no restart needed. The agent can also modify its own patterns using its
file tools, enabling self-modification.

To change the agent's behavior:

1. Edit `workspace/patterns/agent.mjs` (via the settings page, a text editor, or
   the agent itself).
2. The next conversation turn uses the updated pattern.

The pattern file is a single `.mjs` file that contains the full tree
(root + branches + helpers). No imports needed — the Tree builder API
is passed as function arguments.

The **workspace** (agent sandbox + git repo) lives OUTSIDE the project by default
(`~/grandma-workspace`, see `WORKSPACE_DIR`) so its git history is fully
independent of the harness.

**Trees are also tools.** Every workspace tree — `patterns/<name>.prod.mjs` or
`app/<name>/tree.prod.mjs` — is registered as a callable *tree tool*. A pattern
offers one to the model with `.tools("<name>")`; the model then calls it like
any other tool and gets the tree's result back, while the tree runs in place.
Its `.human()` pauses suspend the whole conversation and the next message
resumes inside the tree (the calling prompt round is replayed from the log,
not re-sent to the model).

Each tree is **one file**. The notation in its leading `//` comment block IS
the spec: change the code and that block in the same edit; git is the version
history. There is no draft copy, no version snapshot, and no separate
`.spec.md`.

A session **freezes its tree on open** — the root pattern and the tree-tool
registry are loaded once, on the first turn, and reused for the conversation's
lifetime. Editing a tree file therefore never disturbs a live conversation (a
caller-list walk paused between dials keeps running the bytes it started on).
A restart re-loads from disk; if the tree changed, the saved position is
dropped and the turn starts fresh.

Because tree tools resolve through the loader, a tree that attaches another
tree must do so **by name** (`From`/`Hook`/tree tool), never by a relative JS
import: the loader resolves the live file, whereas a relative import binds the
file's definition at import time.
And a tree invoked as a tool gets **only its own `Tools()`** — host tools are
not inherited into a called tree (only a `From()`-attached subtree inherits).
Together these are the host's isolation + least-privilege contract.

#### How a tree describes itself: description and `## Guide`

When a tree is offered as a tool, the model that decides whether to call it
sees two things drawn from the app's README:

- **The first prose paragraph** of `app/<name>/README.md` becomes the tool's
  schema `description` — one sentence saying what the tree is for. BOB appends
  a fixed line: `Call this to run the "<name>" tree; the tree's result is
  returned as the tool result.` (A pattern has no README: its description is
  the `// <file> — <sentence>` line at the top of the file.)
- **The `## Guide` section** becomes longer usage guidance, assembled into the
  `TOOL GUIDANCE` block of the calling prompt — but only when the tree is
  inside that prompt's `Tools()` scope.

Write `## Guide` for the **caller** — the model invoking the tree — and nobody
else:

- **When to call** it, in the caller's words ("To send an email, call this tree
  with the request").
- **What to pass** — the `Needs(...)` slots and what they mean.
- **What to do with the result** — e.g. "relay the returned `text` — and nothing
  else".
- **Boundaries** — when not to call it, and what *not* to do by hand instead
  ("do not write SQL against `email.db` by hand").

Do **not** put the tree's implementation or authoring philosophy in it. "Write
the tree in code, not prompts" is advice for the tree's own prompts and code; in
a `## Guide` it is noise the caller cannot act on. Do not restate the short
description either. Keep the section short — it rides in the caller's prompt on
every turn. `app/email/README.md` and `app/contacts/README.md` are the shape to
copy.

The leading comment block of a tree file is a **line-notation** sketch of the
code that follows (canonical symbol reference:
`grandma-kat/examples/notation/README.md`). One symbol worth naming for sketch
authors: `**` opens a branch, and a condition is **not** required — `** if COND
→ …` is a *gated* branch, while a bare `**` is an *unconditional* grouping
subtree.

The app's `README.md` is **not** a second copy of the tree. It documents the app
around the tree — its tools, data model, config, run commands, and wiring — and
references the tree's header for the tree itself. Restating the tree in the
README drifts silently — nothing checks prose the way the header (which lives
with the code) is checked — so reference it instead of repeating its modes,
prompts, steps or guard values.

#### How a function tool describes itself: `description` and `guide`

An app's `tools.mjs` (or `tools.js`) exports an array of **function tools** —
individual actions, not a tree. Each tool carries two independent strings:

- **`description`** — the tool's schema text, sent to the model in its tool
  list (`function.description`); the model reads it to decide whether to call
  the tool. Always declared.
- **`guide`** — longer "how to use me" text. It is **not** in the schema;
  `ToolRegistry.toolGuide` assembles it into the `TOOL GUIDANCE` block of the
  calling prompt, when the tool is in scope, prefixed `Tool "<name>": `.
  Optional.

```js
// app/<name>/tools.mjs
export const guide = "How to use this app's tools well: …"; // default for tools without their own

export const tools = [
  { name: "upsert_contact",
    description: "Add a contact, or update the one that already exists. …",
    parameters: { /* … */ },
    guide: "How to use upsert_contact well: match id → email → name; …", // per-tool wins
    execute(input) { /* … */ } },
  { name: "log_message",
    description: "Log a message sent to or received from a contact. …",
    parameters: { /* … */ },
    execute(input) { /* … */ } }, // no per-tool guide → falls back to export const guide
];
```

Precedence: a per-tool `guide` wins; the module-level `export const guide` only
fills tools that did not set their own (`src/app-tools.ts`). `description` feeds
the schema (`toOpenAiDefinition`); `guide` feeds `TOOL GUIDANCE` — never the
schema. Guides are assembled host → tree → app, so an app function tool's guide
follows the tree guides.

#### Built-in host tools (`read_runs`, `inspect_memory`)

Two engine readers are registered by BOB itself, not by an app's `tools.mjs`:

- **`read_runs`** — grandma-kat's run-log reader (`runLogTools`), for recall and
  provenance.
- **`inspect_memory`** — grandma-kat's bounded view of a value held by a
  `ref://<name>.<seq>` handle or a live memory slot. It lets the model peek
  (type/size + a random sample) before handing a big value to another tree.

`inspect_memory` is **dispatched specially** (`ToolRegistry.dispatch`): its
execute needs the engine's per-call context — `view`, `readRef`, `scopeInfo` —
which the app-tool path replaces with the app's secrets context. It is
registered as a built-in definition and forwarded `ctx`; do not add it as a
`tools.mjs` app tool. Its guidance is a `HOST_GUIDES` entry in
`src/tool-guides.ts`, and the trunk offers it via `TOOL_NAMES`.

## Setup

1. `npm install`
2. **The app needs no server at all**: `npm run build:web && npm run web:standalone`
   serves it at `http://localhost:8080`. Profiles and settings are per-browser
   (OPFS + localStorage); model keys are entered on the settings page.
3. **Telegram (optional)**: create a bot with @BotFather, copy the token, and
   get your numeric user id from @userinfobot. `cp .env.example .env` and fill
   in `TELEGRAM_BOT_TOKEN` + `ALLOWED_USER_IDS`. The channel prefers
   `~/.bobkat/.env` when present; `ENV_FILE=/path` overrides.
   `npm run bob` picks it up automatically (loopback API on `:8795`); without
   a token the same process just leaves the bot off.
4. **Desktop/server peer (optional)**: `npm run bob` serves the app plus the
   mailbox on `127.0.0.1:8795`. Run `npm run pair` on the desktop to print an
   8-digit one-time code and the approval prompt; the tab joins from
   Sync… → Pair… → **Pair with a code**, select **My desktop / server**, and
   enter the code. Exec is opt-in via `--exec git,make,…`. Open codes live in
   the `npm run bob` process, so restarting it means running `npm run pair`
   again. Add `--debug` to that command to log each
   pairing event.
   Start the process with `BOB_STT=1` to expose the `/stt` pass-through for
   in-tab voice transcription.
5. **Voice (optional)**: the browser records are transcribed by the bridge
   (`BOB_STT=1`); Telegram voice notes are transcribed by the channel. Both
   use whisper-server:
   ```sh
   npm run whisper:up   # 127.0.0.1:8178
   ```
   whisper.cpp is prebuilt under `vendor/` (Vulkan). Rebuild/change the model:
   ```sh
   git clone --depth 1 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
   cmake -S vendor/whisper.cpp -B vendor/whisper.cpp/build -DGGML_VULKAN=1 -DBUILD_SHARED_LIBS=OFF
   cmake --build vendor/whisper.cpp/build -j --target whisper-server
   vendor/whisper.cpp/models/download-ggml-model.sh base
   ```
   `WHISPER_MODEL` selects the model for `npm run whisper:up`.
6. **LLM backend** — the Models card (settings page) edits a registry of named
   slots: `cheap` (routing + direct answers) and `strong` (the tool-using
   loop). Each entry has `baseURL`, `apiKey` (browser-local, never in the
   workspace), `model`, and optional `transform`/`protocol`/`thinking`.
   Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Neuralwatt,
   llama.cpp, LM Studio, HF router); `protocol: "ollama"` is only for Ollama's
   native `/api/chat`. The **Test** button probes a slot from the tab.
   Per-conversation overrides: the cheap/strong pickers in the session panel.

## Run

```sh
npm run bob              # app :8080 + channels :8795   (everything)
npm run whisper:up       # voice transcription — :8178  (optional)

# isolation/debug only:
npm run web:standalone   # app only — :8080
npm run storage-server   # standalone debug bridge (not the product path)
npm run dev              # alias of `bob`
```

As user systemd services (survive crashes and reboots):

```sh
mkdir -p ~/.config/systemd/user
cp systemd/whisper.service systemd/telegram-channel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now whisper.service telegram-channel.service
```

The telegram unit now runs the combined process (`npm run build` first):
app, bridge and channel on :8080/:8795. Logs:
`journalctl --user -u telegram-channel`.

Useful checks: `npm run typecheck` (three packages), `npm run test:standalone`
(the self-containment gate), `npm run test:sync`, `npm run smoke` (offline
tool/git tests), and the browser smokes in `web/scripts/` (`browser-smoke`,
`profile-smoke`, `lease-smoke`, `seed-update-smoke` — each needs
`npm run web:standalone` running).

## Telegram usage

- DM the bot, or add it to a **group with Topics enabled**. Every topic is an
  independent conversation; replies land in the same topic.
- Send text or **speech** — a voice note, forwarded audio, or a round video.
  The channel transcribes locally and echoes `heard: "…"`, then parks the
  transcript for your browser tab. **A parked message needs a tab**: open the
  app (or leave a desktop tab running) and the mailbox drains into the
  bridged conversation. No tab open → the message waits on disk across
  channel restarts.
- **Attachments are text-only in v1** — the phone is told to send them in the
  web chat instead (the workspace the agent writes lives in the browser).
- Telegram has **no server-side commands** anymore. Text arrives in the web
  app verbatim; commands like `/new`, `/model`, `/clear` are UI actions there
  (or plain text the tree reads). The channel's job is transport.
- The **bridge** toggle in the session panel routes this phone chat to a web
  session; **✈ send to telegram** pushes the session transcript to the linked
  chat and pins it. One host lease means exactly one tab answers.

## Web UI

The app is served by `npm run web:standalone` at `:8080` (or any static host).
Every `/api/*` call is answered by the **in-browser backend** — there is no
admin API. The tiled UI has one tile per app (the trunk plus every
`app/<name>/` tree), each with its own chat bubbles, memory panel and event
log; one composer is shown on the tile whose tree is paused at `.human()`.

**Storage & profiles.** The workspace always lives in the tab's OPFS sandbox
(Export/Import move a whole workspace as JSON); there is no storage backend to
choose. A profile can **pair with a desktop/server** — the same WebRTC channel
flow as two browsers, with a code + SAS approval — to mirror the workspace to a
real folder and run allowlisted desktop exec through the authenticated channel.
Profiles have their own chats, patterns, run log, git history and board layout.
A profile can also choose which tiles stay visible (**Profiles** →
**Hidden… except:**); every other app starts in the hidden rail. A new chat
opens on trunk alone; as apps run, their tiles raise themselves (up to two beside trunk), and
a third active app pulses in the rail until opened. A **single-host lease** makes
sure only one tab runs the agent per workspace: a second tab is read-only (with
a *take over* button). A failed turn keeps a retry
composer; the Stop button aborts the run.

**Voice.** The composer's 🎙/📎 routes audio to the bridge's `/stt`
(`BOB_STT=1`, ffmpeg + whisper-server on the desktop); there is no in-tab
model download. Browser mic access needs a secure context (`localhost`/HTTPS).

**Sync.** Tabs of the same origin that share a workspace (same profile) sync
live through BroadcastChannel — no setup. Different profiles pair through the
dialog. Cross-device pairing (WebRTC, with a 6-word verification phrase derived
from both DTLS certificates) is in the Sync… dialog under **Live sync →
Pair…**: one code field with a source switch — **Another tab / relay**
(BobSwap, defaulting to the built-in deployment) or **My desktop / server**.
Manual paste remains the no-service fallback. Signaling blobs carry only
WebRTC addressing; workspace bytes travel over the authenticated data channel
(a paired desktop/server is a peer endpoint and its mirror folder holds a
copy). Full guide: [docs/pairing-and-sync.md](docs/pairing-and-sync.md).

Telegram is wired through the channel: the session panel's **bridge** toggle
drains the channel mailbox into the selected session, and **✈ send to
telegram** posts the transcript to the linked chat and pins it.

## Git integration (summary)

`WORKSPACE_DIR` is a git repository (auto-initialized on first start), kept outside
the project directory so its history is completely separate from the harness's own.
Every `write_file` / `edit_file` / `delete_file` is immediately committed.
See the FAQ below for exactly how that works.

## Workspace sync (desktop ↔ phone)

Live sync is the browser app's job now: open the app on both devices and pair
them (Sync… → Pair…). The pair runs peer-to-peer over a WebRTC data channel;
same-origin tabs need no pairing at all. Conflict policy: the per-path
Lamport stamp decides, ties break deterministically by replica id, and the
loser's bytes are preserved as `<path>.conflict-<timestamp>` — never silently
dropped. `logs/`, `.git/`, `.gpb-*` and `assets/inbox/` never sync (git
history and run logs stay per-replica).

The old LAN git-daemon path (bare repo + `git://` pull/push on the phone) is
retired for the app: it remains possible by hand against a profile's mirror
folder (`git -C <folder> remote add …`), but the app no longer surfaces it.

Step-by-step for both cases (same machine; server ↔ remote browser) and the
troubleshooting table: [docs/pairing-and-sync.md](docs/pairing-and-sync.md).

## FAQ

> Answers are current unless a section is explicitly marked **historical**.
> The agent runs in the browser; Node processes are channels. Where an answer
> mentions server-side files (`sessions.json`, a Node run log), read it as the
> per-replica storage of the kind in question (OPFS, or a mirror folder when an
> operation needs a real path).

### Git & workspace

**How exactly does auto-commit work?**
After a file tool writes/edits/deletes a path, the platform's `autoCommit`
runs — the tab uses isomorphic-git over its OPFS repo
(`git add -A -- <path>` → status check → `git commit -m "agent(<tool>): <path>"
-- <path>` → short hash). The hash goes into the tool result, so the model can
report it. A desktop mirror folder is a copy for desktop-only git/SQL/scripts;
it does not carry the tab's `.git` history.

**Will the bot commit *my* uncommitted changes in the workspace?**
No. Both `add` and `commit` use a **pathspec** limited to the file the tool just
touched. `git commit -- <path>` commits only that path's staged state, so your
other staged or dirty files are never swept in.

**What if the commit fails (broken repo, weird permissions)?**
`autoCommit` never throws — it logs and returns the string `"failed"`. The file
change itself stands; you just lose that commit. The agent sees the `"failed"`
result and can tell you.

**Why do bot commits show up as *me* in `git log`?**
`ensureRepo()` probes `git config user.name` / `user.email`, which succeed via your
*global* git config — so no repo-local identity is set and commits are yours. To
distinguish bot commits:
```sh
git -C ~/grandma-workspace config user.name grandpa-bob-bot
git -C ~/grandma-workspace config user.email grandpa-bob-bot@localhost
```

**What happens if I delete the workspace directory?**
Every profile's workspace lives in OPFS: deleting it removes that profile's
files, and the next boot re-seeds (or pulls it back from its desktop mirror, if
one is bound). A desktop mirror folder that is deleted simply repopulates from
OPFS on the next sync. Either way the conversations of that profile start fresh
only when the run log goes too.

**Where does the run log live?**
Every LLM call, tool call, check, goback and gate lands in the replica's run
log. All profiles keep it in OPFS under `.gpb-runlog/` (the streaming sqlite
VFS — not a plain file; export the profile to back it up); the log is excluded
from the desktop mirror and from workspace git. The mirror folder's `logs/` is
for desktop-side database use, not the tab's run log. To inspect the logical
log, export the profile (it carries `workspace/logs/grandma-kat.db`):
```sh
sqlite3 grandma-kat.db \
  "SELECT seq, branch_path, kind, substr(content, 1, 120) FROM calls ORDER BY seq DESC LIMIT 20;"
```

**Can I use the workspace repo myself — branches, remotes, my own commits?**
Yes. It's a plain git repo. Add a remote and push for backup, commit your own
files, whatever you like. The bot only ever commits the paths its tools touch.
(It *can* run read-only git commands itself — see the deny-list question below.)

**Why does the workspace live outside the project?**
Two independent lifecycles: the harness is code you hack on; the workspace is data
the bot maintains. Separate directories → separate git histories → `git log` in
the workspace is purely the bot's audit trail, and `workspace/` never appears in
the project's status.

### Agent & LLM

**What does one agent turn actually look like?**
The first message of a conversation (or after a new chat) knits the tree in the
browser worker; it pauses at `.human()` immediately. Each message resumes from
that checkpoint: `.memoryUpdate()` appends the user message to `messages`, the
classify branch routes to direct/tools, the response branch generates an answer
(with tool calls in a loop), and `.emit()` streams it into the tile (and, when
bridged, relays it to Telegram). The tree loops back to `.human()` and pauses —
checkpoint in the run log. A reload restores a paused run; a changed tree
drops the saved position and the turn starts fresh.

**Why do tool errors not crash the turn?**
`ToolRegistry.dispatch` wraps every tool in try/catch and returns errors as plain
strings (`"error: old_string not found in notes.md"`). The model sees the failure
as a normal tool result and typically self-corrects (re-reads the file, adjusts).
Only LLM/transport errors propagate up to the user as "Something went wrong".

**What is `read_json` for?**
`read_json` reads content that is (or might be) JSON as a **structured value**
instead of raw text. Pass exactly one source: `path` for a workspace file,
`text` for a JSON string already in context, or `ref` for a
`ref://<name>.<seq>` handle to a value the run log holds whole (a truncated
tool result). It returns `{ json: <value> }`, so the model sees structure and
the usual `ref://` handles / row-trimming apply to big values. An optional
`at` walks into the value with the same `/`-separated dialect as
`inspect_memory` — array segments are indices, everything else an object key
(`at: "rows/0/email"`); a ref may carry that path itself and `at` composes
after it. Parsing is strict `JSON.parse` (whitespace/BOM tolerated): a failure
is a normal tool error saying why, including when the content looks like
JSONL. Apps opt in by naming `read_json` in their tree's `Tools(...)`, like
any host tool — every workspace app tree does today.

**What happens at the 12-iteration limit?**
The tools branch's `until` loop throws a `KnitError` with `"tool-iteration limit"`.
This surfaces in Telegram as "Something went wrong: tool-iteration limit: …". The
continuation for that topic is preserved — the next message starts a fresh tree
(the error doesn't corrupt the checkpoint). Use `/clear` if a conversation goes
sideways.

**What happens when a model's plan runs out of credit (HTTP 402)?**
A quota wall is not a bug — it needs a decision, so the bot does not just print
a stack trace. When a model call fails with a 402 (or a 403/429 whose text names
quota/billing), Bob remembers the turn that failed and asks which model to fall
back to: in Telegram as an inline keyboard of the configured model slots, in the
web UI as fallback buttons on the failed tile. Choosing one retargets the role
that failed (`strong`/`cheap`) to the chosen slot — persisted for the
conversation, exactly like `/model` — and re-runs the killed turn on it. A plain
5xx or timeout is *not* treated as a quota wall; grandma-kat retries those with
backoff. Only the model call itself is retried — the turn is re-delivered from
its last `.human()` checkpoint, so no work before the failure is repeated.

**Why does tool support depend on the *provider*, not just the model?**
On the HF router, each provider serves the same weights with its own chat template
and generation config. Tools only work if the provider's template renders them.
That's why the model name pins a provider (`google/gemma-4-26B-A4B-it:novita`) and
why `gemma-4-31B-it:deepinfra` (same family!) reports `supports_tools: false`.
Check per-provider flags at https://router.huggingface.co/v1/models.

**What's the `<|channel>thought…` thing?**
Gemma 4 emits its reasoning wrapped in `<|channel>thought\n…<channel|>` — as an
empty block even with thinking disabled. `stripThought()` in `agent.ts` removes
these from the final answer before it's shown to you or stored in history. This
also follows the model card's guidance: no thoughts in multi-turn history —
*except* tool-call turns, whose raw content is kept within the turn (the model may
need its own reasoning to interpret tool results).

**What gets remembered, and for how long?**
The tree's `messages` memory slot holds the full conversation history (user messages,
assistant replies, tool exchanges). This is persisted in the continuation token —
the checkpoint saved to `<workspace>/logs/grandma-kat.db` at every `.human()` pause.
History survives bot restarts (the SQLite DB is on disk). `/clear` drops the
continuation for that topic, starting fresh. The workspace and its git log are
the other persistent memory — the agent can always re-read files to re-orient.

**Do photos get re-billed every turn?**
Yes — images stay in the `messages` history as base64 data URLs and are re-sent
(and re-charged as image tokens) on every subsequent turn. Gemma 4 uses 70–1120
tokens per image depending on provider settings, so this is modest, but worth
knowing before a photo-heavy session. Use `/clear` to drop a conversation if
token usage gets high.

### Workspace apps & secrets

`workspace/app/<name>/` packages optional features: `tools.mjs` exports an
array of tools the agent can call, and `tree.prod.mjs` is the app's tree (one
file; its header comment is the spec). When an app needs a credential file it
declares it in `app/<name>/secrets.json`:

```json
[{ "name": "google-service-account.json",
   "description": "Service account JSON for the Calendar API",
   "contentType": "application/json" }]
```

The settings page grows an **App secrets** section listing every declared
file as missing or uploaded, with upload / replace / delete buttons. Bytes
are stored **outside the workspace** — `~/.bobkat/secrets.db`, override
with the `SECRETS_DB` env var — in a 0700 directory as a 0600 sqlite file.
The workspace tree syncs over git, is readable by the bot's file tools and
rides along in backups, so credentials must not live there; the store is
additionally hidden from the file browser and download routes. Apps read
only their own entries via the context object passed to `execute(args,
ctx)`: `ctx.secret(name)`, `ctx.secretText(name)`, `ctx.requireSecret(name)`
(throws a message pointing at the upload page when absent) and
`ctx.listSecrets()`. Names are opaque keys, never paths.

### Telegram & topics

**So… are there sessions?**
Yes — a "session" is a continuation checkpoint in the replica's run log that
captures the full tree state (memory slots including `messages`, execution
position, scope chain). Web sessions are keyed `web:<id>`; Telegram
conversations keep their `chatId:threadId` key and are parked/claimed through
the channel. Lifecycle: **born** on the first message (tree pauses at
`.human()`); **lives** until **cleared** (new chat / `/clear`, which drops the
continuation); a reload restores a paused run. Turns within a session are
strictly serialized; different sessions run in parallel. Exactly one tab
hosts a workspace at a time (the lease).

**How do forum topics become separate conversations?**
Every message in a topic group carries `message_thread_id`. The bot keys history
as `chatId:message_thread_id` (DMs/non-forum chats use `0`) and passes the same
`message_thread_id` back when replying, so answers land in the topic they came
from. Two topics in one group are as isolated as two DMs.

**What happens if I send three voice notes in a row?**
Per topic, jobs are chained on a promise queue (`Map<key, Promise>`): each waits
for the previous transcription + agent turn to finish, so replies stay ordered and
agent runs never interleave. Different topics/chats run fully in parallel.

**Why did the bot ignore my message while it was restarting?**
Two reasons: messages older than 120 s at delivery time are dropped (prevents
replaying a stale backlog after downtime), and in-memory history means the bot
wouldn't have the context anyway.

**How are long answers sent?**
Telegram caps messages at 4096 chars. Replies are chunked at 4000, splitting on
the last newline before the cut (hard cut if no good newline exists).

### Voice pipeline

**What exactly happens to a voice note?**
`getFile` → download `.ogg` (OPUS) from `api.telegram.org/file/...` →
`ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le` → multipart POST to
`whisper-server /inference` (form fields `response_format=json`,
`temperature=0.0`) → trimmed transcript → shown to you as `heard: "…"` → fed to
the agent as ordinary user text. Both temp files are deleted in a `finally`,
success or failure.

**Why a persistent whisper-server instead of running whisper-cli per message?**
Model load + Vulkan backend init costs seconds; paying that per voice note would
make voice chat painful. The server loads `ggml-base.bin` (~147 MB) onto the GPU
once and each transcription is then a fast HTTP call. The bot warns at startup if
the server is unreachable (`npm run whisper:up` starts it).

**Why Vulkan and not ROCm or CUDA?**
The RX 570 (Polaris) has no CUDA (AMD) and ROCm dropped Polaris support long ago.
Vulkan via Mesa's RADV driver is fully supported on this card, and whisper.cpp's
`ggml-vulkan` backend runs the whole model there. Same reason a local
`llama-server` would be built with `-DGGML_VULKAN=ON`.

**What settings does whisper run with, and how do I make it more accurate?**
Current: `ggml-small.bin` on the GPU, greedy decoding (`temperature=0.0` per
request, beam search off), language forced to `en` (the whisper-server default).
Three accuracy levers, biggest first:

1. **Model size.** `WHISPER_MODEL` in `.env` + restart `whisper:up`. Measured on
   this RX 570 with an 11 s clip: `base` 1.1 s → `small` 1.4 s →
   `large-v3-turbo-q5_0` 4.3 s (already downloaded; the clear quality winner if
   you tolerate the wait — still ~2.5× faster than realtime, fine for short
   voice notes). `medium` (~1.5 GB) also fits the card.
2. **Lock the language.** `WHISPER_LANGUAGE=en` (or `de`, `nl`, …) in `.env` is
   sent per-request — avoids mis-transcribing short clips as another language
   and improves word accuracy. `auto` enables detection but is unreliable on
   very short audio.
3. **Beam search.** Add `--beam-size 5` to the `whisper:up` command in
   `package.json` — a small WER improvement for ~2–3× latency.

### Security

**What stops a stranger from using my bot?**
A grammY middleware checks `ctx.from.id` against `ALLOWED_USER_IDS` before any
handler runs; everyone else is silently dropped (logged to console). This applies
in DMs *and* groups — add the bot to a group and only listed users get answers.

**How airtight is the workspace sandbox?**
Every tool path goes through `resolveInWorkspace()`: `path.resolve(workspace, rel)`
plus a prefix check, rejecting `..` escapes and absolute paths outright.
`run_command` uses `execFile` **without a shell** — no pipes, redirects, globbing,
or `$(...)` — and matches the binary by basename against `ALLOWED_COMMANDS`. That
said, it's a guardrail, not a security boundary: the agent can write any file in
the workspace (including e.g. git hooks there), so keep the workspace
non-critical and skim `git log` occasionally.

**Which git commands can the agent run?**
`git` is on the command allowlist, but `run_command` refuses destructive/remote
subcommands: `push, reset, clean, rebase, remote, config, checkout, switch,
restore, update-index, filter-branch, gc`. What remains is effectively
read/log/diff/status/add/commit/branch — enough for the agent to inspect its own
history, not enough to publish or destroy it.

**Can the agent read my `.env` or the bot token?**
Not with the defaults. File tools are sandboxed to the workspace, and
`run_command` now rejects path-like ARGUMENTS that resolve outside it — `cat
/etc/passwd`, `cat ~/.bobkat/.env`, `git -C /tmp …` and `--file=/abs`
forms all fail with "argument escapes the workspace" (conservative: any
argument starting with `/` counts as a path, even a regex). It remains a
guardrail, not a security boundary — be careful what you add to
`ALLOWED_COMMANDS` (a shell or `env` would punch a hole), and the bot's LLM
traffic still carries whatever the model chooses to read *inside* the
workspace.

**What can the `sql_query` and `sql_write` tools touch?**
There are two separate SQLite tools, so reads and writes can't be confused:
`sql_query` is **read-only** (only `SELECT / WITH / EXPLAIN / PRAGMA`, and the
database is opened with the engine's `readOnly` flag, so writes are refused at
the lowest level). `sql_write` is the explicit read-write tool for
INSERT/UPDATE/DELETE/DDL — the model only reaches writes by calling that tool.
Both resolve their `path` argument inside the workspace sandbox, *unless* you
set `SQLITE_LOCK_PATH` to an absolute path: then the tool is locked to that one
file and `path` is ignored entirely, so the agent can never reach another
database.

**Why does the bot ignore updates older than two minutes?**
So a backlog of messages sent while it was offline doesn't trigger a burst of
agent runs (and LLM spend) on startup.

**Why is a tool result truncated in the agent's context?**
To keep a prompt's context from ballooning (a single `read_runs` or CSV dump can
be tens of KB, which once pushed a turn past the model's request timeout). Only
the characters shown to the model are capped — `MAX_TOOL_RESULT_CHARS`, default
4000, `0` disables — and `{ rows: [...] }` results are trimmed by whole rows so
they stay valid JSON. The **full** result is always kept for the tree's own
logic (`record.toolResults`) and in the run log (`tool_result` events), so
nothing is lost. A tree can override the cap per prompt with
`Prompt(name, fn, runAfterTool(shaper))`, where the shaper is a pure function or
a registered tree (e.g. a cheap-model condenser).

## Safety notes

- Only Telegram user IDs in `ALLOWED_USER_IDS` can talk to the bot; others are ignored.
- File tools cannot escape `WORKSPACE_DIR` (`..` and absolute paths are rejected).
- `run_command` uses no shell (no pipes/redirection), only runs allowlisted
  binaries, and refuses destructive/remote git subcommands.
- `sql_query` is read-only (SELECT/WITH/EXPLAIN/PRAGMA, engine-opened read-only);
  writes only happen via the separate `sql_write` tool. Set `SQLITE_LOCK_PATH`
  to restrict both to a single database file.
- The allowlist is a guardrail, not a security boundary — run the bot as your own
  user, keep the workspace non-critical, and review `git log` if you're curious.
- `.env` resolution prefers a private file — `ENV_FILE`, then
  `~/.bobkat/.env`, then `<project>/.env` — so credentials don't depend
  on a `.gitignore` line inside the checkout. The workspace dir is the only
  place the agent's file tools can touch, and `run_command` refuses
  path-like arguments outside it.
