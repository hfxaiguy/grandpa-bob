/**
 * Unit test: the STT dispatcher.
 *
 * Runs without ffmpeg, whisper, or a network: fake adapters exercise routing,
 * structured errors, and the registry metadata. This is the guard that keeps
 * provider ids and their error contract honest as adapters are added.
 */
import assert from "node:assert/strict";
import { createSttDispatcher } from "../src/stt.js";
import {
  LOCAL_STT_PROVIDERS,
  STT_PROVIDER_META,
  isLocalSttProvider,
} from "../web/src/services/registry.js";

const clip = { bytes: new Uint8Array([1, 2, 3]), ext: ".wav" };

// A named adapter receives the clip unchanged.
let seen: { ext: string; bytes: number } | null = null;
const ok = createSttDispatcher({
  fake: {
    id: "fake",
    label: "Fake",
    transcribe: async (c) => {
      seen = { ext: c.ext, bytes: c.bytes.length };
      return { text: "hello" };
    },
  },
});
assert.deepEqual(await ok("fake", clip), { text: "hello" });
assert.deepEqual(seen, { ext: ".wav", bytes: 3 });

// Unknown provider: structured error listing the available ids.
await assert.rejects(
  () => ok("nope", clip),
  /unknown stt provider "nope" — available: fake/,
);

// Adapter failure: the provider is always named.
const bad = createSttDispatcher({
  broken: {
    id: "broken",
    label: "Broken",
    transcribe: async () => {
      throw new Error("boom");
    },
  },
});
await assert.rejects(() => bad("broken", clip), /stt provider "broken" failed: boom/);

// Registry metadata stays consistent.
assert.ok(STT_PROVIDER_META.length >= 3);
for (const provider of STT_PROVIDER_META) {
  assert.ok(provider.id && provider.label);
  assert.equal(isLocalSttProvider(provider.id), !provider.cloud);
}
assert.deepEqual(LOCAL_STT_PROVIDERS, ["whisper", "sherpa", "parakeet"]);

console.log("stt-dispatch: ok");
