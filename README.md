# Grandpa Bob Bot

_BOB = **B**etter **O**rganizational **B**ot_

A local agent harness you chat with from Telegram — text, voice, photos, or files. It can
read, write and organize files on this machine inside a sandboxed workspace, and
every change it makes is **git-committed automatically**.

- **Telegram**: long polling via grammY. Works in DMs and in **forum-topic groups** —
  each topic is an independent conversation with its own history.
- **Web UI** — the main interface at `http://<host>:8080`: the browser target
  (`web/`) runs the agent in the tab and serves chat, settings (credentials,
  sync, logs, patterns, files) and the tree view. It operates on storage chosen
  in the header:
  - **Browser (OPFS)** — a private sandbox in the tab, seeded from the workspace,
    with toolbar **Export**/**Import** for a whole-workspace JSON backup;
    **profiles** keep separate OPFS workspaces (switchable in the toolbar, each
    with its own chats, patterns, log and git history), and a profile can be
    bound to a **BobSwap seed** for updates — and **Send…/Receive…** passes a
    workspace copy to another open tab through the zero-storage BobSwap relay
    (fresh pairing per share; nothing stored).
  - **Desktop (local server)** — the loopback storage bridge, for the real
    workspace on disk (and the only mode Firefox can use).
  The header's **upload** button puts files from a normal OS picker into any
  workspace folder (asked per upload, remembered next time). The server on
  `:8080` **always** serves the UI; the admin API is opt-in with `BOB_WEB=1`.
  Without it the same port is a static-only listener, every `/api/*` answers
  `503 {"admin": false}`, and the page runs its in-browser backend — settings
  included. The server-only controls (Telegram bridge, service health, restart,
  bot logs) stay visible but disabled, with a **browser only** chip. To run the
  UI with no BOB process at all, use `npm run web:standalone` (loopback static
  server on `:8080`; see `web/README.md` → "Standalone").
- **Voice → text**: Telegram voice notes use the local Vulkan whisper-server;
  the web UI transcribes in the tab with whisper (Transformers.js, WebGPU/WASM),
  so no server is needed there.
- **Brain**: any OpenAI-compatible endpoint (default: Hugging Face router running
  Gemma 4), switchable via `.env`.
- **Attachments**: Telegram documents and non-audio web uploads are stored under
  `assets/inbox/` and passed to the tree as workspace-relative paths. They are
  excluded from workspace Git history.
- **Tools**: sandboxed file tools + an allowlist of shell commands.

## Architecture

```
  Telegram app (you: text / voice note / photo / file)
      │
      ▼  getUpdates, long polling (grammY)
┌─────────────────────────────────────────────────────────────┐
│ bot.ts                                                      │
│  · auth gate (ALLOWED_USER_IDS, others silently dropped)    │
│  · forum-topic routing (key = chatId:message_thread_id)     │
│  · per-topic serial queue · typing indicator · msg chunking │
└───┬──────────────────┬──────────────────────┬───────────────┘
    │ text             │ voice                │ photo
    │                  ▼                      ▼
    │          ┌───────────────┐      download largest size
    │          │ stt.ts        │      → base64 data URL
    │          │ .ogg → ffmpeg │      (image-first content order)
    │          │ → 16kHz WAV   │
    │          └──────┬────────┘
    │                 ▼ multipart POST /inference
    │          whisper-server (:8178)
    │          whisper.cpp, Vulkan backend, AMD RX 570
    │                 │ transcript
    ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│ agent.ts — continuous tree with pause/resume                │
│  · continuation tokens store full tree state per topic      │
│  · grandma-kat owns history, memory, scope chain            │
│  · .human() pauses for input, .emit() sends output          │
└───┬─────────────────────────────────────────────────────────┘
    │ OpenAI-compatible POST /v1/chat/completions (+ tool schemas)
    ▼
 LLM endpoint (default: HF router, google/gemma-4-26B-A4B-it:novita)
    │ tool_calls (JSON)
    ▼
┌─────────────────────────────────────────────────────────────┐
│ tools/index.ts — dispatch (errors returned as strings,      │
│ so the model can self-correct)                              │
│   ├─ files.ts: list/read/write/edit/delete ──┐              │
│   └─ shell.ts: run_command                   │              │
│        (allowlist, no shell, git deny-list)  ▼              │
│                                   ~/grandma-workspace       │
│                                   (sandboxed git repo)      │
│                                              │              │
│                                   git.ts: auto-commit       │
│                                   every mutation            │
└─────────────────────────────────────────────────────────────┘
```

### How the continuous tree works

The agent runs as a single **grandma-kat tree** that loops forever:

```
Tree.name("agent")
  .human("main_input")           ← pause: wait for user input
  .memoryUpdate("messages", …)   ← append user message to history
  .branch(classify)              ← cheap model: "tools" | "direct"
  .branch(when "direct", direct) ← cheap model: text-only answer
  .branch(when "tools", tools)   ← strong model: tool-using loop
  .emit(…)                       ← non-blocking output to Telegram
  .until(true)                   ← loop back to .human()
```

- **`.human()`** pauses the tree and saves a checkpoint to SQLite. The
  continuation token is stored per conversation — and persisted to
  `<workspace>/logs/sessions.json`, so chat sessions survive bot restarts.
  On the next message, `grandma.knit()` resumes from the checkpoint with
  the new input. If the active pattern's shape changed (or the checkpoint
  is missing), the session is dropped and a fresh tree starts instead.
- **`.emit()`** sends output to Telegram without stopping the tree. The
  bot wires `onEmit` to `ctx.reply()`.
- **History** lives in the tree's `messages` memory slot — no external
  `HistoryStore`. The continuation token persists the full scope chain
  (memory, history, execution position) in `<workspace>/logs/grandma-kat.db`.

### Journey of a voice message ("add milk to shopping.md")

1. grammY receives the voice note; the auth middleware checks your user ID.
2. The job is chained onto this topic's promise queue (previous reply finishes first).
3. `stt.ts` fetches the file path via Bot API `getFile`, downloads the `.ogg`,
   converts it with ffmpeg to 16 kHz mono PCM WAV, and POSTs it to whisper-server.
4. The bot replies `heard: "add milk to shopping.md"` in the same topic.
5. `agent.run(key, transcript, onEmit)` resumes the tree from its checkpoint.
   The tree's `.memoryUpdate()` appends the user message to the `messages` slot.
6. The classify branch routes to the tools branch. Gemma decides to call
   `read_file` → result appended → `edit_file` → result appended → final text
   answer. Each tool error goes back to the model as a normal string so it can retry.
7. `edit_file` writes the file, then `git.ts` commits just that path and returns
   the short hash, which flows back into the tool result.
8. The `.emit()` child calls `onEmit(text)` — the bot sends the answer to Telegram.
9. The tree loops back to `.human()` and pauses. Continuation stored.

### Layout

```
src/
  index.ts        entry point: workspace + git init, wiring, bot startup
  config.ts       .env loading/validation (non-model config only)
  models.ts       models.json loader, built-in transforms
  bot.ts          grammY bot: auth gate, forum topics, text/voice/photo/file, queues
  attachments.ts  bounded upload storage under workspace/assets/inbox/
  admin.ts        web UI: chat front page (/) + settings page (/settings)
  agent.ts        continuation storage (persisted to logs/sessions.json), tree runner (grandma-kat pause/resume)
  stt.ts          audio (Telegram voice / web upload) → ffmpeg → STT backend
  patterns/
    shared.ts     types (KatPromptRecord), memory-view accessors, history helpers
    classify.ts   classify branch — cheap model: "tools" or "direct"
    direct.ts     direct branch — cheap model: text-only answer
    tools.ts      tools branch — strong model: tool-using loop
    agent.ts      root tree — .human() + branches + .emit() + .until()
  tools/
    index.ts      tool schemas (OpenAI format) + dispatcher
    files.ts      list/read/write/edit/delete, sandboxed, auto-committing
    shell.ts      run_command with allowlist + git deny-list
    sqlite.ts     sql_query (read) + sql_write (write) — SQLite tools, lockable
    git.ts        repo init + auto-commit + workspace .gitignore helpers
  util/paths.ts   workspace path sandbox
scripts/
  smoke.ts        offline tests: tools, sandbox, auto-commit
  agent-mock-test.ts  mock-LLM test of both pattern paths (tools/direct)
  llm-test.ts     live end-to-end agent test against the configured LLM
vendor/whisper.cpp/   whisper.cpp Vulkan build (gitignored)
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

1. **Telegram bot**: create one with @BotFather, copy the token. Get your numeric
   user id from @userinfobot.
2. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN` and `ALLOWED_USER_IDS`.
   The bot prefers `~/.grandpa-bob/.env` when that file exists (move it there
   to keep secrets out of the checkout; `ENV_FILE=/path` overrides, and the
   settings-page editor always edits whichever file was loaded).
3. `npm install`
4. whisper.cpp is already built under `vendor/` (Vulkan) with the `base` model.
   To rebuild or change the model:
   ```sh
   git clone --depth 1 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
   cmake -S vendor/whisper.cpp -B vendor/whisper.cpp/build -DGGML_VULKAN=1 -DBUILD_SHARED_LIBS=OFF
   cmake --build vendor/whisper.cpp/build -j --target whisper-server
   vendor/whisper.cpp/models/download-ggml-model.sh base   # or small / base.en / ...
   ```
   To use a different model, download it and set `WHISPER_MODEL` in `.env`
   (used by `npm run whisper:up` and the systemd unit below).
5. **LLM backend** — copy `models.example.json` to `models.json` and edit, or
   use the **Models** card on the settings page (`/settings`), which edits the
   same file with a form — pick a provider preset, choose a model, hit
   **Test**, and **Save** (applied live, no restart).

   The file defines named **slots**. The agent patterns reference them by name:
   `cheap` (routing + direct answers) and `strong` (the tool-using loop). Each
   entry has `baseURL`, `apiKey`, `model`, and optional `transform` /
   `protocol` fields. Secrets use `${ENV_VAR}` interpolation from `.env`.

   Any **OpenAI-compatible** endpoint works out of the box (OpenAI, OpenRouter,
   Neuralwatt `https://api.neuralwatt.com/v1`, llama.cpp, LM Studio, HF router,
   …); set `protocol: "ollama"` only for Ollama's native `/api/chat` API
   (local `http://127.0.0.1:11434` or cloud `https://ollama.com`).
   `models.example.json` ships Ollama-cloud `cheap`/`strong` slots plus a
   `neuralwatt` example — set the matching key (`OLLAMA_API_KEY`,
   `NEURALWATT_API_KEY`) in `.env`. Bot startup, and every **Save**, pings each
   registered slot and reports `reachable` / `NOT reachable`.

   **Switch models for one conversation** without editing config: send
   `/model strong <slot>` or `/model cheap <slot>` on Telegram, or pick from
   the two dropdowns (cheap / strong) in the web chat. Each role is
   independent — e.g. a big model for `strong` and a small/local one for the
   `cheap` router — and the rest of the registry is untouched. `/model reset`
   (or the "default" entry) clears them. Choices are saved per conversation
   and survive a restart.

   `transform` is an optional response post-processor: the only built-in is
   `gemma4Thinking`, which moves Gemma 4's inline `<|channel|>thought…` block
   out of the answer and into the reasoning field. Leave it **none** for
   OpenAI/Neuralwatt/Ollama-cloud and other providers that already separate
   reasoning.

   `thinking` is an optional object that sets the model's reasoning level for a
   slot. On an OpenAI-compatible endpoint, `{"reasoning_effort": "high"}`
   (low / medium / high, or a provider-specific number) is sent as the request's
   `reasoning_effort`. On `protocol: "ollama"`, `{"think": true}` sets the native
   `think` flag and `{"options": {…}}` is merged into the request's `options`
   (e.g. `num_ctx`). The settings-page Models card exposes all three. A tree
   reaches it simply by naming the slot — `Model('strong')`.

   Note: small local models vary a lot in tool-calling quality — if the agent
   misuses tools, switch models before debugging anything else.

## Run

```sh
npm run whisper:up   # terminal 1: whisper-server on 127.0.0.1:8178
npm run dev          # terminal 2: the bot
```

Or run whisper-server as a **user systemd service** so it survives crashes and
reboots (recommended — otherwise voice dies silently when the terminal closes):

```sh
mkdir -p ~/.config/systemd/user
cp systemd/whisper.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now whisper.service
systemctl --user status whisper.service   # Active: active (running)
```

The unit sources `.env` for `WHISPER_MODEL` and restarts on failure.

If you're using **Ollama** for the LLM instead of the HF router:

```sh
ollama pull gemma4:31b-cloud   # one-time, ~20 GB
npm run ollama:up              # terminal 1: ollama serve (or skip if systemd-managed)
npm run dev                    # terminal 2: the bot
```

The bot's startup log prints whether the LLM endpoint is reachable, e.g.:

```
llm       : gemma4:31b-cloud @ http://127.0.0.1:11434/v1 (reachable)
```

Useful checks: `npm run typecheck`, `npm run smoke` (offline tool/git tests),
`npx tsx scripts/llm-test.ts` (live agent test against the real LLM).

## Telegram usage

- DM the bot, or add it to a **group with Topics enabled**
  (Group settings → Topics). The bot replies inside the same topic; every topic
  keeps a separate conversation history.
- Send text, send a **photo** (caption optional) for image analysis, or send
  **speech** — a voice note, a forwarded voice note / audio file, or a round
  video — and it is transcribed locally. You'll get `heard: "…"` plus the
  agent's reply, so the whole conversation is talkable-to; a spoken reply also
  answers a tree that is paused for input.
- Replies keep their line structure (rich messages spell every newline as
  `<br>`, since their HTML would otherwise collapse it), and phone numbers
  and email addresses become tap-to-dial `tel:` / `mailto:` links (a bare
  digit run is never linked — no separators means no dialable shape).
- Commands:
  - `/new` — starts a **fresh session** for this chat and routes future messages to it (the previous session keeps its history). The new session is shared: it appears in the web UI's session list (as `telegram · chat …`) and you can type into it there — a web turn runs the same tree and mirrors back to the phone. Also drops any reverse-follow ("send to telegram") binding, so the chat is no longer pinned to a web session.
  - `/clear` — drops the conversation continuation for this topic. The next message starts a fresh tree (new system prompt, empty history). Per-topic: each forum topic has its own continuation. The checkpoint in SQLite is orphaned but not deleted. Also resets this topic's `/model` override.
  - `/model` — show each role's current model (`strong`, `cheap`) and the available slots; `/model <strong|cheap> <slot>` sets one, `/model <slot>` is shorthand for `strong`, `/model reset [strong|cheap]` clears. Per conversation, and independent per role.
  - `/status` — shows workspace path, git status, LLM models, STT backend.

## Web UI

The server on `ADMIN_PORT` (default 8080) **always** serves the browser UI. The
admin API is opt-in — start the bot with `BOB_WEB=1`. Without it the same port
is a static-only listener: the page boots its in-browser backend, the settings
page runs entirely client-side, every `/api/*` answers `503 {"admin": false}`,
and the server-only controls (restart, Telegram follow, bot logs, service
health) render disabled with a **browser only** chip.

With `BOB_WEB=1` the admin server additionally serves:

> Shortcuts: `npm run start:with-server` (production `dist/`) and
> `npm run dev:with-server` (tsx + Vite HMR) set `BOB_WEB=1` for you. Plain
> `npm run dev` is static-only too, but keeps Vite HMR on the frontend.

- **`/` — tiled app UI.** A tiling "mission control": one tile per app (the
  trunk plus every `app/<name>/tree.prod.mjs` in the workspace). Each tile shows
  that app's **own chat bubbles**, a read-only **memory panel** (values
  written inside that app, nested paths indented; **click a value to inspect
  its full content**), and a **mini event log**;
  a global **event-stream side panel** shows every step tagged by app. Every
  bot bubble carries an **ⓘ "written from"** button — straight from the run
  log it shows the prompt that produced the message, the **memory slots and
  other pieces it read** (each with the row that wrote it: a tool result, your
  message, an earlier prompt), a **trace deeper** walk of the read-graph, the
  ground facts, any **ref://** handles, and a **view-prompt** expander with the
  exact messages sent. There is
  **one composer in the whole UI**, on the tile whose tree is paused at
  `.human()` — the trunk when nothing is parked yet (it starts the
  conversation); while a turn runs no composer is shown, and a failed turn
  keeps a retry composer on the app it was headed to. The **Stop** button sits
  in the top toolbar while a turn runs. The composer also takes **🎙 voice** and
  **📎 files**: a voice note is recorded in the browser (MediaRecorder),
  transcribed locally, and sent; an **audio file** streams a live transcript
  (a progress card shows `12s / 47s` plus the growing text) that lands in the
  box for review; any other file is attached with the composer text as its
  caption. Voice/file handling uses the same local ffmpeg → whisper/sherpa
  pipeline as Telegram — no audio leaves the machine. (Browser mic access needs
  a **secure context** — `http://localhost`, not a plain-HTTP LAN IP.)
  A tile's header **status dot** is
  **blue** while that app is running, **yellow** while it waits on you, **red**
  if its last turn failed, and blank otherwise — only the active app lights
  up. A **failed turn raises a dismissible banner** at the top, marks its tile
  `error`, and keeps that tile's input so you can retry. Event-log lines (and
  the global stream) **expand on click** to their full payload. Tiles
  auto-arrange — drag to reorder, `⤢` to expand (the trunk dock too), `↔` to
  widen, `✕` to hide (the layout is remembered). The **session** button opens
  session controls (select / new / delete, follow-Telegram, **✈ send to
  telegram**, tree, and the cheap/strong model pickers). The one
  stream is simply split per app. Built from `ui/` (SolidJS + Vite): run
  **`npm run build:ui`** once; until it is built, `/` shows a build notice.
- **`/settings` — admin page.** Credentials & `.env` editor, bot/sherpa status +
  restart, log tails, workspace git sync/commit, tree-pattern editor, and the
  workspace file browser.

The web UI runs the agent under `web:<id>` conversation keys, serialized
so turns never interleave; Telegram topics are unaffected. Chat histories
persist to `<workspace>/logs/grandma-kat.db` (marker rows over the engine's
`calls` table) and survive bot restarts.

Memory panels are process state, so both hosts rebuild them from that log on
first view — the Node admin after a restart, the browser target after a reload
(one shared tracker: `src/memory-track.ts`). The rebuild reads raw `calls` rows,
not the sanitized per-turn event window, so values keep their full shape and a
slot written early in a long turn still restores. That event window itself is
still tail-capped at 500 events per turn (`turnEvents` in `src/web-log.ts` /
`web/src/agent/log-store.ts`), so anything else derived from it only sees a
turn's tail. Details: `web/README.md` → "Session memory panels after reload /
restart".

**The webui follows Telegram, one-way.** By default the browser page keeps
itself pinned to whichever conversation is live on Telegram (the freshest
non-`web:` continuation in `sessions.json`): open it after chatting on your
phone and the next message continues *that* conversation — and when a new
Telegram conversation starts, the page jumps to it. The per-key run queue in
`Agent.run` makes this sharing safe (a web turn and a Telegram turn can never
resume the same checkpoint at once).

The exchange stays visible on both ends. A Telegram turn streams into the
followed transcript live — bubbles *and* tree steps (bot.ts feeds
`remoteTurnStart/Event/End`). A webui turn that runs into a Telegram
conversation is posted back to the phone with a `💻` prefix, so the chat
there keeps making sense.

**Send to telegram reverses it, per chat.** The ✈ telegram button posts the
active web session's transcript to your linked chat and then *binds* that
chat to the web key: the phone now follows the web session. Its next message
continues the same tree and checkpoint, a phone turn appears in the browser
transcript, and every browser turn is mirrored back to the phone — both ends
share one conversation. Binding turns web-follows-telegram off (or the page
would jump back onto the phone's own key) and is remembered in
`logs/web-settings.json`; deleting the web session drops the binding. Chats
that were never bound keep their own separate conversations, exactly as
before.

The checkbox on `/settings` ("webui follows telegram") turns following off;
choosing a local web session or starting a *new chat* turns it off
automatically too. With follow off, restarts never auto-resume — a session
picker demands an explicit choice, exactly to avoid a stale tree hanging the
first turn.

## Git integration (summary)

`WORKSPACE_DIR` is a git repository (auto-initialized on first start), kept outside
the project directory so its history is completely separate from the harness's own.
Every `write_file` / `edit_file` / `delete_file` is immediately committed.
See the FAQ below for exactly how that works.

## Workspace sync (desktop ↔ phone)

The desktop can act as a git server for the workspace, letting you sync
patterns, contacts, and files between your computer and phone over LAN.

**Desktop setup** (one-time):

```sh
# Create bare repo (the "server")
git init --bare ~/grandma-workspace.git

# Add it as a remote in the live workspace
git -C ~/grandma-workspace remote add sync ~/grandma-workspace.git
git -C ~/grandma-workspace push sync main

# Start the daemon (serves on port 9418, LAN only)
cp systemd/git-daemon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now git-daemon.service
```

Edit `GIT_DAEMON_IP` in the service file to match your LAN IP.

**Phone setup** (handled by `install.sh` on deploy):

```sh
git -C ~/grandma-workspace remote add sync git://<desktop-ip>/grandma-workspace.git
```

**Syncing** — use the buttons on the settings page (`http://<phone-ip>:8080/settings`), or manually:

```sh
# Pull from desktop
git -C ~/grandma-workspace pull sync main

# Push to desktop
git -C ~/grandma-workspace push sync main
```

The runtime state under `logs/` (`grandma-kat.db*`, `sessions.json`,
`web-turns.json`, `web-settings.json`) holds your prompts and conversation text, so `index.ts`
gitignores it on boot — it stays local and out of the audit trail.

## FAQ

### Git & workspace

**How exactly does auto-commit work?**
After a file tool writes/edits/deletes a path, `autoCommit()` in `src/tools/git.ts`
runs: `git add -A -- <path>` → `git status --porcelain -- <path>` (skips with
`no-changes` if clean) → `git commit -q -m "agent(<tool>): <path>" -- <path>` →
returns `git rev-parse --short HEAD`. The hash goes into the tool result, so the
model can report it to you (and `/status` shows the latest commit).

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
On the next boot, `index.ts` recreates it (`mkdir -p`) and `ensureRepo` runs
`git init`. You lose the git history and the grandma-kat SQLite log (which
holds continuation tokens and the audit trail). All conversations start fresh.

**Where does the run log live?**
The grandma-kat runner writes every LLM call, tool call, check, goback, and
gate to a SQLite database at `<workspace>/logs/grandma-kat.db` (plus its
`-wal` and `-shm` siblings). It contains your prompts and the model's
responses, so it stays with the workspace — back up the workspace, back up
the log. On first boot `index.ts` appends `logs/grandma-kat.db*` to the
workspace's `.gitignore` so the log doesn't pollute `git status`. To inspect
manually:
```sh
sqlite3 ~/grandma-workspace/logs/grandma-kat.db \
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
On the first message from a new conversation (or after `/clear`), the bot
pre-initializes the tree: `agent.run(key, "", no-op)` creates the tree and
pauses at `.human()` immediately. Then `agent.run(key, message, onEmit)`
resumes from that checkpoint. The tree's `.memoryUpdate()` appends the user
message to `messages`, the classify branch routes to direct/contacts/tools,
the response branch generates an answer (possibly with tool calls in a loop),
and `.emit()` sends the answer to Telegram via `onEmit`. The tree then loops
back to `.human()` and pauses — checkpoint saved, continuation stored.

The debug REPL (`npm run repl`) follows the same flow but runs in the terminal
with real-time event streaming.

**Why do tool errors not crash the turn?**
`ToolRegistry.dispatch` wraps every tool in try/catch and returns errors as plain
strings (`"error: old_string not found in notes.md"`). The model sees the failure
as a normal tool result and typically self-corrects (re-reads the file, adjusts).
Only LLM/transport errors propagate up to the user as "Something went wrong".

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
are stored **outside the workspace** — `~/.grandpa-bob/secrets.db`, override
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
Yes — a "session" is a continuation token stored per conversation key
(`chatId:threadId`). The token is a checkpoint ID in the grandma-kat SQLite
log that captures the full tree state: memory slots (including `messages`),
execution position, scope chain. Lifecycle: **born** on the topic's first
message (tree pauses at `.human()`); **lives** as a checkpoint in
`<workspace>/logs/grandma-kat.db`; **cleared** by `/clear` (drops the
continuation, next message starts a new tree). The system prompt is injected
once at tree creation and persists across the entire conversation. Tool-call
traces are part of the messages history. Turns within a session are strictly
serialized by the per-topic promise queue; across sessions everything runs in
parallel.

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
/etc/passwd`, `cat ~/.grandpa-bob/.env`, `git -C /tmp …` and `--file=/abs`
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
  `~/.grandpa-bob/.env`, then `<project>/.env` — so credentials don't depend
  on a `.gitignore` line inside the checkout. The workspace dir is the only
  place the agent's file tools can touch, and `run_command` refuses
  path-like arguments outside it.
