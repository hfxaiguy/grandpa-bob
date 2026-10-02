# web/ — browser target

A second target for grandpa-bob that runs **entirely in a browser tab**: no
server, sandboxed virtual filesystem (OPFS), WASM SQLite, workspace persisted
in browser storage.

> **Additive.** The Node target (`src/`, `npm start`) is unchanged and keeps
> Telegram, the real shell, native SQLite/DuckDB, the git CLI, `opencode`, and
> the HTTP admin server. This directory only *adds* a browser build.

See the design plan: `~/.opencode/plan/bob-in-browser.md`.

## Status — milestone 0 (platform seam)

| Piece | State |
|---|---|
| Shared pure path shim (`src/platform/paths.ts`) | done, tested vs `node:path.posix` |
| Shared pure SHA-256 (`src/platform/sha256.ts`) | done, tested vs `node:crypto` |
| Platform interfaces (`src/platform/types.ts`) | done |
| Node adapter (`src/platform/node.ts`) | done |
| OPFS `FileSystem` (`web/src/platform/corefs.ts`) | written, builds; needs live-browser smoke test |
| Browser adapter (`web/src/platform/browser.ts`) | fs/path/crypto wired; shell + git stubbed |
| Worker-as-server, WASM SQLite, LLM, git, virtual coreutils | not yet (milestones 1–5) |

## Run

```sh
cd web
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build
```

The page runs a smoke test: it creates `/workspace/notes/hello.txt` in OPFS,
reads it back, stats it, lists the workspace, renames the file, and prints a
SHA-256.

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
