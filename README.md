# Grandpa Bob Bot

_BOB = **B**etter **O**rganizational **B**ot_

A local agent harness you chat with from Telegram — text, voice, photos, or files. It can
read, write and organize files on this machine inside a sandboxed workspace, and
every change it makes is **git-committed automatically**.

- **Telegram**: long polling via grammY. Works in DMs and in **forum-topic groups** —
  each topic is an independent conversation with its own history.
- **Web UI**: chat front page at `http://<host>:8080` — talk to the agent by
  text or voice and watch every step of the tree execute live. Settings
  (credentials, sync, logs, patterns, files) live at `/settings`.
- **Voice → text**: voice notes are transcribed locally by
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) built with the **Vulkan**
  backend, running on the AMD RX 570. No audio leaves the machine.
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

## Setup

1. **Telegram bot**: create one with @BotFather, copy the token. Get your numeric
   user id from @userinfobot.
2. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN` and `ALLOWED_USER_IDS`.
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
   (used by `npm run whisper:up`).
5. **LLM backend** — copy `models.example.json` to `models.json` and edit.
   The file defines two named slots the agent pattern uses: `cheap` (routing
   + direct answers) and `strong` (the tool-using loop). Each entry has
   `baseURL`, `apiKey`, `model`, and optional `transform` / `protocol`
   fields. Secrets use `${ENV_VAR}` interpolation from `.env`.
   Bot startup pings each registered model and prints
   `reachable` / `NOT reachable` per entry.
   `models.example.json` ships with native Ollama cloud entries
   (`protocol: "ollama"`, `baseURL: https://ollama.com`) — just set
   `OLLAMA_API_KEY` in `.env` and you're done. For other providers
   (HF router, local llama.cpp, OpenAI, etc.) edit the entries directly.

   Note: small local models vary a lot in tool-calling quality — if the agent
   misuses tools, switch models before debugging anything else.

## Run

```sh
npm run whisper:up   # terminal 1: whisper-server on 127.0.0.1:8178
npm run dev          # terminal 2: the bot
```

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
- Send text, send a **photo** (caption optional) for image analysis, or hold the
  mic and send a **voice message** — you'll get `heard: "…"` plus the agent's reply.
- Commands:
  - `/clear` — drops the conversation continuation for this topic. The next message starts a fresh tree (new system prompt, empty history). Per-topic: each forum topic has its own continuation. The checkpoint in SQLite is orphaned but not deleted.
  - `/status` — shows workspace path, git status, LLM models, STT backend.

## Web UI

The admin server (port `ADMIN_PORT`, default 8080) serves two pages:

- **`/` — chat front page.** Talk to the agent by **text** or **voice**. Voice is
  recorded in the browser (MediaRecorder), uploaded, and transcribed locally by the
  same ffmpeg → whisper/sherpa pipeline as Telegram voice notes — no audio leaves the
  machine. A **📎 button transcribes an audio file** (`.ogg`, `.webm`, `.mp3`, `.m4a`,
  `.wav`, …): the transcript **streams live** as the file is processed — a progress
  card shows `12s / 47s` plus the growing text, then the final transcript lands in the
  input box for you to review and send. As the agent runs, **every grandma-kat tree
  event streams live** (SSE) and is rendered as labeled steps under your message
  (human → memory → gate/classify → llm → tool calls/results → emit), with the final
  answer shown below. Each step expands to its full payload. The last 20 turns are kept
  so a page reload restores the conversation. "clear conversation" starts a fresh tree.
  - Streaming detail: with the `whisper` backend the file is sliced into 20s chunks
    transcribed in order (partials flow after each chunk); with `sherpa` the online
    decoder's live partials are forwarded directly.
  - Note: browser microphone access needs a **secure context** — voice works on
    `http://localhost:8080` but not on a plain-HTTP LAN IP (text and file upload still
    work there).
- **`/settings` — admin page.** Credentials & `.env` editor, bot/sherpa status +
  restart, log tails, workspace git sync/commit, tree-pattern editor, and the
  workspace file browser.

The chat page runs the agent under `web:<id>` conversation keys, serialized
so turns never interleave; Telegram topics are unaffected. Chat histories
persist to `<workspace>/logs/web-turns.json` and survive bot restarts —
but **nothing auto-resumes**: after a restart the page shows a session bar
and the next message goes to the stored tree only after you explicitly
pick *resume* (or start a *new chat*). Telegram keeps auto-resuming.

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
git -C ~/grandma-workspace push sync master

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
git -C ~/grandma-workspace pull sync master

# Push to desktop
git -C ~/grandma-workspace push sync master
```

The runtime state under `logs/` (`grandma-kat.db*`, `sessions.json`,
`web-turns.json`) holds your prompts and conversation text, so `index.ts`
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
Not through its tools: `.env` lives outside the workspace and file tools can't
reach it. Be careful what you add to `ALLOWED_COMMANDS` though — something like
`env` or a shell would punch a hole (which is why they're not in the defaults).

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
- Keep `.env` out of the workspace; the workspace dir is the only thing the
  agent can touch.
