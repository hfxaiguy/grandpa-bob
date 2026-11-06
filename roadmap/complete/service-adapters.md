# Pluggable service adapters (STT / TTS / others)

**Status:** Complete — archived 2026-11-06
**Owner:** unassigned
**Created:** 2026-11-05
**Updated:** 2026-11-06
**Follow-ups:** [`../cleanup/service-adapters-leftovers.md`](../cleanup/service-adapters-leftovers.md)
**Scope:** make speech and other external services pluggable. STT ships with
whisper/sherpa/parakeet, AssemblyAI (in-tab) and Rime (via the desktop); TTS
ships with local KittenTTS and Rime Mist v3 (via the desktop).

---

## Spike result (2026-11-05) — CORS check, done

Ran from this machine with `Origin: http://localhost:8080` (the app origin), no
API key needed for the header check:

- **STT Sync API** (`POST https://sync.assemblyai.com/v1/transcribe`) —
  preflight `OPTIONS` returns **200** with `access-control-allow-origin: *`,
  `allow-methods: POST, OPTIONS`, and `allow-headers` that include
  `Authorization` and `X-AAI-Model`. The actual response also carries
  `access-control-allow-origin: *`, so the tab can read even error bodies.
  A bad key returns `404` `application/problem+json`
  `{"status":404,"detail":"Invalid API key"}` — **auth failures surface as
  404, not 401/403**; the Settings Test button maps that to "key
  rejected".
- **TTS-1** (`POST https://tts.us.assemblyai.com/v1/speech`) — preflight
  returns **204** with `access-control-allow-origin: *`,
  `allow-headers: authorization, content-type`. Also browser-callable.
- **Conclusion:** the hard gate is cleared — cloud adapters in the browser tab
  work for both directions, no temporary-token workaround needed. Not yet
  verified: one real-key transcription round-trip (no AssemblyAI key on this
  machine) and an actual mobile-browser request.

---

## Goal

One adapter architecture for external services, with STT and TTS as the first
two kinds:

- providers are small modules behind a common interface;
- the active provider is chosen in Settings, not by editing `.env` and
  restarting;
- the same adapter runs wherever the audio is — browser tab, local channel, or
  paired desktop — without a second implementation;
- adding a provider (AssemblyAI, ElevenLabs, OpenAI, local Piper, …) is a
  registry entry plus one file, not a new code path.

---

## What exists now

- `src/stt.ts` — whisper, sherpa, parakeet wrapped as registry entries behind
  `createSttDispatcher` / `transcribeWithProvider`, with provider-named errors.
  Serves Telegram voice notes and the peer `stt-run` op.
- `web/src/services/` — `types.ts` (the small adapter contract), `registry.ts`
  (provider ids/labels + cloud flag), `config.ts` (`bob:services`), and
  `stt/assemblyai.ts` (cloud adapter + auth probe).
- **Settings → Speech** — STT provider, language, per-provider cloud keys,
  Save, Test; TTS provider + voice.
- The chat UI routes the chosen provider: AssemblyAI in the tab; everything
  else over the peer channel (`stt-run` / `tts-run`). Rime's key transits that
  channel per request because its WebSocket upgrade cannot be made from a
  browser. There is no HTTP speech route and no `BOB_STT` flag anymore.
- **TTS** — `src/tts.ts` dispatches to local KittenTTS
  (`scripts/kitten-tts-server.py`, `npm run tts:up`) or Rime Mist v3
  (`mist.api.rime.ai`, no CORS so it runs on the desktop); replies are chunked
  (Rime at 1,000 chars), WAVs joined, cached, and played through a 🔊/⏹ toggle;
  Settings has auto-speak.
- The debug bridge now allows only loopback Origins (`web/scripts/storage-server.mjs`);
  a foreign Origin gets 403 before any route runs.
- `web/scripts/storage-server.mjs` keeps `/fs`, `/git`, `/sql`, `/health` for
  the debug CLI only.
- Tests: `npm run test:stt-dispatch`, `npm run test:stt-cloud`,
  `npm run test:tts`, `npm run test:storage-cors`; `npm run verify:speech`
  checks this machine (servers, `kittenml`, and exported cloud keys).
- New dependency: `ws` (Node-only; Rime's upgrade needs custom headers).

## Verification

`npm run verify:speech` covers the machine-level parts (server reachability,
`kittenml`, exported cloud keys). The real-key/manual checklist moved with the
open items: [`../cleanup/service-adapters-leftovers.md`](../cleanup/service-adapters-leftovers.md).

---

## Architecture (implemented)

Reuse the spirit of the existing `models.json` pattern — a small registry and a
generated settings card with a **Test** button — without the file machinery:
config is browser storage, not a JSON file with `${ENV}` interpolation.

```
web/src/services/
  types.ts        SttAdapter, TtsAdapter, AudioClip, Transcript
  registry.ts     provider ids/labels + cloud/browser flags
  config.ts       bob:services getter/setter (localStorage)
  stt/assemblyai.ts
src/stt.ts        local backends + Rime wrapped as registry entries
src/stt-rime.ts   Rime streaming WebSocket client (ws)
src/tts.ts        KittenTTS adapter + dispatcher
scripts/kitten-tts-server.py   local TTS service (`npm run tts:up`)
```

Local implementations stay in `src/stt.ts`: they need ffmpeg/fs and already
work. `web/src` gains only the types, the registry data, the config helper, and
the AssemblyAI adapter; Node additionally gains the Rime client and the TTS
dispatcher. The boundary is unchanged: Node imports `web/src`, never the
reverse.

### Adapter interfaces (small on purpose)

```ts
interface SttAdapter {
  id: string;             // "assemblyai" | "rime" | "whisper" | "sherpa" | "parakeet"
  label: string;
  endpoint?: string;      // cloud URL; doubles as the relay allowlist entry
  cloud?: boolean;        // true = cloud service
  transcribe(clip: AudioClip, ctx: SttAdapterContext): Promise<Transcript>;
  check?(ctx: SttAdapterContext): Promise<boolean>;   // Settings "Test"
}

interface TtsAdapter {
  id: string;             // "kitten"
  label: string;
  endpoint?: string;
  cloud?: boolean;
  synthesize(text: string, ctx: TtsAdapterContext): Promise<AudioClip>;
  check?(ctx: TtsAdapterContext): Promise<boolean>;
}
```

That is the whole contract. No `capabilities`, `runsIn`, `requiresFfmpeg`,
`formats`, or `fallback`: streaming is deferred, the implementation location is
known per provider (the registry's `browser` flag), container handling already
exists in `src/stt.ts`, and one provider with a clear error beats a fallback
chain. Add fields when a second consumer actually needs them.

### Config

Global and browser-side: one `bob:services` config per browser origin
(`web/src/services/config.ts`), shared by the chat UI and the Settings page and
across all profiles. The Settings card writes the same key directly:

```json
{
  "stt": {
    "provider": "rime",
    "language": "en",
    "keys": { "assemblyai": "…", "rime": "…" }
  },
  "tts": { "provider": "kitten", "voice": "Bella" }
}
```

- Applies immediately on save — no restart, no mtime cache, no peer op, no
  Node round-trip.
- Keys are per provider. Only cloud providers receive one; local providers
  never see a secret.
- One provider, no fallback chain: the chosen provider is the only one tried;
  failures surface as-is.
- Node keeps reading `.env` only for its own local STT (Telegram voice notes);
  that path is unchanged for now.

### One dispatcher (Node), one lookup (browser)

Only the Node side gets a dispatcher: registry entries map
`stt-run.provider` / `tts-run.provider` → an implementation. The browser has
no adapter lifecycle — the registry's `browser` flag decides where a provider
goes:

- `browser: true` cloud (AssemblyAI) → call it from the tab, key from config;
- everything else (local whisper/sherpa/parakeet; Rime, whose WebSocket
  upgrade needs an `Authorization` header browsers cannot set) → one
  `stt-run`/`tts-run` op carrying `{ provider, audio | text, … }`; a cloud
  provider's key rides that request and is not stored server-side.

Consumers: the tab's `transcribeBlob`, the `stt-run` op (the only local-provider
path), and Telegram (`src/bot.ts`). There is no product HTTP STT surface: every
exchange rides the authenticated, chunk-framed RTC channel. TTS mirrors this
with `tts-run` (KittenTTS on the desktop).

### Passthrough mode (the CORS escape hatch)

Cloud adapters call the provider directly from the tab when the provider's
CORS allows it. When it doesn't, the request rides the existing RTC peer
channel — a `relay-run` control op, the same shape as `stt-run`, chunked by
the same transport:

- The tab sends `{ op: "relay-run", id, url, method, headers, bodyB64 }` on
  the already-open, authenticated data channel; the desktop fetches and
  replies `{ op: "relay-result", id, status, bodyB64 }`. Desktop tab and
  paired phone are symmetric — both already hold a peer link.
- The desktop validates `url` against the hosts of the registry's declared
  `endpoint`s — the same registry the UI renders from, so a new provider's
  hosts are allowlisted in the same file that adds the adapter. No open
  proxy, no SSRF into the LAN, no new HTTP route.
- The API key is attached by the tab on each request. Node keeps no state: no
  key storage, no `Authorization` logging.
- Payload sizes follow the same cap as `stt-run`; batch first — streamed
  relays arrive with Phase 5.
- A tab with no peer link (standalone browser-only mode) has no escape hatch:
  CORS-blocking providers simply can't be used there.

---

## Work breakdown

### Done

| # | Piece | Landed |
|---|---|---|
| 0 | CORS spike — STT Sync and TTS-1 both callable from a browser origin | 2026-11-05 |
| 1 | One Node dispatcher; `stt-run` routed through it; storage-server STT handler and loopback `/stt` deleted; `BOB_STT` dropped | 2026-11-05 |
| 2 | AssemblyAI STT in the tab (404 → "key rejected", body-less auth probe) | 2026-11-05 |
| 3 | `bob:services` config + Settings → Speech card (provider / language / key / Test) | 2026-11-05 |
| 4 | Tests (`test:stt-dispatch`, `test:stt-cloud`) + `docs/services.md` | 2026-11-05 |
| 4a | TTS: local KittenTTS server + Rime Mist v3 (desktop-routed), `tts-run`, 🔊 | 2026-11-05/06 |
| 4b | TTS polish: chunking + WAV joining, 48 MB cache, auto-speak, 🔊/⏹ toggle, voice datalist | 2026-11-06 |
| 8 | Debug-bridge Origin allowlist + `test:storage-cors` | 2026-11-06 |

### Remaining

None in this plan. Streaming, the optional relay op, the optional voice-catalog
picker, and the manual verification checklist live in
[`../cleanup/service-adapters-leftovers.md`](../cleanup/service-adapters-leftovers.md).

### Totals

- Every item planned here shipped (2026-11-05/06).
- One new plan starts where this one stops: streaming.

One developer familiar with the repo. Ranges were focused working days, not
calendar days.

---

## AssemblyAI notes

One key covers both directions.

- **STT Sync API** — `POST https://sync.assemblyai.com/v1/transcribe`,
  multipart `audio`, headers `Authorization` and
  `X-AAI-Model: universal-3-5-pro`. Accepts WebM/Ogg/WAV/MP3 directly, so the
  browser’s WebM/Opus and Telegram’s Ogg/Opus need no conversion. Returns
  `{ text, words, confidence, audio_duration_ms, session_id }`.
- **TTS-1** — `POST https://tts.us.assemblyai.com/v1/speech` with
  `{ text, voice_id, container: "wav" }`, or a WebSocket for streaming.
  4,000+ voices, six languages, ~90 ms time-to-first-audio.
- Browser-direct use is confirmed for STT (see the spike result at the top —
  preflight and responses both carry `access-control-allow-origin: *`); their
  TTS docs still recommend temporary tokens for browser streaming, so TTS
  streaming (Phase 5) needs that check before it ships.

---

## Risks / traps

1. **Do not add AssemblyAI to both STT files.** Unify first, then add providers
   once.
2. **Host decided per provider** (2026-11-05/06): the tab when the vendor
   allows browser calls (AssemblyAI), the desktop otherwise (Rime). Accepted
   tradeoffs: Telegram stays on the separate `.env` path (local providers
   only), keys live in the tab's storage rather than a 0600 file, and a CORS
   check is a hard gate for every browser-hosted provider.
3. **Settings writes browser storage, not Node `.env`.** That is now the
   intended model: the tab's `bob:services` choice drives browser voice input,
   while Node's `.env` configures only its own local backend (Telegram). A
   dropdown cannot change the Node process — and no longer needs to.
4. **Mobile autoplay.** Auto-speak needs a user gesture on most mobile
   browsers; design the toggle and first-play interaction accordingly.
5. **Long replies.** Chunk TTS by sentence, cache by text+voice hash, and make
   Stop immediate.
6. **Don’t over-generalize.** STT, TTS, search and embeddings have different
   shapes. A small registry plus per-kind interfaces is enough; a universal
   adapter or a workspace plugin loader adds sandbox/security work for little
   gain.
7. **Streaming is optional.** The UI no longer shows partials
   (`onPartial` never fires), so batch transcription is sufficient for voice
   notes. Treat streaming as a later enhancement.
8. **Resolved 2026-11-06 — the debug bridge no longer sends `*` CORS.** It
   allows only loopback Origins and refuses a foreign Origin with `403` before
   any route runs; requests without an Origin (curl/CLI/tests) still work. See
   `test:storage-cors`.

---

## Resolved decisions (2026-11-05/06)

- **No legacy STT paths.** The whisper-only handler in
  `web/scripts/storage-server.mjs` is deleted outright, not kept for the
  standalone debug CLI. There is exactly one STT implementation (the shared
  dispatcher) and one product STT path (the peer `stt-run` op) — no HTTP STT
  route exists.
- **`BOB_STT=1` is dropped.** The gate guards nothing today: Telegram voice
  notes already transcribe ungated, the peer `stt-run` op rides the
  authenticated paired channel (which can already run binaries via `ops`), and
  the loopback bridge binds 127.0.0.1. New behaviour: if the active provider is
  reachable, serve the request; if not, fail with a structured error naming
  the provider and the fix — e.g. `stt provider "whisper" unreachable at
  http://127.0.0.1:8178 — start it or switch providers in Settings`. The one
  real hole the flag accidentally limited — the bridge sends
  `access-control-allow-origin: *`, so any website could drive-by the local
  whisper — disappears outright once the HTTP STT route is deleted (see the
  RTC-only bullet below); the debug bridge's `*` CORS on `/fs`/`/git`/`/sql`
  remains a separate hygiene item, not this plan's scope. The Settings card's
  **Test** button (`adapter.check`) is the manual equivalent.
- **Cloud adapters run in the tab when the vendor allows it; otherwise on the
  desktop.** AssemblyAI is called directly from the tab with the browser-held
  key (CORS verified). Rime's WebSocket upgrade requires an `Authorization`
  header a browser cannot set, so its key travels with each `stt-run` request
  over the authenticated channel and Node never persists it. Tradeoffs
  accepted: Telegram voice notes stay on the local `.env` STT path, each
  browser keeps its own keys (desktop tab and paired phone enter them
  separately), and any future browser-hosted provider needs the CORS check.
- **Services config is global and browser-side** — one config per browser
  origin, stored where standalone Settings already writes, shared across all
  profiles. No per-profile services config; nothing synced through the
  workspace, so keys never enter the relay/seed publish paths.
- **STT first, then TTS.** Both shipped, in that order, as planned.
- **Batch at launch; streaming eventually.** Phase 5 is deferred, not
  dropped.
- **Cloud keys stay in the browser; when CORS blocks a provider, the request
  relays over the existing RTC peer channel — not HTTP.** Adapters run in the
  tab and call the provider directly when its CORS allows (AssemblyAI's does —
  see the spike). When it doesn't, the tab sends the request as a `relay-run`
  control op on the already-open, authenticated data channel, and the desktop
  forwards it verbatim. The key is attached by the tab on each request; Node
  never stores, persists, or logs it, and only registry-declared hosts are
  reachable — no open proxy, no new HTTP surface at all. Rime is the worked
  example of a per-request key over the peer channel; `relay-run` remains the
  plan for providers that only fail on CORS.

## Next step

Nothing in this plan. Pick up the open items in
[`../cleanup/service-adapters-leftovers.md`](../cleanup/service-adapters-leftovers.md).

---

## Progress log

- **2026-11-05** — plan created from the architecture/estimate discussion.
  No code changes yet.
- **2026-11-05** — review folded in two decisions: (1) no legacy anything —
  the storage-server STT handler is deleted, not preserved for the debug CLI;
  (2) `BOB_STT=1` is dropped in favour of reachable-provider-serves plus
  structured errors, with an Origin allowlist replacing the bridge's `*` CORS
  where it mattered.
- **2026-11-05** — all four open decisions resolved: cloud adapters run in
  the browser tab; services config is global and browser-side (per origin,
  shared across profiles); STT ships first, TTS after; batch at launch with
  streaming deferred (kept as Phase 5, wanted eventually). Config, dispatcher,
  spike, and risk sections updated to match. No decisions remain open.
- **2026-11-05** — spike run: AssemblyAI STT Sync and TTS-1 both answer
  browser origins (`access-control-allow-origin: *`, `Authorization` and
  `X-AAI-Model` allowed). Browser-hosted cloud adapters confirmed viable;
  auth failures return 404, so error mapping must treat 404 as "key
  rejected". Real-key round-trip still untested (no key on this machine).
- **2026-11-05** — passthrough mode added: keys stay in the browser even
  when CORS forces a hop through the desktop — the channel server relays
  registry-allowlisted requests verbatim, with the key attached per request
  and never stored or logged (Phase 1b).
- **2026-11-05** — passthrough reworked to RTC-only at review: the relay is a
  `relay-run` control op on the existing authenticated peer data channel
  (no new HTTP surface), and Phase 1 deletes the loopback HTTP `/stt`
  fallback, making the peer `stt-run` op the only local-provider path. The
  debug bridge's `*` CORS is flagged as separate hygiene (risk 8).
- **2026-11-05** — simplification pass: the adapter contract shrinks to
  `{ id, label, endpoint, transcribe, check? }` (dropped `capabilities`,
  `runsIn`, `requiresFfmpeg`, `formats`, `fallback`); local backends are
  wrapped in place instead of moved into per-provider files; the config is a
  localStorage getter/setter rather than a service (Phase 3 drops from 3–5
  days to 1–2); the relay op moves to "Later" (AssemblyAI needs no escape
  hatch); TTS splits into 1-day MVP vs polish; the stale `services.json` /
  `${ENV}` / hot-reload / `/api/services` items and the legacy env mapping are
  deleted. "Now" total is ~4–7 focused days.
- **2026-11-05** — Phase 1 landed: `web/src/services/{types,registry}.ts`
  define the small adapter contract and provider metadata; `src/stt.ts` wraps
  the local backends as registry entries and exposes `createSttDispatcher` /
  `transcribeWithProvider` with provider-named errors; the peer `stt-run` op
  accepts an optional `provider` (defaults to `STT_BACKEND`) and no longer
  checks `BOB_STT`; the storage-server STT handler and the tab's loopback
  `/stt` fallback are deleted; dead streaming code (`transcribeWavStreaming`,
  `wavSlice`, `checkWhisper` alias) removed. `npm run test:stt-dispatch` covers
  routing and the error contract. Typecheck, the standalone boundary test,
  Telegram audio routing, and the UI build all pass.
- **2026-11-05** — Phase 2–4 landed: `web/src/services/stt/assemblyai.ts`
  (Sync API, 404→key-rejected, body-less auth probe), `config.ts`
  (`bob:services`), the Settings → Speech card, and the chat-UI routing
  (cloud in-tab, local via `stt-run` with the chosen provider). Tests
  `test:stt-cloud` + `test:stt-dispatch` pass; `docs/services.md` written;
  root README, `web/README.md`, `.env.example`, and `docs/pairing-and-sync.md`
  no longer mention `/stt` or `BOB_STT`. Remaining for the Now track: a
  real-key transcription round-trip (needs an AssemblyAI key).
- **2026-11-05** — roadmap brought current: status header, "What exists now",
  totals, and next steps rewritten to match the shipped code; stale planning
  language (`proposed architecture`, `services.json`, the pre-unification
  state) removed. One open verification item: the real-key AssemblyAI
  round-trip. The Later track is unchanged.
- **2026-11-05** — TTS MVP + Rime STT landed: KittenTTS served locally
  (`scripts/kitten-tts-server.py`, `npm run tts:up`), `src/tts.ts` dispatcher +
  `tts-run` op + 🔊 button on replies; Rime STT over `ws`
  (`src/stt-rime.ts`) with the key sent per request, because its upgrade needs
  an `Authorization` header a browser cannot set; per-provider keys moved to
  `stt.keys`. `test:tts` added. Typecheck, web/ui builds, and the STT/TTS tests
  pass; real-key and live-model verification still pending.
- **2026-11-06** — re-audited against the shipped code: config example, adapter
  contract, dispatcher routing and risk 2 corrected (per-provider host: tab
  only when the vendor allows browser calls), and a manual verification
  checklist added. **Rime Mist v3 TTS** added: `mist.api.rime.ai` returns no
  CORS headers (preflight 404), so it runs on the desktop like Rime STT, with
  per-provider TTS keys; 1,000-char requests and a clear error above that.
  `test:tts` covers both TTS adapters.
- **2026-11-06** — leftovers closed: TTS polish (sentence chunking + WAV join,
  48 MB cache, auto-speak, 🔊/⏹ toggle, KittenTTS voice datalist), debug-bridge
  Origin allowlist with `test:storage-cors`, and `BOB_STT=1` removed from
  `.env`. `npm run verify:speech` added (whisper is up here; `kittenml` and
  cloud keys are not). Typecheck, builds, and all tests pass.
- **2026-11-06** — work breakdown restructured: completed items collapsed into
  a single Done table with landing dates, leaving a three-row Remaining table
  (streaming, the optional relay op, the optional voice-catalog picker). Status
  and totals now say what is actually left.
- **2026-11-06** — plan complete and archived under `roadmap/complete/`. The
  pending checklist and the three follow-ups moved to
  `roadmap/cleanup/service-adapters-leftovers.md`.
