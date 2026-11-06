import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AudioClip,
  SttAdapter,
  SttAdapterContext,
  Transcript,
} from "../web/src/services/types.js";
import { RIME_STT_URL, transcribeRimePcm } from "./stt-rime.js";

const execFileAsync = promisify(execFile);

export type SttBackend = "whisper" | "sherpa" | "parakeet";

export interface SttBackendOptions {
  /** Which STT backend to use. */
  backend: SttBackend;
  /** whisper.cpp server URL (used when backend === "whisper"). */
  whisperUrl: string;
  /** sherpa-onnx websocket server URL (used when backend === "sherpa" or "parakeet"). */
  sherpaUrl: string;
  tmpDir: string;
  /** Optional language override sent per-request ("en", "de", "auto", ...). */
  language?: string;
}

export interface SttOptions extends SttBackendOptions {
  /** Direct https://api.telegram.org/file/bot<token>/<file_path> URL */
  fileUrl: string;
}

/** Download a Telegram voice note, convert to 16kHz mono WAV, transcribe via the configured backend. */
export async function transcribeVoice({ fileUrl, ...opts }: SttOptions): Promise<string> {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`voice download failed: HTTP ${res.status}`);
  return transcribeAudioBytes(Buffer.from(await res.arrayBuffer()), { ext: ".ogg", ...opts });
}

/**
 * Transcribe raw audio bytes (any format ffmpeg understands: .ogg, .webm,
 * .mp4, .wav, ...) with the configured local backend. This remains the
 * Telegram entry point; the peer `stt-run` op goes through
 * `transcribeWithProvider` so it can carry an explicit provider id.
 */
export async function transcribeAudioBytes(
  input: Buffer,
  { ext = ".ogg", ...opts }: SttBackendOptions & { ext?: string },
): Promise<string> {
  return transcribeWithProvider(opts.backend, input, ext, {
    whisperUrl: opts.whisperUrl,
    sherpaUrl: opts.sherpaUrl,
    tmpDir: opts.tmpDir,
    language: opts.language,
  });
}

/** Convert any ffmpeg-readable audio container to 16kHz mono PCM WAV. */
export async function convertToWav(input: Buffer, ext: string, tmpDir: string): Promise<Buffer> {
  const id = randomUUID();
  // Distinct stems: a .wav upload would otherwise collide input==output.
  const inPath = path.join(tmpDir, `${id}-in${ext}`);
  const wavPath = path.join(tmpDir, `${id}-out.wav`);
  try {
    await fs.writeFile(inPath, input);
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", inPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath,
    ]);
    return await fs.readFile(wavPath);
  } finally {
    await fs.rm(inPath, { force: true });
    await fs.rm(wavPath, { force: true });
  }
}

/** One-shot transcription of a 16kHz mono PCM WAV via the configured backend. */
export async function transcribeWav(wav: Buffer, { backend, whisperUrl, sherpaUrl, language }: SttBackendOptions): Promise<string> {
  return backend === "sherpa"
    ? await transcribeWithSherpa(wav, sherpaUrl)
    : backend === "parakeet"
      ? await transcribeWithParakeet(wav, sherpaUrl)
      : await transcribeWithWhisper(wav, whisperUrl, language);
}

/** One whisper-server /inference call. Returns "" on empty transcript (no throw). */
async function whisperInference(wav: Buffer, whisperUrl: string, language?: string, prompt?: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);

  const wr = await fetch(`${whisperUrl}/inference`, { method: "POST", body: form });
  if (!wr.ok) throw new Error(`whisper-server failed: HTTP ${wr.status} — ${(await wr.text()).slice(0, 300)}`);
  const json = (await wr.json()) as { text?: string };
  return (json.text ?? "").trim();
}

async function transcribeWithWhisper(wav: Buffer, whisperUrl: string, language?: string): Promise<string> {
  const text = await whisperInference(wav, whisperUrl, language);
  if (!text) throw new Error("transcription came back empty (silent or unintelligible audio?)");
  return text;
}

async function transcribeWithSherpa(wav: Buffer, sherpaUrl: string, onPartial?: (text: string) => void): Promise<string> {
  // sherpa-onnx-online-websocket-server protocol (see online-websocket-server-impl.cc):
  // (1) connect via WebSocket
  // (2) send binary frames: raw float32 samples (LE), normalized to [-1, 1]
  //     (no header — the sample rate is fixed by the server config)
  // (3) send the text message "Done" to signal end of audio
  // (4) the server replies with text messages: JSON results { text, is_final, is_eof }
  //     and finally the literal text "Done!" when all samples are processed
  //
  // On endpoint detection (pauses between sentences) the server marks the
  // result is_final and RESETS its recognizer, so later partials only contain
  // the new segment. Accumulate is_final segments; partials are per-segment
  // previews and must not overwrite the accumulated transcript.
  //
  // The streaming zipformer en model emits uppercase-only text and the
  // websocket server has no truecaser, so we restore sentence case below.
  const wsUrl = sherpaUrl.replace(/^http/, "ws");
  const samples = wavToFloat32Samples(wav);

  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`sherpa-onnx timed out (no response within 30s): ${wsUrl}`));
    }, 30_000);

    let finished = "";
    let lastPartial = "";

    ws.onopen = () => {
      ws.send(samples);
      ws.send("Done");
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      if (ev.data === "Done!") {
        clearTimeout(timer);
        ws.close();
        const trimmed = (finished || lastPartial).trim();
        if (!trimmed) reject(new Error("transcription came back empty (silent or unintelligible audio?)"));
        else resolve(truecase(trimmed));
        return;
      }
      try {
        const json = JSON.parse(ev.data) as { text?: string; is_final?: boolean };
        if (typeof json.text !== "string") return;
        if (json.is_final) {
          const segment = json.text.trim();
          if (segment) finished += (finished ? " " : "") + segment;
          lastPartial = "";
        } else {
          lastPartial = json.text;
        }
        // Live preview: finalized segments + current segment preview.
        if (onPartial) {
          const preview = (finished + (finished && lastPartial ? " " : "") + lastPartial).trim();
          if (preview) onPartial(truecase(preview));
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`sherpa-onnx websocket error: ${wsUrl}`));
    };
  });
}

async function transcribeWithParakeet(wav: Buffer, sherpaUrl: string): Promise<string> {
  // sherpa-onnx-offline-websocket-server protocol (offline-websocket-server-impl.cc):
  // (1) connect via WebSocket
  // (2) first binary frame carries a header of two int32 LE values
  //     [sample_rate][expected_byte_size], followed by the raw float32
  //     samples (LE), normalized to [-1, 1]
  // (3) the server decodes once the whole buffer has arrived and replies
  //     with one JSON message containing { "text": ... }
  // (4) the client sends "Done" so the server closes the connection
  const wsUrl = sherpaUrl.replace(/^http/, "ws");
  const samples = wavToFloat32Samples(wav);

  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    // Offline decoding of a long note can take a while on a phone, so scale
    // the timeout with the audio length instead of a fixed cap.
    const durationMs = Math.round((samples.length / 16000) * 1000);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`parakeet (offline) timed out after ${Math.round((durationMs * 3) / 1000)}s: ${wsUrl}`));
    }, Math.max(60_000, durationMs * 3));

    let text = "";

    ws.onopen = () => {
      const frame = new Uint8Array(8 + samples.byteLength);
      const view = new DataView(frame.buffer);
      view.setInt32(0, 16000, true);
      view.setInt32(4, samples.byteLength, true);
      frame.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 8);
      ws.send(frame);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const json = JSON.parse(ev.data) as { text?: string };
        if (typeof json.text === "string") text += json.text;
      } catch {
        // ignore non-JSON messages
      }
      ws.send("Done");
    };

    ws.onclose = () => {
      clearTimeout(timer);
      const trimmed = text.trim();
      if (!trimmed) reject(new Error("transcription came back empty (silent or unintelligible audio?)"));
      else resolve(trimmed);
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`parakeet (offline) websocket error: ${wsUrl}`));
    };
  });
}

/** Restore sentence case to all-caps text (the zipformer en model emits uppercase-only transcripts). */
function truecase(text: string): string {
  let out = "";
  let capNext = true;
  for (const ch of text.toLowerCase()) {
    if (capNext && /[a-z]/.test(ch)) {
      out += ch.toUpperCase();
      capNext = false;
    } else {
      out += ch;
      if (ch === "." || ch === "!" || ch === "?") capNext = true;
    }
  }
  return out;
}

/** Locate the PCM data chunk in a WAV file. */
function findWavDataChunk(wav: Buffer): { offset: number; length: number } {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      return { offset: offset + 8, length: Math.min(size, wav.length - offset - 8) };
    }
    offset += 8 + size;
  }
  throw new Error("WAV has no data chunk");
}

/** Convert a 16-bit PCM WAV into a Float32Array of normalized samples in [-1, 1]. */
function wavToFloat32Samples(wav: Buffer): Float32Array {
  const { offset: dataOffset, length: dataLength } = findWavDataChunk(wav);
  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = wav.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return samples;
}

/** Quick reachability probe for a local STT server URL. */
async function probeUrl(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url + "/", { signal: ctrl.signal });
    clearTimeout(t);
    // sherpa-onnx is a WebSocket server — plain HTTP GET returns 426
    // (Upgrade Required). That's not an error, the server is alive.
    // Accept any non-5xx response as "reachable".
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Quick reachability probe for whichever backend is active. */
export async function checkStt(backend: SttBackend, whisperUrl: string, sherpaUrl: string): Promise<boolean> {
  return probeUrl(backend === "sherpa" ? sherpaUrl : whisperUrl);
}

/**
 * The STT providers as adapters. Local backends wrap the existing functions;
 * Rime is cloud-only but must run here (its upgrade needs an Authorization
 * header no browser WebSocket can send), with the key passed per request.
 */
export function createSttAdapters(ctx: SttAdapterContext): Record<string, SttAdapter> {
  const transcribeWith =
    (backend: SttBackend) =>
    async (clip: AudioClip): Promise<Transcript> => {
      if (!ctx.tmpDir) throw new Error("no tmpDir configured");
      const wav = await convertToWav(Buffer.from(clip.bytes), normalizeExt(clip.ext), ctx.tmpDir);
      return {
        text: await transcribeWav(wav, {
          backend,
          whisperUrl: ctx.whisperUrl ?? "",
          sherpaUrl: ctx.sherpaUrl ?? "",
          tmpDir: ctx.tmpDir,
          language: ctx.language,
        }),
      };
    };
  const probe =
    (backend: SttBackend) =>
    async (): Promise<boolean> => {
      const url = backend === "whisper" ? ctx.whisperUrl : ctx.sherpaUrl;
      return url ? probeUrl(url) : false;
    };
  const adapter = (id: SttBackend, label: string, endpoint?: string): SttAdapter => ({
    id,
    label,
    endpoint,
    cloud: false,
    transcribe: transcribeWith(id),
    check: probe(id),
  });
  const rime: SttAdapter = {
    id: "rime",
    label: "Rime STT (cloud)",
    endpoint: RIME_STT_URL,
    cloud: true,
    async transcribe(clip, request) {
      if (!request.apiKey) throw new Error("no Rime key — add it in Settings → Speech");
      if (!ctx.tmpDir) throw new Error("no tmpDir configured");
      // convertToWav yields exactly what Rime wants: 16 kHz mono PCM16.
      const wav = await convertToWav(Buffer.from(clip.bytes), normalizeExt(clip.ext), ctx.tmpDir);
      const { offset } = findWavDataChunk(wav);
      const text = await transcribeRimePcm(wav.subarray(offset), {
        apiKey: request.apiKey,
        language: request.language ?? "en",
      });
      return { text };
    },
    check: async (request) => Boolean(request.apiKey),
  };
  return {
    whisper: adapter("whisper", "Whisper (local server)", ctx.whisperUrl),
    sherpa: adapter("sherpa", "Sherpa (local server)", ctx.sherpaUrl),
    parakeet: adapter("parakeet", "Parakeet (local server)", ctx.sherpaUrl),
    rime,
  };
}

/**
 * Dispatch a clip to a named provider. Errors always name the provider, so the
 * tab can show an actionable message instead of a bare fetch failure.
 */
export function createSttDispatcher(
  adapters: Record<string, SttAdapter>,
): (provider: string, clip: AudioClip, ctx?: SttAdapterContext) => Promise<Transcript> {
  const ids = Object.keys(adapters);
  return async (provider, clip, ctx = {}) => {
    const adapter = adapters[provider];
    if (!adapter) throw new Error(`unknown stt provider "${provider}" — available: ${ids.join(", ")}`);
    try {
      return await adapter.transcribe(clip, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`stt provider "${provider}" failed: ${detail}`);
    }
  };
}

/** Transcribe bytes with an explicitly chosen provider. */
export async function transcribeWithProvider(
  provider: string,
  input: Buffer,
  ext: string,
  ctx: SttAdapterContext,
): Promise<string> {
  const dispatch = createSttDispatcher(createSttAdapters(ctx));
  const { text } = await dispatch(provider, { bytes: input, ext: normalizeExt(ext) }, ctx);
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`stt provider "${provider}" came back empty (silent or unintelligible audio?)`);
  return trimmed;
}

/** Clamp a container hint to a safe ffmpeg extension. */
function normalizeExt(ext: string): string {
  const raw = String(ext ?? "").trim().toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(raw) ? raw : ".webm";
}
