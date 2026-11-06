# Speech services — leftovers

**Status:** open
**Created:** 2026-11-06
**Updated:** 2026-11-06
**Context:** the completed plan is
[`../complete/service-adapters.md`](../complete/service-adapters.md) — STT
(whisper/sherpa/parakeet, AssemblyAI in-tab, Rime via the desktop) and TTS
(KittenTTS local, Rime Mist v3 via the desktop) are shipped and tested.

This file holds only what is *not* done: the manual verification pass and the
three follow-ups that were deliberately left out.

---

## 1. Manual verification (pending)

`npm run verify:speech` covers the machine-level parts: local server
reachability, the `kittenml` install, and — when exported — the AssemblyAI and
Rime keys. The rest needs a real key or a running model:

- [ ] **AssemblyAI STT** — Settings → Speech: paste a key, Test → "key
      accepted"; record a voice note and check the transcript. A bad key must
      say "key rejected" (the service returns **404**, not 401).
- [ ] **Rime STT** — save its key, record, and confirm the desktop transcribes
      over `wss://stt.api.rime.ai/ws`; try an `es` request.
- [ ] **Rime Mist v3 TTS** — key + voice (e.g. `cove`), press 🔊; confirm WAV
      playback and that a long reply is chunked into one joined clip.
- [ ] **KittenTTS** — `npm run tts:up -- --install` (provisions
      `~/.bobkat/tts-venv` when `kittenml` is missing), then `npm run tts:up`;
      `/health` reports `loaded:false` until the first request; press 🔊 and
      confirm playback. The button shows … while it synthesizes and ⏹ while it
      plays.
- [ ] **Keys round-trip** — save an AssemblyAI key, switch to Rime, save a
      second key, switch back: both must still be present (`stt.keys` /
      `tts.keys`).
- [ ] **Auto-speak + mobile** — enable auto-speak on the desktop; on a phone,
      confirm the first play needs a press (autoplay policy) and ⏹ stops it.

Expected on a machine with whisper running but nothing else configured:
`verify:speech` reports Whisper ✓ and the rest as skips (not failures).

---

## 2. Streaming (the substantive item)

**Why it was deferred:** the UI no longer renders partials (`onPartial` never
fires), so batch transcription is enough for voice notes, and batch TTS is
enough for one clip per reply. Streaming is a latency feature, not a
correctness one.

**Scope**

| Piece | Notes |
|---|---|
| STT partials | `stt-run` is one request/response. A streaming variant would forward interim hypotheses to the tab as they arrive. Rime already streams internally (revised hypotheses); AssemblyAI's Sync API does not — that would need their streaming API and a WebSocket from the tab (CORS/auth check first) or the relay path. |
| TTS streaming | `tts-run` returns one WAV. Streaming would yield sentence chunks as they finish: KittenTTS `generate_stream`, Rime's `stream: true` / `stream_format: sse`. |
| Barge-in | Stop playback and cancel the in-flight synthesis when the user speaks or sends a message. |
| Stop | The ⏹ button currently stops local playback only; it does not cancel the desktop request. |

**Estimate:** ~5–7 focused days.

**Acceptance**
- Long replies start playing after the first sentence chunk, not the whole clip.
- A new turn or a press of ⏹ cancels both playback and the pending synthesis.
- A dropped connection mid-stream leaves no stuck "speaking" state.
- Batch behavior is unchanged when streaming is unavailable (provider or
  browser).

---

## 3. Relay op (conditional — build only if needed)

**Status:** designed, not built. Rime proved the alternative: when a vendor
blocks browser calls, run the adapter on the desktop and let the key ride the
per-request `stt-run`/`tts-run` message. Build `relay-run` only for a provider
that is *browser-hosted by design* but fails CORS and cannot get a Node adapter.

**Shape (already decided):** `{ op: "relay-run", id, url, method, headers,
bodyB64 }` → `{ op: "relay-result", id, status, bodyB64 }` on the existing RTC
channel; allowlist = hosts of the registry's declared `endpoint`s; key attached
per request; never stored or logged. No new HTTP surface.

**Estimate:** 0.5–1 day.

---

## 4. Relay channel renewal — done (service + client, 2026-11-06)

BobSwap published renewal. Live verification against
`https://bobswap.hfxaiguy.com` on 2026-11-06:

```
create                   201  expires_at returned
join                     200  expires_at = now + 1800s (default)
renew (offerer)          200  new expires_at
renew (joiner, ttl=7200) 200  expires_at = now + 7200s (TTL honored)
renew (foreign token)    403  invalid role token
```

Contract (from the updated `/docs/agents`): either paired role may renew while
the channel is unexpired, no peer action and no code; `expires_at` is set to
`now + ttl_seconds` (default 1800); **no absolute cap** — repeated renewals keep
the pairing alive; the operator maximum TTL is 86400 s by default (adjustable
60–604800 s); revoke with `DELETE`; renewal before pairing is `409`; expired or
deleted is `410`/`404`.

**Client — done:**
- `RelayTransport` renews every 10 minutes while the channel exists and stores
  the new `expires_at`.
- `404`/`410` marks renewal unsupported and falls back to the fixed lifetime.
- The browser no longer refuses to resume on a stale stored expiry.
- `npm run test:relay-renew` covers parsing, the role token, and the fallback.

**Only remaining check:** pair a phone over relay, leave it closed for more than
30 minutes while the desktop keeps running, then reopen the tab — it should
resume without a new code. (The desktop's renewal is what keeps the channel
alive; if the desktop process is down, no signaling is possible either way.)

---

## 5. Voice catalog picker (optional)

The Settings card uses a datalist with KittenTTS's eight voices; Rime voices
must be typed. Populate both from their catalogs instead:
- KittenTTS: `GET <KITTEN_TTS_URL>/v1/voices`
- Rime: the voice list from `docs.rime.ai/docs/voices` (or its metadata
  endpoint, if CORS/auth allows)

Needs a browser-reachable fetch or a small peer op (the local TTS server has no
CORS). **Estimate:** ~0.5 day.

---

## Known limitations (context, not work)

- **Mobile autoplay**: auto-speak is silently skipped until a user gesture; the
  manual 🔊 always works.
- **Cache scope**: the 48 MB TTS cache is per Node process and not persisted.
- **Rime TTS**: 1,000 chars/request is handled by chunking; 78 voices, four
  languages, $0.03/min on Flex (free tier: $50/mo credit).
- **Relay lifetime**: renewed every 10 minutes while the desktop runs (live
  since 2026-11-06), up to the operator maximum TTL (default 24 h); without the
  renew route, BobSwap's fixed 30-minute lifetime applies (see § 4).
- **KittenTTS**: code Apache-2.0, **weights licensed separately** — check the
  model card before shipping; `pip install kittenml` also pulls PyTorch.
- **No CI**: tests are npm scripts (`test:stt-dispatch`, `test:stt-cloud`,
  `test:tts`, `test:storage-cors`, `verify:speech`); there is no workflow file.
- **Keys**: stored in browser `localStorage` (per browser); Rime keys transit
  the authenticated peer channel per request. See the completed plan's
  decisions for the accepted tradeoffs.
