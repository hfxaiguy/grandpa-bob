import { createHash } from "node:crypto";
import type { AudioClip, TtsAdapter, TtsAdapterContext } from "../web/src/services/types.js";

/**
 * TTS providers.
 *
 * KittenTTS is a Python library, not a server, so it is served next to the
 * channel (scripts/kitten-tts-server.py, OpenAI-compatible
 * `/v1/audio/speech`) exactly like whisper-server serves STT.
 *
 * Rime Mist v3 is cloud but not browser-callable: `mist.api.rime.ai` returns
 * no CORS headers (preflight 404), so it runs here and the tab attaches its
 * key per request over the peer channel.
 */
export interface TtsRuntime {
  kittenUrl: string;
  voice: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const RIME_TTS_URL = "https://mist.api.rime.ai/";
/** Rime's documented per-request text limit. */
export const RIME_TTS_MAX_CHARS = 1000;

/** Split text on sentence boundaries into pieces no longer than `max`. */
export function chunkText(text: string, max = RIME_TTS_MAX_CHARS): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= max) return [normalized];

  const sentences = normalized.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [normalized];
  const out: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > max) {
      flush();
      // A single very long sentence: split on words, hard-split anything left.
      let rest = sentence.trim();
      while (rest.length > max) {
        let cut = rest.lastIndexOf(" ", max);
        if (cut <= 0) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) current = rest + " ";
      continue;
    }
    if ((current + sentence).length > max) {
      flush();
      current = sentence;
    } else {
      current += sentence;
    }
  }
  flush();
  return out;
}

/** Pull the PCM payload and format out of a 16-bit WAV. */
function readWav(wav: Buffer): { sampleRate: number; channels: number; bits: number; pcm: Buffer } {
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      bits = wav.readUInt16LE(offset + 22);
    } else if (id === "data") {
      return { sampleRate, channels, bits, pcm: wav.subarray(offset + 8, offset + 8 + size) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Join same-format 16-bit WAVs into one. */
export function joinWavs(parts: Buffer[]): Buffer {
  if (parts.length === 1) return parts[0];
  const first = readWav(parts[0]);
  if (first.bits !== 16) throw new Error("only 16-bit WAV can be joined");
  const pcm = Buffer.concat(parts.map((part) => readWav(part).pcm));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(first.channels, 22);
  header.writeUInt32LE(first.sampleRate, 24);
  header.writeUInt32LE(first.sampleRate * first.channels * 2, 28);
  header.writeUInt16LE(first.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesizeKitten(
  text: string,
  ctx: TtsAdapterContext,
  rt: TtsRuntime,
  fetchImpl: FetchLike,
): Promise<AudioClip> {
  const base = ctx.endpoint ?? rt.kittenUrl;
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kitten-tts",
        input: text,
        voice: ctx.voice ?? rt.voice,
        response_format: "wav",
        stream: false,
      }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot reach the KittenTTS server at ${base} (${detail}) — start it with ` +
        "`npm run tts:up`, or pick Rime Mist v3 in Settings → Speech",
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`KittenTTS failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error("KittenTTS returned empty audio");
  return { bytes, ext: ".wav" };
}

async function synthesizeRime(
  text: string,
  ctx: TtsAdapterContext,
  fetchImpl: FetchLike,
): Promise<AudioClip> {
  if (!ctx.apiKey) throw new Error("no Rime key — add it in Settings → Speech");
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("no text to speak");

  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const res = await fetchImpl(RIME_TTS_URL, {
      method: "POST",
      headers: {
        accept: "audio/wav",
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: chunk,
        ...(ctx.voice ? { speaker: ctx.voice } : {}),
        ...(ctx.language ? { lang: ctx.language } : {}),
        samplingRate: 24000,
      }),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("Rime rejected the key — check it in Settings → Speech");
      }
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Rime TTS failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new Error("Rime TTS returned empty audio");
    parts.push(bytes);
  }
  const wav = joinWavs(parts);
  return { bytes: new Uint8Array(wav), ext: ".wav" };
}

export function createTtsAdapters(
  rt: TtsRuntime,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Record<string, TtsAdapter> {
  const kitten: TtsAdapter = {
    id: "kitten",
    label: "KittenTTS (local server)",
    endpoint: rt.kittenUrl,
    cloud: false,
    synthesize: (text, ctx) => synthesizeKitten(text, ctx, rt, fetchImpl),
    async check(ctx) {
      try {
        const res = await fetchImpl(`${ctx.endpoint ?? rt.kittenUrl}/health`);
        return res.ok;
      } catch {
        return false;
      }
    },
  };
  const rime: TtsAdapter = {
    id: "rime",
    label: "Rime Mist v3 (cloud)",
    endpoint: RIME_TTS_URL,
    cloud: true,
    synthesize: (text, ctx) => synthesizeRime(text, ctx, fetchImpl),
    async check(ctx) {
      if (!ctx.apiKey) return false;
      try {
        const res = await fetchImpl(RIME_TTS_URL, {
          method: "POST",
          headers: {
            accept: "audio/wav",
            authorization: `Bearer ${ctx.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "" }),
        });
        return res.status !== 401 && res.status !== 403;
      } catch {
        return false;
      }
    },
  };
  return { kitten, rime };
}

/** Dispatch synthesis to a named provider; errors always name the provider. */
export function createTtsDispatcher(
  adapters: Record<string, TtsAdapter>,
): (provider: string, text: string, ctx?: TtsAdapterContext) => Promise<AudioClip> {
  const ids = Object.keys(adapters);
  return async (provider, text, ctx = {}) => {
    const adapter = adapters[provider];
    if (!adapter) throw new Error(`unknown tts provider "${provider}" — available: ${ids.join(", ")}`);
    try {
      return await adapter.synthesize(text, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`tts provider "${provider}" failed: ${detail}`);
    }
  };
}

/** 48 MB of synthesized audio is plenty for a session; FIFO eviction. */
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const clipCache = new Map<string, AudioClip>();
let clipCacheBytes = 0;

function cacheKeyFor(provider: string, text: string, ctx: TtsAdapterContext): string {
  return createHash("sha256")
    .update(`${provider}\u0000${ctx.voice ?? ""}\u0000${ctx.language ?? ""}\u0000${text}`)
    .digest("hex");
}

export async function synthesizeWithProvider(
  provider: string,
  text: string,
  ctx: TtsAdapterContext,
  rt: TtsRuntime,
  fetchImpl?: FetchLike,
): Promise<AudioClip> {
  const key = cacheKeyFor(provider, text, ctx);
  const hit = clipCache.get(key);
  if (hit) return hit;

  const dispatch = createTtsDispatcher(createTtsAdapters(rt, fetchImpl));
  const clip = await dispatch(provider, text, ctx);

  const size = clip.bytes.byteLength;
  if (size <= CACHE_MAX_BYTES) {
    clipCache.set(key, clip);
    clipCacheBytes += size;
    while (clipCacheBytes > CACHE_MAX_BYTES) {
      const oldest = clipCache.entries().next();
      if (oldest.done) break;
      const [oldKey, oldClip] = oldest.value;
      clipCache.delete(oldKey);
      clipCacheBytes -= oldClip.bytes.byteLength;
    }
  }
  return clip;
}
