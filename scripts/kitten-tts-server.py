#!/usr/bin/env python3
"""Minimal OpenAI-compatible TTS server for KittenTTS (CPU).

    pip install kittenml
    npm run tts:up            # http://127.0.0.1:8185

Routes:
    GET  /health           -> {"ok": true, "model": ..., "loaded": bool}
    GET  /v1/voices        -> {"voices": ["Bella", ...]}
    POST /v1/audio/speech  -> audio/wav
        JSON: {"input": str, "voice"?: str, "model"?: str, "response_format"?: "wav"}

The Node channel calls this exactly like whisper-server serves STT. The server
is loopback-only and unauthenticated: do not expose the port.

Environment:
    KITTEN_TTS_MODEL   default KittenML/kitten-tts-nano-0.8-int8
    KITTEN_TTS_VOICE   default Bella
    KITTEN_TTS_HOST    default 127.0.0.1
    KITTEN_TTS_PORT    default 8185
"""

import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("KITTEN_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("KITTEN_TTS_PORT", "8185"))
MODEL = os.environ.get("KITTEN_TTS_MODEL", "KittenML/kitten-tts-nano-0.8-int8")
DEFAULT_VOICE = os.environ.get("KITTEN_TTS_VOICE", "Bella")
# The eight voices shared by the 0.8 ONNX models.
KNOWN_VOICES = ["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"]

_model = None


def load_model():
    """Load KittenTTS lazily so /health answers without downloading weights."""
    global _model
    if _model is None:
        try:
            from kittenml import KittenTTS  # type: ignore
        except ImportError:  # older package name
            from kittentts import KittenTTS  # type: ignore
        _model = KittenTTS(MODEL)
    return _model


def wav_bytes(samples, sample_rate: int) -> bytes:
    """Encode the model's float samples as 16-bit PCM mono WAV."""
    import numpy as np

    pcm = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm16.tobytes())
    return buf.getvalue()


def voices() -> list[str]:
    if _model is not None:
        available = getattr(_model, "available_voices", None)
        if available:
            return [str(v) for v in available]
    return KNOWN_VOICES


class Handler(BaseHTTPRequestHandler):
    server_version = "kitten-tts-server/0.1"

    def log_message(self, fmt, *args):  # quiet, one line per request
        sys.stderr.write("[kitten-tts] " + (fmt % args) + "\n")

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send_json(200, {"ok": True, "model": MODEL, "loaded": _model is not None})
        elif self.path == "/v1/voices":
            self._send_json(200, {"voices": voices()})
        else:
            self._send_json(404, {"error": f"no route GET {self.path}"})

    def do_POST(self):  # noqa: N802
        if self.path != "/v1/audio/speech":
            self._send_json(404, {"error": f"no route POST {self.path}"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as err:
            self._send_json(400, {"error": f"invalid JSON: {err}"})
            return

        text = str(payload.get("input") or "").strip()
        if not text:
            self._send_json(400, {"error": "missing input"})
            return
        fmt = str(payload.get("response_format") or "wav").lower()
        if fmt != "wav":
            self._send_json(400, {"error": 'response_format must be "wav"'})
            return

        voice = str(payload.get("voice") or DEFAULT_VOICE).strip() or DEFAULT_VOICE
        try:
            model = load_model()
            audio = model.generate(text, voice=voice)
            data = wav_bytes(audio, int(getattr(model, "sample_rate", 24000)))
        except Exception as err:  # noqa: BLE001 - surface any model failure as 500
            self._send_json(500, {"error": str(err)})
            return

        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[kitten-tts] http://{HOST}:{PORT}  model={MODEL}  voice={DEFAULT_VOICE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
