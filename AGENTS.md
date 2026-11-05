# AGENTS.md

Grandpa Bob Bot (BOB) is a local agent harness whose only UI and agent host is the browser app in `web/` + `ui/`. The agent runs as a grandma-kat tree in a web worker; the Node processes in `src/` are pass-through channels only (Telegram long-poll, peer mailbox/pairing, optional STT). Shared runtime code lives in `web/src` and must not import from `src/` (`npm run test:standalone` enforces that boundary). Start everything with `npm run bob` — app on `:8080`, channels on `:8795`.

Patterns and apps are authored in the workspace, not in this repo. The grandma-kat engine is an external repo (`git+https://github.com/hfxaiguy/grandma-kat.git`), imported as the `grandma-kat` package — never by relative path into a checkout. Repo-side tooling lives in `scripts/` (tests, spec lint, seed publishing), `feature-plans/` (design docs), and `docs/` (pairing/sync).

Runtime state lives under `~/.bobkat` (override with `BOB_STATE_DIR`), not `~/grandma-workspace`. Profiles are directories at `~/.bobkat/folders/<name>`; the seed profile, where apps are edited, is `~/.bobkat/folders/seed`. A profile's workspace holds its `app/`, `patterns/`, `logs/`, and git history; the workspace's own `AGENTS.md` documents its layout and conventions.
