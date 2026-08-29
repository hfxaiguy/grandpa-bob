import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
 * .mp4, .wav, ...). Converts to 16kHz mono WAV, then dispatches to the
 * configured backend. Used by the web UI's voice input.
 */
export async function transcribeAudioBytes(
  input: Buffer,
  { ext = ".ogg", ...opts }: SttBackendOptions & { ext?: string },
): Promise<string> {
  const wav = await convertToWav(input, ext, opts.tmpDir);
  return transcribeWav(wav, opts);
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

/**
 * Streaming transcription of a 16kHz mono PCM WAV. Calls
 * `onPartial(accumulatedText, processedSeconds?)` as the transcript grows:
 *   - whisper : audio is sliced into CHUNK_S segments transcribed in order,
 *               each conditioned on the text so far (whisper-server `prompt`),
 *               so partials land every few seconds even on long files.
 *   - sherpa  : the online websocket server's live partials are forwarded.
 *   - parakeet: offline decoder — a single partial at the end.
 * Returns the final transcript.
 */
export async function transcribeWavStreaming(
  wav: Buffer,
  { backend, whisperUrl, sherpaUrl, language }: SttBackendOptions,
  onPartial?: (text: string, processedSeconds?: number) => void,
): Promise<string> {
  if (backend === "sherpa") {
    return transcribeWithSherpa(wav, sherpaUrl, onPartial ? (t) => onPartial(t) : undefined);
  }
  if (backend === "parakeet") {
    const text = await transcribeWithParakeet(wav, sherpaUrl);
    onPartial?.(text, wavDurationSeconds(wav));
    return text;
  }
  return transcribeWhisperStreaming(wav, whisperUrl, language, onPartial);
}

/** Duration of a 16kHz 16-bit mono PCM WAV in whole seconds (0 if unparseable). */
export function wavDurationSeconds(wav: Buffer): number {
  try {
    const { length } = findWavDataChunk(wav);
    return Math.round(length / (16000 * 2));
  } catch {
    return 0;
  }
}

/** Seconds of audio per whisper streaming chunk. */
const WHISPER_CHUNK_S = 20;

async function transcribeWhisperStreaming(
  wav: Buffer,
  whisperUrl: string,
  language: string | undefined,
  onPartial?: (text: string, processedSeconds?: number) => void,
): Promise<string> {
  const { length: dataLength } = findWavDataChunk(wav);
  const totalSamples = Math.floor(dataLength / 2);
  const chunkSamples = WHISPER_CHUNK_S * 16000;

  // Short file: single request, same behavior as the one-shot path.
  if (totalSamples <= chunkSamples) {
    const text = await transcribeWithWhisper(wav, whisperUrl, language);
    onPartial?.(text, Math.round(totalSamples / 16000));
    return text;
  }

  let text = "";
  for (let start = 0; start < totalSamples; start += chunkSamples) {
    const end = Math.min(start + chunkSamples, totalSamples);
    const slice = wavSlice(wav, start, end);
    // NOTE: no `prompt` here — whisper.cpp's prompt feature makes greedy
    // decoding echo the prior text and emit garbage (0xFF) tokens on chunk
    // boundaries, corrupting the transcript. Independent chunks + plain
    // concatenation reads clean even across a mid-word cut.
    const seg = await whisperInference(slice, whisperUrl, language);
    if (seg) text = text ? `${text} ${seg}` : seg;
    onPartial?.(text, Math.round(end / 16000));
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error("transcription came back empty (silent or unintelligible audio?)");
  return trimmed;
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

/**
 * Cut samples [startSample, endSample) out of a 16kHz 16-bit mono PCM WAV
 * and wrap them in a fresh minimal WAV header. Used to feed whisper long
 * files in chunks so partials stream back while the file is processed.
 */
function wavSlice(wav: Buffer, startSample: number, endSample: number): Buffer {
  const { offset } = findWavDataChunk(wav);
  const pcm = wav.subarray(offset + startSample * 2, offset + endSample * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24); // sample rate
  header.writeUInt32LE(16000 * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
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

/** Quick reachability probe for whichever backend is active. */
export async function checkStt(backend: SttBackend, whisperUrl: string, sherpaUrl: string): Promise<boolean> {
  const url = backend === "sherpa" ? sherpaUrl : whisperUrl;
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

/** Backwards-compat alias for callers still using the old name. */
export const checkWhisper = checkStt;
