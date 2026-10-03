# web/ — browser target

A second target for grandpa-bob that runs **entirely in a browser tab**: no
server, sandboxed virtual filesystem (OPFS), WASM SQLite, workspace persisted
in browser storage.

> **Additive.** The Node target (`src/`, `npm start`) is unchanged and keeps
> Telegram, the real shell, native SQLite/DuckDB, the git CLI, `opencode`, and
> the HTTP admin server. This directory only *adds* a browser build.

See the design plan: `~/.opencode/plan/bob-in-browser.md`.

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
| Durability (persist request + workspace export/import) | done — **verified in real Chromium** (25 files exported/restored) |
| Chat UI driving the agent worker | done — **verified in real Chromium** (smoke types a message, gets the LLM reply) |
| Git auto-commit (`isomorphic-git` over OPFS) | done — **verified in real Chromium** (`git: auto-commit 5be3f65`) |
| Clone from a CORS git remote into OPFS | done — **verified in real Chromium** (`clone: … -> 5 trees (trunk: true)`) |
| Git tools BOB can call (`git_status/log/commit/fetch/push`) | done — **verified in real Chromium** (`git-tools: branch=master changes=186 commits=5`) |
| Multi-file patterns (relative imports + named exports + node shims) | done — **verified in real Chromium** (`read/the notes file`) |
| Real `trunk` (scratch builder, app `src/*`, `appTreeNames()` scan) | not yet |

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

```sh
cd web
npm install
npm run make-seed /path/to/grandma-workspace   # pack workspace -> public/seed
npm run mock-llm   # terminal 1 (LLM demo)
npm run dev        # terminal 2 -> http://localhost:5173
npm run smoke      # headless end-to-end check
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
http://localhost:5173/?remote=http://127.0.0.1:8790/grandma-workspace.git
http://localhost:5173/?remote=...&reclone=1   # clear OPFS and clone fresh
```

The app clones into `/workspace` when it has no `.git`. To also **push** back
(copy browser → desktop), enable receive-pack on the bare repo:
`git -C <repo>.git config http.receivepack true` (loopback only; add auth before
exposing it).

### Storage backend selector (browser OPFS vs desktop)

The header has a **Storage** selector:

- **Browser (OPFS)** — everything lives in the browser (the mode above).
- **Desktop (local server)** — BOB's file/shell/git tools operate on the real
  workspace via a loopback bridge:

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
a running dev server. It exercises OPFS writes/rename, `tree-versions`
snapshot/promote, `grandma-kat knit()`, WASM SQLite persistence, and a real LLM
round-trip.

The LLM smoke also needs the mock endpoint: `npm run mock-llm` (port 8787) in a
second terminal.

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
