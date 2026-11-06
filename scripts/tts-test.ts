/**
 * Unit test: TTS config + the KittenTTS and Rime Mist v3 adapters.
 *
 * No network or Python: fetch is injected. Mirrors `stt-cloud-test`.
 */
import assert from "node:assert/strict";
import { loadTtsConfig, saveTtsConfig, ttsKeyFor } from "../web/src/services/config.js";
import {
  RIME_TTS_MAX_CHARS,
  chunkText,
  createTtsAdapters,
  createTtsDispatcher,
  synthesizeWithProvider,
} from "../src/tts.js";

/** Minimal 16-bit mono WAV around the given PCM bytes. */
function wav(pcm: number[]): Uint8Array {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(24000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}
const sampleWav = wav([1, 2, 3, 4]);

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

// ── config ────────────────────────────────────────────────────────────────
const store = new MemoryStorage();
assert.deepEqual(loadTtsConfig(store), { provider: "" });
saveTtsConfig({ provider: "kitten", voice: " Luna " }, store);
assert.deepEqual(loadTtsConfig(store), { provider: "kitten", voice: "Luna" });
saveTtsConfig({ enabled: false }, store);
assert.equal(loadTtsConfig(store).enabled, false);
saveTtsConfig({ enabled: true }, store);
assert.equal(loadTtsConfig(store).enabled, undefined); // on is the default, not stored
// Auto-speak is a scope, not a boolean. Absent = off.
saveTtsConfig({ autoSpeak: "all" }, store);
assert.equal(loadTtsConfig(store).autoSpeak, "all");
saveTtsConfig({ autoSpeak: "trunk" }, store);
assert.equal(loadTtsConfig(store).autoSpeak, "trunk");
saveTtsConfig({ autoSpeak: undefined }, store);
assert.equal(loadTtsConfig(store).autoSpeak, undefined);
// A config written before scopes existed used `true` for trunk-only.
store.setItem("bob:services", JSON.stringify({ tts: { autoSpeak: true } }));
assert.equal(loadTtsConfig(store).autoSpeak, "trunk");
saveTtsConfig({ autoSpeak: undefined }, store);
assert.equal(loadTtsConfig(store).autoSpeak, undefined);
saveTtsConfig({ provider: "rime", voice: "cove", keys: { rime: "  key " } }, store);
assert.deepEqual(loadTtsConfig(store), {
  provider: "rime",
  voice: "cove",
  keys: { rime: "key" },
});
assert.equal(ttsKeyFor(loadTtsConfig(store)), "key");
assert.equal(ttsKeyFor(loadTtsConfig(store), "kitten"), undefined);
saveTtsConfig({ provider: "nope" }, store);
assert.deepEqual(loadTtsConfig(store), { provider: "", voice: "cove", keys: { rime: "key" } });

// ── adapters ──────────────────────────────────────────────────────────────
const rt = { kittenUrl: "http://kitten.local", voice: "Bella" };
type Call = { url: string; init?: RequestInit; body: Record<string, unknown> };
const calls: Call[] = [];
const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  calls.push({ url, init, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
  return new Response(sampleWav, {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });
};
const dispatch = createTtsDispatcher(createTtsAdapters(rt, fakeFetch));

// KittenTTS request shape.
const clip = await dispatch("kitten", "hello");
assert.deepEqual(Array.from(clip.bytes), Array.from(sampleWav));
assert.equal(clip.ext, ".wav");
assert.equal(calls[0].url, "http://kitten.local/v1/audio/speech");
assert.equal(calls[0].body.input, "hello");
assert.equal(calls[0].body.voice, "Bella");
assert.equal(calls[0].body.response_format, "wav");
assert.equal(calls[0].body.stream, false);

// Per-request voice override.
await dispatch("kitten", "hi", { voice: "Leo" });
assert.equal(calls[1].body.voice, "Leo");

// Rime Mist v3 request shape.
const rimeClip = await dispatch("rime", "hello rime", { apiKey: "k", voice: "cove", language: "en" });
assert.equal(rimeClip.ext, ".wav");
assert.equal(calls[2].url, "https://mist.api.rime.ai/");
assert.equal(calls[2].body.text, "hello rime");
assert.equal(calls[2].body.speaker, "cove");
assert.equal(calls[2].body.lang, "en");
assert.equal(calls[2].body.samplingRate, 24000);
assert.equal((calls[2].init?.headers as Record<string, string>).accept, "audio/wav");

// Rime requires a key.
await assert.rejects(() => dispatch("rime", "hi", {}), /no Rime key/);

// Long text is chunked at Rime's 1,000-char limit and joined into one WAV.
const before = calls.length;
const longText = "Sentence one. ".repeat(200).trim(); // ~2,600 chars
const longClip = await dispatch("rime", longText, { apiKey: "k" });
const sent = calls.slice(before);
assert.ok(sent.length >= 3, `expected several chunks, got ${sent.length}`);
for (const call of sent) {
  assert.ok(String(call.body.text).length <= RIME_TTS_MAX_CHARS);
  assert.equal(call.body.speaker, undefined); // no voice override -> omitted
}
// Each chunk returned 4 PCM bytes; the joined WAV holds all of them.
assert.equal(longClip.bytes.length, 44 + 4 * sent.length);

// chunkText splits on sentences, then words, and never exceeds the cap.
const chunks = chunkText("One. Two! Three? " + "word ".repeat(400), RIME_TTS_MAX_CHARS);
assert.ok(chunks.length >= 2);
for (const chunk of chunks) assert.ok(chunk.length <= RIME_TTS_MAX_CHARS);
assert.equal(chunks[0], "One. Two! Three?");
assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), `One. Two! Three? ${"word ".repeat(400)}`.replace(/\s+/g, " ").trim());

// Identical text is served from the cache (one fetch per unique request).
const rtCached = { kittenUrl: "http://kitten.local", voice: "Bella" };
let cacheFetches = 0;
const countingFetch = async (): Promise<Response> => {
  cacheFetches += 1;
  return new Response(sampleWav, { status: 200 });
};
const first = await synthesizeWithProvider("kitten", "cache me", {}, rtCached, countingFetch);
const second = await synthesizeWithProvider("kitten", "cache me", {}, rtCached, countingFetch);
assert.equal(cacheFetches, 1);
assert.deepEqual(Array.from(first.bytes), Array.from(second.bytes));

// A down server is named with the address and the fix, not "fetch failed".
const downDispatcher = createTtsDispatcher(
  createTtsAdapters(rt, async () => {
    throw new Error("fetch failed");
  }),
);
await assert.rejects(
  () => downDispatcher("kitten", "hi"),
  /cannot reach the KittenTTS server at http:\/\/kitten.local .*npm run tts:up/,
);

// Unknown provider names the available ids.
await assert.rejects(() => dispatch("nope", "hi"), /unknown tts provider "nope" — available: kitten, rime/);

// A service failure always names the provider.
const bad = createTtsDispatcher(
  createTtsAdapters(rt, async () => new Response("model exploded", { status: 500 })),
);
await assert.rejects(
  () => bad("kitten", "hi"),
  /tts provider "kitten" failed: KittenTTS failed: HTTP 500 — model exploded/,
);

// Rime auth failures are mapped, not dumped.
const denied = createTtsDispatcher(
  createTtsAdapters(rt, async () => new Response("", { status: 401 })),
);
await assert.rejects(
  () => denied("rime", "hi", { apiKey: "bad" }),
  /tts provider "rime" failed: Rime rejected the key/,
);

// Empty audio is an error, not a silent success.
const empty = createTtsDispatcher(
  createTtsAdapters(rt, async () => new Response(new Uint8Array(), { status: 200 })),
);
await assert.rejects(() => empty("kitten", "hi"), /returned empty audio/);

// Health probes.
assert.equal(
  await createTtsAdapters(rt, async () => new Response("{}", { status: 200 })).kitten.check?.({}),
  true,
);
assert.equal(
  await createTtsAdapters(rt, async () => new Response("{}", { status: 503 })).kitten.check?.({}),
  false,
);
assert.equal(
  await createTtsAdapters(rt, async () => new Response("", { status: 401 })).rime.check?.({ apiKey: "k" }),
  false,
);

console.log("tts: ok");
