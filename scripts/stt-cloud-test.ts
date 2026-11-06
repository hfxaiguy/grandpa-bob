/**
 * Unit test: browser-side speech config + the AssemblyAI adapter.
 *
 * No network: fetch is injected. Covers the error mapping the spike found
 * (auth failures are 404s) and the localStorage config contract shared by the
 * chat UI and the Settings page.
 */
import assert from "node:assert/strict";
import {
  SERVICES_KEY,
  isCloudSttProvider,
  loadSttConfig,
  saveSttConfig,
  sttKeyFor,
} from "../web/src/services/config.js";
import {
  probeAssemblyAi,
  transcribeAssemblyAi,
} from "../web/src/services/stt/assemblyai.js";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const clip = { bytes: new Uint8Array([1, 2, 3]), ext: ".webm" };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ── config ────────────────────────────────────────────────────────────────
const store = new MemoryStorage();
assert.deepEqual(loadSttConfig(store), { provider: "" });

saveSttConfig({ provider: "assemblyai", keys: { assemblyai: "  key  " }, language: "en" }, store);
assert.deepEqual(loadSttConfig(store), {
  provider: "assemblyai",
  language: "en",
  keys: { assemblyai: "key" },
});
assert.equal(sttKeyFor(loadSttConfig(store)), "key");
assert.equal(sttKeyFor(loadSttConfig(store), "rime"), undefined);

// Unknown providers fall back to "desktop default"; other fields are kept.
saveSttConfig({ provider: "bogus" }, store);
assert.deepEqual(loadSttConfig(store), {
  provider: "",
  language: "en",
  keys: { assemblyai: "key" },
});

// Corrupt storage never throws.
store.setItem(SERVICES_KEY, "{not json");
assert.deepEqual(loadSttConfig(store), { provider: "" });

assert.equal(isCloudSttProvider("assemblyai"), true);
assert.equal(isCloudSttProvider("whisper"), false);
assert.equal(isCloudSttProvider(""), false);

// ── adapter ───────────────────────────────────────────────────────────────
assert.deepEqual(
  await transcribeAssemblyAi(clip, { apiKey: "k" }, async () => json({ text: "  hi there " })),
  { text: "hi there" },
);

await assert.rejects(
  () => transcribeAssemblyAi(clip, {}, async () => json({ text: "x" })),
  /no AssemblyAI key/,
);

await assert.rejects(
  () =>
    transcribeAssemblyAi(clip, { apiKey: "bad" }, async () =>
      json({ status: 404, detail: "Invalid API key" }, 404),
    ),
  /rejected the key/,
);

await assert.rejects(
  () => transcribeAssemblyAi(clip, { apiKey: "k" }, async () => json({ detail: "boom" }, 500)),
  /AssemblyAI failed: boom/,
);

// Probe: 404 means rejected; a body complaint means the key was accepted.
assert.equal(await probeAssemblyAi("k", async () => json({}, 404)), false);
assert.equal(await probeAssemblyAi("k", async () => json({}, 422)), true);
assert.equal(await probeAssemblyAi("", async () => json({})), false);

console.log("stt-cloud: ok");
