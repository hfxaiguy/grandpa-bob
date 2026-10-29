# Feature plan — standalone-only: the web app is the only host; everything else is a channel

Status as of 2026-10-27. **Agreed direction; no code changed.** This plan is the
verification target for the refactor: when the work is finished, the
[Verification gates](#verification-gates) below are the definition of done.

Work happens on a `standalone-only` worktree branched from `main` *after* the
current WIP is committed. This plan file is committed to `main` in phase 0 so
the worktree carries it.

Decision in one line: **the browser app (`web/` + `ui/`) becomes the only UI
and the only agent host; Node processes shrink to pass-through channels
(telegram, storage bridge, STT); profiles work on desktop folders; and a
real-time sync channel — OPFS↔desktop over BroadcastChannel/WebRTC with
BobSwap-REST or manual-paste signaling — is the only path between devices.**

---

## Agreed decisions (log)

| # | Decision |
|---|---|
| 1 | The web app is the **only UI and the only agent host**. Node never runs the agent. |
| 2 | Node shrinks to **pass-through channels**: telegram (park & forward), storage bridge, STT. The bridge stays **loopback-only** — there is no remote-storage mode. |
| 3 | Telegram: **park & forward** — the channel queues messages per chat in a small local mailbox file; the web app drains and runs the tree on connect. A chat→profile route is stored channel-side. |
| 4 | STT: **channel-only first**. The bridge gains an opt-in `/stt` (ffmpeg → whisper-server). In-tab whisper is *not built* — the `@huggingface/transformers` dep (currently unused) is dropped. |
| 5 | Desktop profiles: **one folder per profile**, via a folder registry on the (loopback) bridge. |
| 6 | **Sync is the only cross-device channel.** A phone tab is a full local replica (OPFS); a desktop tab is a replica on the real folder (loopback bridge). "A" (remote Desktop mode) is rolled into the sync model, not kept as a second sharing path. |
| 7 | Sync transports: **BroadcastChannel** (same origin, no pairing) and **WebRTC DataChannel** (cross-device). Signaling: **BobSwap REST mailbox** (automatic) **and manual paste** (non-trickle, no service). A DTLS-fingerprint verification phrase is shown on both sides. No LAN signaling listener. |
| 8 | The shared core **moves** into `web/src` (moved, not copied) — after the Node shrink, so nothing imports out of `web/`. |

## Target architecture

```
┌───────────── browser tab — the only UI and the only agent host ─────────────┐
│  web/ + ui/  ·  agent tree runs here (worker)  ·  profiles: OPFS | desktop  │
└──────┬───────────────────┬──────────────────────────┬──────────────────────┘
       │                   │                          │
  desktop channel       telegram channel          sync channel (peer-to-peer)
  storage-server.mjs    grammy long-poll;          BroadcastChannel (same origin)
   + /stt (ffmpeg→      park & forward mailbox     WebRTC DataChannel (cross-device,
     whisper-server)     per chat; no agent,        signaling: BobSwap REST or
   + folder registry     no UI                      manual paste)
  (loopback only)       → feeds web sessions
```

What each existing piece becomes:

| Today | After |
|---|---|
| `src/admin.ts` (3163 lines: admin API + UI serving) | dismantled; channels only |
| `src/bot.ts` + `src/agent.ts` (1003 lines: Node runs the tree for Telegram) | telegram **channel**: long-poll, auth gate, topic routing, **park & forward** |
| `src/telegram-bridge.ts` bridge endpoints in `admin.ts:2105-2180` | owned by the telegram channel; `ui/src/store.ts` polls the channel origin |
| `web/scripts/storage-server.mjs` (one fixed root) | desktop **channel**, loopback-only, folder registry → one folder per desktop profile; gains opt-in `/stt` |
| manual sync buttons / `auto-sync` interval | sync **channel**: live ops between replicas |
| BobSwap shelf/relay | unchanged (seed feature); REST reused for sync signaling |
| `src/ui/pages.ts` (1130-line HTML settings page) | moves into `web/src` (or is retired — open decision #3) |
| `BOB_WEB=1` modes, server-only UI controls (restart, service health, bot logs) | deleted from `ui/`; channels become status chips |
| `@huggingface/transformers` dep | dropped (no code references it) |

## Constraints carried from the design review

These are **not optional**; they gate the phases that depend on them.

1. **The bridge never leaves loopback** (`storage-server.mjs:194` binds
   `127.0.0.1`; the file itself says *"Loopback-only; add auth before exposing
   it"* at line 7). No `--listen` storage flag. A folder registry is an
   allow-list of folders, not of clients — so there is no LAN exposure of
   `/fs`, `/sql`, `/git`, `/stt` in this plan.
2. **Single-host lease per profile** must exist before automatic mailbox
   draining goes live. Today the only multi-tab handling is a warning
   (`web/src/platform/sqlite-worker.ts:65-71`: *"If this profile is open in
   another tab, close it and reload"*); there is no `navigator.locks` /
   leader election anywhere. Two tabs draining one mailbox = duplicate runs,
   doubled LLM spend, sahpool contention.
3. **The Node shrink precedes the core move.** Root `tsconfig.json` has
   `rootDir: "src"` / `include: ["src/**/*.ts"]`, and 52 root scripts import
   `../src/`. Moving the core while the Node agent host still imports it
   cannot compile. Order: shrink → move.
4. **Only browser-used tool modules move** with the core: `files`, `json`,
   `sqlite`, `csv`, `websearch`, `app-dbs`. `shell`, `git`, `git-tools`,
   `opencode` are Node-only and die with the Node host.
5. **Sync never raw-copies a live SQLite DB.** Desktop `logs/grandma-kat.db`
   is open through the bridge's `/sql/*`; the OPFS run log lives under
   `.gpb-runlog` (`opfs-sahpool`). DBs travel as snapshots, `logs/` is
   excluded — the same rule `storage-swap.md` already records for archives.
6. **LWW is by ops-log sequence + content hash, not mtime** (clock skew across
   devices). Conflict copies (`<path>.conflict-<ts>`) are marked sync-generated
   and excluded from re-sync. Tombstones carry deletes and need GC.
7. **Phone needs HTTPS.** OPFS (and the run log's `opfs-sahpool`) is a
   secure-context API; `http://<lan-ip>:8080` on a phone likely has no browser
   storage at all. LAN TLS (e.g. `tailscale serve`) is a requirement for phone
   use, not an optimization.
8. **Availability expectations are documented, not promised.** Without a TURN
   server some NAT combos fail WebRTC; mobile tabs suspend in the background,
   so "real time" degrades to reconnect-and-catch-up; iOS Safari backgrounded
   is effectively offline.

---

## Phases

### Phase 0 — hygiene + worktree

- [ ] Commit the uncommitted WIP on `main` (26 files, +1436/−228: async log
      store, seed-update watching) as its own commit(s).
- [ ] Commit this plan file to `main`.
- [ ] Create the worktree: `standalone-only` (branch `standalone-only`,
      `../grandpa-bob-bot-standalone-only`), move the session's working
      directory there.

**Acceptance:** `main` is green; the worktree exists and contains this plan.

### Phase 1 — single-host lease per profile

- [ ] Per-profile lease via `navigator.locks` (name includes profile id /
      storage root), with a BroadcastChannel heartbeat as fallback and
      explicit **take over** semantics (the OPFS sahpool handles of a dead tab
      release on tab close, so takeover after a crash is safe).
- [ ] Applies to both storage kinds (browser OPFS and desktop bridge): only
      the lease holder runs turns and drains mailboxes.
- [ ] UI: a second tab on the same profile renders read-only with a notice +
      "take over" button.

**Acceptance:** two tabs on one profile → the second does not run turns;
killing the first tab lets the second take over.

### Phase 2 — Node shrinks to channels

- [ ] **Telegram channel**: repurpose `bot.ts` + `telegram-bridge.ts` as a
      channel process (grammy long-poll, auth gate, forum-topic routing
      unchanged). Mailbox: one JSONL file per chat under `~/.grandpa-bob/`
      (survives channel restarts; at-least-once delivery using the existing
      message ids). Push to connected tabs (WS or SSE) + drain-on-connect.
      Chat→profile route stored channel-side. Epoch logic preserved for tab
      handover between profiles.
- [ ] Move the bridge endpoints out of `admin.ts:2105-2180`
      (`/api/telegram/bridge|inbox|relay`) into the channel; the browser
      poller (`ui/src/store.ts`, `BRIDGE_KEY`) targets the channel origin —
      a new setting beside `storage-server`. Channel CORS: allow-list of the
      app origins, not `*`.
- [ ] The Node agent host **dies**: `src/agent.ts` (1003 lines), the
      `patterns/` Node runner, `src/tools/index.ts` (Node registry incl.
      `shell`, `git-tools`, `opencode`). The browser worker
      (`web/src/agent/agent-worker.ts`) is the host — it already has
      continuation/resume, stop, and the 402 quota-fallback UI
      (`ui/src/app.tsx:48`).
- [ ] **STT channel**: opt-in `/stt` on the bridge (ffmpeg → whisper-server
      `:8178`); `transcribe-stream` repoints to the bridge; Telegram voice
      notes are transcribed channel-side, so the mailbox parks *transcripts*,
      never `.ogg` blobs. In-tab whisper is not built; drop
      `@huggingface/transformers`.
- [ ] **Admin dismantled**: no UI serving, no `/api` proxy; `BOB_WEB` modes
      die; `ui/` loses server-only controls (restart, service health, bot
      logs, follow-telegram node config); channels render as status chips.
      Note the browser-side secret store already exists
      (`web/src/server/local-backend.ts:485-486`) — app secrets keep working.
- [ ] **Deps**: drop `openai` (type-only imports in the dying modules), keep
      `grammy` + `dotenv`. The bridge stays zero-dependency and
      loopback-bound.

**Open decision #1 applies here:** the headless host (systemd unit running
headless Chrome against the desktop profile — the `web/scripts/chrome.mjs` +
CDP harness already exist) as the always-on telegram owner and sync peer. If
not adopted, Telegram goes silent whenever no tab is open (the deliberate loss
of today's `BRIDGE_AWAY_TEXT` fallback identity — `telegram-bridge.ts`
docblock). See Open decisions.

**Acceptance:** a Telegram message with no tab connected is parked; a tab
connects and the turn runs; channel restart preserves the mailbox; two tabs →
one drains (lease); voice notes come back as transcripts; the bridge still
binds `127.0.0.1`.

### Phase 3 — `web/` owns the core

- [ ] **Move** (not copy) the ~26 crossing modules into `web/src`:
      `platform/{types,paths,sha256,coreutils}`, `tools/{files,json,sqlite,csv,
      websearch,app-dbs}` + their transitive imports, `tree-sources`,
      `tree-files`, `tree-serialize`, `tree-versions`, `app-store`,
      `app-attribution`, `memory-track`, `web-log`, `web-log-types`,
      `model-config`, `db-sync`, `auto-sync`, `ref-target`, `stop-error`,
      `sanitize`, `tool-guides`, `util/emit-text`, `ui/pages`. Flip ~60 import
      sites; the web tsconfig's hand-picked `../src/...` include list
      disappears.
- [ ] Node bits that still need shared code import from `web/src`
      temporarily — root `tsconfig` adjusted (`rootDir: "."` or project
      references) so `npm run build` never breaks.
- [ ] Repoint the 52 root scripts importing `../src/` to `web/src`; delete
      Node-target-only tests (telegram host, admin, stt-specific) that no
      longer have a subject.
- [ ] **Boundary gate**: `scripts/web-standalone-test.ts` fails if anything
      under `web/` imports outside `web/` + `ui/` + bundled deps. This is the
      permanent "self-contained" gate.

**Acceptance:** both tsconfigs typecheck; `build:web` + `web:standalone` boot;
the boundary test is green; the smoke suite passes.

### Phase 4 — desktop-folder profiles

- [ ] `ProfileRecord` gains `kind: "opfs" | "desktop"` (+ folder binding);
      `profiles.json` (`web/src/profiles.ts`) lists both kinds.
- [ ] Bridge folder registry: `~/.grandpa-bob/channels.json` bindings
      `{profile → folder}`; loopback-only; explicit allow-list (the browser
      can only bind profiles to registered folders).
- [ ] Per-request root routing on the bridge (URL prefix or header) +
      `createDesktopPlatform("/", server)` adapter change
      (`web/src/main.ts:818`); the path sandbox stays per profile.
- [ ] Migration: the existing single-root desktop setup becomes a `default`
      desktop profile.
- [ ] Export/import and seeding work per kind; per-profile logs and git
      history live in their folder.

**Acceptance:** two desktop profiles on different folders switch cleanly;
the single-root setup migrates; archive export/import and seed apply work on
desktop profiles.

### Phase 5 — real-time sync channel

- [ ] **Model**: append-only ops journal per replica (path, op = write |
      delete-tombstone, content hash, seq). Per-path LWW by seq + hash.
      Conflict copies `<path>.conflict-<ts>`, marked sync-generated and
      excluded from re-sync, reported in the event log. Tombstone GC.
- [ ] **DBs**: snapshots only; never raw-copy live DBs; `logs/` and
      `.gpb-runlog` excluded. Initial state rides the WorkspaceArchive
      (v1 JSON; ZIP v2 per `storage-swap.md` when that lands).
- [ ] **Bootstrap at pairing**: direction choice — push mine / pull theirs /
      merge — followed by the reconcile below.
- [ ] **Reconcile on reconnect/boot**: exchange path→hash maps, replay missed
      ops; full-archive transfer only when the diff is too large.
- [ ] **Transports**: BroadcastChannel (same origin, no pairing) day one;
      WebRTC DataChannel cross-device; chunk framing reused from
      `swap.ts`'s `RelayMessage` (chunk/ack/complete/abort, sha-verified).
- [ ] **Signaling** (`web/src/sync/signaling/`): `bobswap.ts` (REST mailbox —
      the server-side prompt was delivered separately; trickle ICE, 2–3 s
      polling), `manual.ts` (non-trickle: gather-complete bundle, one paste
      per direction; the blob can travel over any messenger, Telegram
      included), shared `verify.ts` (6-word phrase from the DTLS
      fingerprints; the engine starts only after both sides show a match).
      Same-origin tabs skip pairing via BroadcastChannel.
- [ ] **UI**: a Sync dialog — pair (code / manual), status
      (`connecting → verifying → syncing · N files`), conflict list, journal
      state. Sync is opt-in per profile pairing.
- [ ] Document availability limits (no TURN initially; background suspension;
      HTTPS requirement) in `web/README.md`.

**Acceptance:** OPFS replica ↔ desktop folder converge in both directions;
deletes propagate; a killed peer catches up on reconnect; simultaneous edits
to one path produce a conflict copy, not silent loss; manual-paste pairing
works with the BobSwap service unreachable.

### Phase 6 — docs, scripts, packaging

- [ ] README / `web/README.md` / CHANGELOG rewrite to the channels story:
      one UI/host, pass-through channels, desktop profiles, sync.
- [ ] `package.json` scripts renamed (`dev`/`start` → channel runner);
      `.env.example` updated; systemd units per channel (telegram, whisper,
      storage); the LAN git-daemon story re-evaluated against the sync
      channel (likely retired or kept as an offline bulk path).
- [ ] Dead Node-target tests removed; spec-lint updated; seed tooling
      (`make-seed`, `publish-seed`, `git-server`) verified against
      per-folder profiles.

**Acceptance:** docs match reality; `npm test`-style entries all pass or are
intentionally removed with a note.

---

## Verification gates

Run when the work claims to be finished. Every gate must pass or the gap must
be documented in this file.

**Status after the implementation session (2026-10-29):**

| Gate | State |
|---|---|
| 1. typechecks (src, web, ui) | **PASS** |
| 2. `build` + `build:web` + `web:standalone` boots | **PASS** (boot asserted by the browser smokes' serving path; profile/browser interactive smokes ran headless-only — see gaps) |
| 3. boundary gate (`test:standalone`) | **PASS** — 90 files clean |
| 4. two-tab lease interactive check | **PARTIAL** — unit-gated in `test:lease` (contention, staleness, takeover); the two-real-tabs browser smoke is a gap |
| 5. telegram channel tests | **PASS** — mailbox park/claim/ack/answered, restart survival, handover epoch (`test:telegram-bridge`); text/audio framing (`test:telegram-text`, `test:telegram-audio`) |
| 6. loopback-only bridge | **PASS** — `127.0.0.1` bind unchanged; no storage LAN flag exists |
| 7. sync tests | **NOT MET** (documented below) |
| 8. no `@huggingface/transformers` | **PASS** — dep removed, no references |
| 9. remaining `test:*` pass | **PASS with 3 documented failures** — `test:tree` and `test:cdp` fail identically on `main` (pre-existing, grandma-kat API drift / environment); `test:sync` is experimental (gate 7) |
| 10. seed flows | **PARTIAL** — `test:seed-freshness` + `test:workspace-transfer` + `test:profiles` pass; live seed-apply onto a desktop profile lacked an end-to-end check (gap) |
| 11. docs match reality | **PARTIAL** — README banner + `.env.example` + CHANGELOG rewritten; the deeper README/web README sections still carry pre-refactor prose (marked) |
| 12. `main` stayed green | **PASS** — phase 0 committed the WIP + plan to `main` first; all work on `standalone-only` |

**Gate 7 (sync) — what is NOT met and what was learned.** The transports
(BroadcastChannel same-origin; WebRTC datachannel with BobSwap-REST + manual
paste, verification phrase) are in place and the engine speaks one envelope;
the reconcile protocol fails its offline suite under concurrency. Concrete
findings (each fixed in code but the composition is still not convergence-
stable under all orderings): (a) per-replica seq counters cannot order
writes across replicas — replaced by a **Lamport-clock journal** with a
deterministic replica-id tie-break; (b) "absent from my snapshot" must not
mean "I deleted it" — only the journal authorizes tombstones (an asymmetric
snapshot was manufacturing deletes that beat real writes; fixed); (c)
diff-pushes must push the content the journal vouches for — a file changed
between map and push now defers (`hash === lastOp.hash` check; fixed); (d)
equal-lamport pushes need a single decision point — the apply-side tie-break
and the reconcile-side diff must agree or the loser's bytes become conflict
copies twice. Next work: reorder rounds so exactly one side diffs per
exchange (the responder), then re-run `test:sync` to green, then wire the
boot hookup out of `?sync=1`. The transports and journal survive unchanged;
no workspace bytes leave the replicas in any mode.

1. `npm run typecheck`, `npm --prefix web run typecheck`, `npm --prefix ui run
   typecheck` — all green.
2. `npm run build` and `npm run build:web` succeed; `npm run web:standalone`
   boots and answers the smokes.
3. `scripts/web-standalone-test.ts` green — nothing under `web/` imports
   outside `web/` + `ui/`.
4. Two-tab lease test green — only one host per profile; takeover works.
5. Telegram channel tests green: park with no tab, drain on connect,
   mailbox survives restart, chat→profile route, epoch on handover, voice →
   transcript at the channel.
6. The bridge still binds `127.0.0.1` only; no storage LAN flag exists.
7. Sync tests green: bidirectional convergence, tombstone delete
   propagation, offline catch-up, conflict copy behavior, chunk framing
   round-trip (shared with the relay), manual-paste pairing with BobSwap
   unreachable.
8. No references to `@huggingface/transformers` in source; dep removed.
9. All remaining `test:*` scripts pass; the removed ones are accounted for
   in the changelog.
10. Seed flows unchanged and working (`make-seed`, `publish-seed`, seed
    update watching).
11. README / `web/README.md` / CHANGELOG describe the final architecture
    accurately; no stale "Node agent" or "in-tab whisper" claims.
12. `main` still builds and passes its gates throughout (worktree-based
    workflow, no breakage on `main`).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two tabs both host/drain | Lease (phase 1) before auto-drain (phase 2) |
| Telegram unavailable with no tab | Headless host (open decision #1); otherwise documented "waits for a tab" |
| Live DB corruption via sync | Snapshot-only DB rule; `logs/` excluded (constraint 5) |
| Silent data loss on conflicts | LWW by seq+hash + conflict copies + event-log surfacing |
| Core move breaks the Node build | Node shrink first (constraint 3); tsconfig adjusted in the same change |
| Script repoint churn (52 files) | Mechanical, scripted; dead tests deleted deliberately with a list |
| Phone unusable over plain HTTP | Document HTTPS requirement; Tailscale/LAN TLS path |
| WebRTC fails on some NATs | Manual-paste fallback; BobSwap relay as cross-network fallback; TURN is future work |
| BobSwap service unavailable for signaling | Manual paste needs no service at all |
| Scope creep in one branch | Phases are separately verifiable; each ends at a green gate |

## Open decisions

1. **Headless host** — adopt (recommended: preserves Telegram availability and
   provides the always-on sync peer) or accept "phone waits for a tab".
2. **In-tab whisper later** — deliberately deferred; revisit only if a real
   no-server voice need appears (dep dropped for now).
3. **Settings UI** — migrate the 1130-line HTML settings page into the
   SolidJS app (true "one UI") or keep two technologies. The move happens
   either way; the unification is the open part.
4. **TURN** — deploy coturn only if cross-network WebRTC failures show up in
   practice.
5. **Shelf vs sync** — keep seed updates (shelf) and the sync channel as
   separate features (assumed), or unify their update flow later.
6. **ZIP v2 ordering** — `storage-swap.md` may land before or after phase 5;
   sync uses the v1 archive until then.

## References

- `tsconfig.json` — `rootDir: "src"`, the Node-build constraint.
- `web/scripts/storage-server.mjs:7,19,194` — loopback contract, CORS `*`,
  bind address.
- `web/src/platform/sqlite-worker.ts:65-71` — the multi-tab warning; the
  reason the lease exists.
- `src/telegram-bridge.ts` (docblock) — today's park & fallback design; the
  fallback identity this plan deliberately removes.
- `src/admin.ts:2105-2180` — telegram bridge endpoints to relocate.
- `ui/src/store.ts:94,446-456`, `src/admin.ts:240-249`, `src/stt.ts` —
  server-side transcription the web UI relies on today.
- `web/src/server/local-backend.ts:9,485-486` — "no browser equivalent"
  endpoints; the browser secret store.
- `ui/src/app.tsx:48-49` — the browser 402 fallback UI (parity for the
  dead Node host's quota flow).
- `web/src/main.ts:815-830` — desktop boot path + bridge URL; OPFS run log
  even on desktop (`initSqlite`).
- `web/package.json:29` — the unused `@huggingface/transformers` dep.
- `feature-plans/storage-swap.md` — archive container v1/v2, DB snapshot
  policy, seed/boot flows.
- `feature-plans/kat-async-log-store.md` — the WIP committed in phase 0.
