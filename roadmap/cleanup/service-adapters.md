# Pluggable service adapters (STT / TTS / others)

**Status:** in progress — planning
**Owner:** unassigned
**Created:** 2026-11-05
**Scope:** make speech and other external services pluggable, starting with
AssemblyAI as a selectable STT (and later TTS) provider in the UI.

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

## What exists today

- `src/stt.ts` — whisper, sherpa, parakeet. Used by Telegram voice notes and
  the paired-desktop path.
- `web/scripts/storage-server.mjs` — a **second, whisper-only** `/stt`
  handler. This is what the browser tab actually calls. It ignores
  `STT_BACKEND`, so sherpa/parakeet never work from the UI.
- No TTS anywhere in the repo.
- Config is split:
  - Node reads `.env` once at boot (`src/config.ts`).
  - The settings page in standalone mode writes browser `localStorage`
    (`web/src/server/local-backend.ts` `/api/env`), not the Node `.env`.
  - Therefore a UI provider dropdown cannot currently change what the Node
    process uses.
- No STT/TTS tests; `scripts/telegram-audio-test.ts` only tests message
  routing.

The hidden cost is not the adapter code — it is unifying the two STT paths and
giving the browser UI a way to configure a Node-side service without a restart.

---

## Proposed architecture

Reuse the existing `models.json` pattern: JSON registry, `${ENV}`
interpolation, generated settings card, **Test** button.

```
web/src/services/
  types.ts          ServiceKind, SttAdapter, TtsAdapter, AudioClip
  registry.ts       built-in adapters + UI metadata
  config.ts         parse/validate services.json
  stt/
    whisper.ts
    sherpa.ts
    parakeet.ts
    assemblyai.ts
  tts/
    speech-synthesis.ts
    assemblyai.ts
```

Shared code lives under `web/src` (the existing shared-core boundary); the Node
side imports it the same way `web/src/sync` is already pulled into the bridge
build. `web/` still must not import `src/`.

### Adapter interfaces

```ts
interface SttAdapter {
  id: string;
  label: string;
  capabilities: {
    streaming: boolean;
    formats: string[];        // webm, ogg, wav, mp3…
    requiresFfmpeg?: boolean;
    runsIn: ("browser" | "node")[];
  };
  transcribe(clip: AudioClip, opts: SttConfig): Promise<Transcript>;
  check(opts: SttConfig): Promise<boolean>;
}

interface TtsAdapter {
  id: string;
  label: string;
  capabilities: {
    streaming: boolean;
    formats: string[];
    voices?: Voice[];
    runsIn: ("browser" | "node")[];
  };
  synthesize(text: string, opts: TtsConfig): Promise<AudioClip>;
  check(opts: TtsConfig): Promise<boolean>;
}
```

`AudioClip` carries raw bytes plus mime/ext/duration. Adapters that need a
specific container declare it and use a host-provided `toWav16k` helper;
cloud adapters that accept WebM/Ogg skip ffmpeg.

### Config

`~/.bobkat/services.json` (0600), with secrets referenced from `.env`:

```json
{
  "stt": {
    "provider": "assemblyai",
    "apiKey": "${ASSEMBLYAI_API_KEY}",
    "language": "en",
    "fallback": "whisper"
  },
  "tts": {
    "provider": "assemblyai",
    "apiKey": "${ASSEMBLYAI_API_KEY}",
    "voiceId": "…"
  }
}
```

- Read with an mtime cache so a save applies without a restart.
- Browser-only mode falls back to `localStorage` when no channel is reachable.
- Remote tabs read/write through a peer control op; local tabs use a
  loopback channel endpoint.

### One dispatcher

The same service is used by:

- the browser tab (`ui/src/store.ts` `transcribeBlob`);
- the channel `/stt` route (move the product handler from
  `web/scripts/storage-server.mjs` into `src/`, so it can share the adapters);
- the peer `stt-run` op;
- Telegram voice notes (`src/bot.ts`).

TTS mirrors this with `/tts` and a `tts-run` peer op.

---

## Work breakdown

| # | Piece | Estimate |
|---|---|---|
| 0 | **Spike** — verify AssemblyAI STT CORS from the browser; decide whether cloud adapters run in the tab or on the Node channel | 0.5 day |
| 1 | **Unify STT behind one dispatcher** — move whisper/sherpa/parakeet into adapters, route `/stt` through the shared code, preserve streaming, add a fake-adapter test | 2–4 days |
| 2 | **AssemblyAI STT adapter** — Sync API: one `POST https://sync.assemblyai.com/v1/transcribe`, multipart `audio`, `Authorization` + `X-AAI-Model`, accepts WebM/Ogg/WAV/MP3 up to 20 min / 256 MB; no ffmpeg on the cloud path | 1–2 days |
| 3 | **Service config + UI** — `services.json`, `${ENV}`, hot reload, `GET/PUT /api/services`, peer op for remote tabs, Settings “Services” card with provider/key/language/Test | 3–5 days |
| 4 | **TTS adapter + playback** — AssemblyAI TTS-1 HTTP (`POST https://tts.us.assemblyai.com/v1/speech`), browser SpeechSynthesis fallback, `/tts` route or peer op, play button, auto-speak toggle, voice picker, sentence chunking, cache | 4–6 days |
| 5 | **Streaming (optional)** — WebSocket partials for STT/TTS, barge-in, stop/interrupt | +5–7 days |
| 6 | **Tests, docs, migration, generalization** — contract tests, `docs/services.md`, `.env.example`, README, legacy env mapping | 2–3 days |

### Totals

- Minimal AssemblyAI in the UI, browser-only, no architecture: **1–2 days**
- Proper pluggable STT across all paths: **~1.5–2 weeks**
- STT + TTS, batch only: **~3–4 weeks**
- Full vision incl. streaming and a general service framework: **~4–5 weeks**

One developer familiar with the repo. Ranges are focused working days, not
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
- Browser-direct use is possible; their TTS docs recommend temporary tokens
  for browser streaming. The Sync STT CORS behaviour must be verified in the
  spike before committing to the browser-hosted route.

---

## Risks / traps

1. **Do not add AssemblyAI to both STT files.** Unify first, then add providers
   once.
2. **Decide the host early.** Node-side keeps keys in `~/.bobkat` (0600), avoids
   CORS, and covers Telegram with one config. Browser-side avoids the config
   round-trip but leaves Telegram on a separate `.env` path.
3. **Settings page writes localStorage, not Node `.env`.** Any Node-side
   provider needs the `services.json` endpoint/peer op; a dropdown alone will
   look like it works and change nothing.
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

---

## Decisions to make

- [ ] Cloud adapters run on the **Node channel** (recommended) or in the
      **browser tab**?
- [ ] Config lives in global `~/.bobkat/services.json`, per-profile, or in the
      synced workspace?
- [ ] Is TTS in scope now, or STT first?
- [ ] Is live/streaming transcription required, or is batch enough?

---

## Next step

1. Write the spike result (CORS + host decision) at the top of this file.
2. Do Phase 1 as a no-behavior-change refactor.
3. Add AssemblyAI STT + `services.json` + Settings card.
4. Add TTS batch + playback.

---

## Progress log

- **2026-11-05** — plan created from the architecture/estimate discussion.
  No code changes yet.
