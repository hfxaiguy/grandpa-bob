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

`npm run tts:up` starts it with an interpreter that can import `kittenml`:
`KITTEN_PYTHON` if set, else `python3` when it already works, else a venv at
`~/.bobkat/tts-venv` (created by `npm run tts:up -- --install` with `uv`,
pinned to Python 3.12 — newer Pythons often have no onnxruntime wheels).
kittenml pulls PyTorch, so that install is a multi-GB download. The first
synthesis downloads the model.

`rime` posts to `https://mist.api.rime.ai/` with `Accept: audio/wav` and a
bearer key, returning WAV. Its limits: **1,000 characters per request**, one
voice from Rime's catalog (`speaker`), and languages that depend on the voice
(`lang`). Longer replies are split at sentence boundaries (then words) and the
resulting WAVs are joined into one clip. The key is stored in the browser and
attached per `tts-run` request; Node never persists it.

Synthesis is cached in memory per provider+voice+language+text (48 MB FIFO), so
replaying the same reply costs nothing. The 🔊 button shows **…** while the
clip is synthesized (pressing again cancels), **⏹** while it plays, and pressing
it again stops. **Auto-speak** (Settings → Speech) has three scopes: **Off**,
**Trunk only**, or **All apps** — the last reads the emits of every app, not
just the conversation trunk; machine-level emits are always skipped. Browsers
that block autoplay will simply ignore it until a manual press.
The same card has a global **Enable text-to-speech** switch: off hides the 🔊
buttons entirely and doubles as the per-browser mute.

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
- KittenTTS not running → `cannot reach the KittenTTS server at http://127.0.0.1:8185 … — start it with npm run tts:up`, or pick Rime Mist v3.
- `the browser blocked playback` → the click no longer owns the user gesture;
  focus the tab and press 🔊 again.
- `the desktop link is offline` → pairing is stored but the live WebRTC link is
  not up (channel restarted, another tab holds the host lease, or a relay
  session ended). Voice calls `__bobConnect` once to resume it; if that fails,
  reconnect in Sync… → Pair…, reload the tab, or take over in the other tab.

## Settings → Speech

- STT provider, language, cloud key (stored per provider), Save, Test.
- **Enable text-to-speech** — the global switch: off hides every 🔊 button and
  stops auto-speak; on is the default.
- TTS provider, voice (KittenTTS voices are suggested in a datalist), cloud TTS
  key, and **Speak new replies automatically** — a radio group: Off, Trunk only,
  All apps. Saved with the same button.
- The chosen provider and voice travel with every `tts-run`, so switching takes
  effect on the next 🔊 press (the desktop's `.env` is only the default).
- The 🔊 button shows **…** while the clip is synthesized (press again to
  cancel), then **⏹** while it plays; errors surface as a toast.
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
- `scripts/kitten-tts-server.py` — the local TTS service; `scripts/tts-up.mjs`
  picks an interpreter with `kittenml` (venv at `~/.bobkat/tts-venv` via `uv`)

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
