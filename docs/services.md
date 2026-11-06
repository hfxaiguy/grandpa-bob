# Speech services (STT + TTS)

The mic button and the reply speaker use providers chosen in
**Settings → Speech**. Choices are global per browser and apply immediately.

## STT providers

| id | Where it runs | Notes |
|---|---|---|
| `""` (Desktop default) | paired desktop | the channel's `STT_BACKEND` (.env): whisper, sherpa, or parakeet |
| `whisper` / `sherpa` / `parakeet` | paired desktop | explicit local backend; needs ffmpeg + the local server |
| `assemblyai` | **this browser tab** | CORS-verified direct call to `sync.assemblyai.com` |
| `rime` | **paired desktop** | key rides the peer channel per request; see below |

Local providers ride the authenticated peer channel as a `stt-run` control op
(`{ provider, audio, ext }` → `{ text }`). There is no HTTP STT route and no
`BOB_STT` flag.

**Rime** uses `wss://stt.api.rime.ai/ws`. Rime documents this endpoint for
backends only: the key must be in the `Authorization` header of the upgrade,
and a browser `WebSocket` cannot set headers (and the URL accepts no query
parameters). So the tab sends the key with the `stt-run` request; the desktop
opens the socket, streams 16 kHz mono PCM16 in 100 ms chunks, and returns
`done.text`. Limits: one utterance, 16 MiB audio, 120 s wall clock, `en`/`es`.

## TTS providers

| id | Where it runs | Notes |
|---|---|---|
| `""` (Desktop default) | paired desktop | `TTS_PROVIDER` (.env); `kitten` or `rime` |
| `kitten` | **paired desktop** | local KittenTTS HTTP server (`npm run tts:up`) |
| `rime` | **paired desktop** | Rime Mist v3; `mist.api.rime.ai` sends no CORS headers, so it cannot run in the tab |

`kitten` is served by `scripts/kitten-tts-server.py`: an OpenAI-compatible
`POST /v1/audio/speech` around the `kittenml` Python package. The default model
is the CPU-friendly `KittenML/kitten-tts-nano-0.8-int8`; swap it with
`KITTEN_TTS_MODEL`. The desktop returns base64 WAV over a `tts-run` control op
and the tab plays it.

`rime` posts to `https://mist.api.rime.ai/` with `Accept: audio/wav` and a
bearer key, returning WAV. Its limits: **1,000 characters per request**, one
voice from Rime's catalog (`speaker`), and languages that depend on the voice
(`lang`). Longer replies are split at sentence boundaries (then words) and the
resulting WAVs are joined into one clip. The key is stored in the browser and
attached per `tts-run` request; Node never persists it.

Synthesis is cached in memory per provider+voice+language+text (48 MB FIFO), so
replaying the same reply costs nothing. The 🔊 button toggles: pressing it again
stops the clip. **Auto-speak** (Settings → Speech) reads each new trunk reply
aloud; browsers that block autoplay will simply ignore it until a manual press.

KittenTTS code is Apache-2.0; the model weights are licensed separately — check
the model card before shipping. `pip install kittenml` also pulls PyTorch even
when you use the ONNX models.

## Config

Stored in `localStorage` under `bob:services`, shared by the chat UI and the
Settings page on the same origin:

```json
{
  "stt": {
    "provider": "rime",
    "language": "en",
    "keys": { "rime": "…", "assemblyai": "…" }
  },
  "tts": { "provider": "rime", "voice": "cove", "keys": { "rime": "…" } }
}
```

- Keys are per provider and stay in the browser. They never enter the
  workspace, relay, or seed publication.
- Rime keys transit per request (`stt-run` / `tts-run`) because both Rime
  services refuse browser clients; Node never stores or logs them.
- Unknown provider ids fall back to "Desktop default".
- Blank key on save keeps the previously saved key for that provider.
- `web/src/services/config.ts` owns load/save/validation; the Settings card
  writes the same key directly.

## Errors

- Missing key → `no AssemblyAI key` / `no Rime key — add it in Settings → Speech`.
- AssemblyAI rejected key → `AssemblyAI rejected the key — …` (auth failures are
  **404 `{"detail":"Invalid API key"}`**, not 401/403).
- Rime rejected key → `Rime STT key rejected` (401 on the WS upgrade);
  `Rime rejected the key` for TTS (401/403).
- Rime TTS long replies are chunked at 1,000 characters — no user-facing error.
- Rime language outside `en`/`es` → explicit error before connecting.
- Unknown provider → `unknown stt provider "x" — available: …`.
- Any adapter failure → `stt provider "x" failed: …` / `tts provider "x" failed: …`.
- Unpaired tab + non-browser provider → "pair a desktop …".

## Settings → Speech

- STT provider, language, cloud key (stored per provider), Save, Test.
- TTS provider, voice (KittenTTS voices are suggested in a datalist), cloud TTS
  key, and **Speak new replies automatically** — saved with the same button.
- **Test** probes AssemblyAI with a body-less POST: `404` = key rejected,
  `400`/`422`/2xx = key accepted. Rime keys are verified by the desktop on
  first use; local providers are tested by recording.

## Code map

- `web/src/services/types.ts` — `AudioClip`, `Transcript`, `SttAdapter`, `TtsAdapter`
- `web/src/services/registry.ts` — provider ids/labels, cloud + browser flags
- `web/src/services/config.ts` — `bob:services` load/save
- `web/src/services/stt/assemblyai.ts` — in-tab cloud adapter + auth probe
- `src/stt.ts` — local backends + Rime wrapped as registry entries;
  `createSttDispatcher` / `transcribeWithProvider`
- `src/stt-rime.ts` — the Rime streaming WebSocket client (`ws`)
- `src/tts.ts` — KittenTTS + Rime Mist v3 adapters, dispatcher,
  `synthesizeWithProvider`
- `src/bridge/peer.ts` — `stt-run` / `tts-run` ops
- `ui/src/store.ts` — `transcribeBlob` routing + `speakText`
- `web/src/ui/pages.ts` — the Settings → Speech card
- `scripts/kitten-tts-server.py` — the local TTS service (`npm run tts:up`)

## Tests

- `npm run test:stt-dispatch` — routing, unknown provider, adapter failure
- `npm run test:stt-cloud` — config contract, AssemblyAI success/error mapping,
  auth probe, per-provider keys
- `npm run test:tts` — TTS config, both adapters' request shapes, chunking and
  WAV joining, cache dedupe, voice override, error naming, empty-audio guard
- `npm run test:storage-cors` — loopback-only Origin allowlist, foreign-origin
  refusal, no-Origin CLI access
- `npm run verify:speech` — machine check: local STT/TTS reachability, the
  `kittenml` install, and (when exported) `ASSEMBLYAI_API_KEY` / `RIME_API_KEY`
