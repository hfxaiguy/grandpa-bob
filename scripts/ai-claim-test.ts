/**
 * BobSwap free-key claim helpers (no DOM): key detection, registry rewrite and
 * the claim response mapping. Run: `npm run test:ai-claim`.
 */
import assert from "node:assert/strict";
import {
  BOBSWAP_AI_BASE_URL,
  BOBSWAP_AI_KEY_ENV,
  ClaimError,
  applyClaimedKey,
  claimFreeKey,
  isClaimableEndpoint,
  needsFreeKey,
} from "../web/src/ai-claim.js";

const TEMPLATE = JSON.stringify({
  v4: {
    baseURL: "https://api.neuralwatt.com/v1",
    model: "deepseek-v4-flash",
    apiKey: "${NEURALWATT_API_KEY}",
    transform: "gemma4Thinking",
  },
  "v4.1": {
    baseURL: "https://api.neuralwatt.com/v1",
    model: "deepseek-v4.1-flash",
    apiKey: "${NEURALWATT_API_KEY}",
    transform: "gemma4Thinking",
  },
  cheap: "v4",
  strong: "v4.1",
});

// ── endpoint classification ───────────────────────────────────────────────
assert.equal(isClaimableEndpoint("https://api.neuralwatt.com/v1"), true);
assert.equal(isClaimableEndpoint("https://bobswap.hfxaiguy.com/api/v1/ai"), true);
assert.equal(isClaimableEndpoint("https://example.com/api/v1/ai/"), true);
assert.equal(isClaimableEndpoint("https://bobswap.hfxaiguy.com/api/v1/seed"), false);
assert.equal(isClaimableEndpoint("https://ollama.com"), false);
assert.equal(isClaimableEndpoint("not a url"), false);

// ── offer detection ───────────────────────────────────────────────────────
assert.equal(needsFreeKey(TEMPLATE, {}), true, "unset Neuralwatt key offers");
assert.equal(needsFreeKey(TEMPLATE, { NEURALWATT_API_KEY: "" }), true, "empty env still offers");
assert.equal(needsFreeKey(TEMPLATE, { NEURALWATT_API_KEY: "sk-live" }), false, "set key stays quiet");

// A literal key counts even without any env.
const literal = TEMPLATE.replace(/\$\{NEURALWATT_API_KEY\}/g, "sk-literal");
assert.equal(needsFreeKey(literal, {}), false);

// BobSwap-proxy slots are also claimable, so a removed/expired key re-offers.
const proxy = JSON.stringify({
  v4: { baseURL: BOBSWAP_AI_BASE_URL, model: "deepseek-v4-flash", apiKey: "${BOBSWAP_AI_KEY}" },
  "v4.1": { baseURL: BOBSWAP_AI_BASE_URL, model: "deepseek-v4.1-flash", apiKey: "${BOBSWAP_AI_KEY}" },
});
assert.equal(needsFreeKey(proxy, {}), true);
assert.equal(needsFreeKey(proxy, { [BOBSWAP_AI_KEY_ENV]: "bsk_live_x" }), false);

// Non-claimable providers (Ollama/OpenAI) never trigger the offer, and an
// invalid registry is left for the user to fix in Settings.
assert.equal(
  needsFreeKey(
    JSON.stringify({ strong: { baseURL: "https://api.openai.com/v1", model: "gpt", apiKey: "${OPENAI_API_KEY}" } }),
    {},
  ),
  false,
);
assert.equal(
  needsFreeKey(
    JSON.stringify({ local: { baseURL: "http://localhost:11434/v1", model: "qwen", apiKey: "no-key" } }),
    {},
  ),
  false,
);
assert.equal(needsFreeKey("not json", {}), false);
assert.equal(needsFreeKey("[]", {}), false);
assert.equal(needsFreeKey(JSON.stringify({ cheap: "v4" }), {}), false, "aliases alone do not offer");

// ── registry rewrite ──────────────────────────────────────────────────────
const rewritten = JSON.parse(applyClaimedKey(TEMPLATE, []));
assert.equal(rewritten.v4.baseURL, BOBSWAP_AI_BASE_URL);
assert.equal(rewritten["v4.1"].baseURL, BOBSWAP_AI_BASE_URL);
assert.equal(rewritten.v4.apiKey, "${" + BOBSWAP_AI_KEY_ENV + "}", "key is a reference, not a secret");
assert.equal(rewritten["v4.1"].apiKey, "${" + BOBSWAP_AI_KEY_ENV + "}");
assert.equal(rewritten.v4.model, "deepseek-v4-flash");
assert.equal(rewritten["v4.1"].model, "deepseek-v4.1-flash");
assert.equal(rewritten.v4.transform, "gemma4Thinking", "existing options survive");
assert.equal(rewritten.cheap, "v4", "aliases untouched");
assert.equal(rewritten.strong, "v4.1");
assert.equal(needsFreeKey(JSON.stringify(rewritten), { [BOBSWAP_AI_KEY_ENV]: "bsk_live_x" }), false);

// Slots that did not exist are created; an Ollama-native flag is dropped.
const added = JSON.parse(
  applyClaimedKey(JSON.stringify({ local: { baseURL: "http://localhost:11434", model: "qwen", apiKey: "no-key", protocol: "ollama" } }), []),
);
assert.equal(added.v4.baseURL, BOBSWAP_AI_BASE_URL);
assert.equal(added["v4.1"].baseURL, BOBSWAP_AI_BASE_URL);
assert.equal(added.cheap, "v4", "missing role aliases are added");
assert.equal(added.strong, "v4.1");
assert.equal(added.local.protocol, "ollama", "unrelated entries are untouched");

// A hand-edited alias is not replaced.
const customAlias = JSON.parse(
  applyClaimedKey(JSON.stringify({ cheap: "local", local: { baseURL: "http://localhost:1", model: "m" } }), []),
);
assert.equal(customAlias.cheap, "local");
assert.equal(customAlias.strong, "v4.1", "only the missing alias is added");

const ollamaSlot = JSON.parse(
  applyClaimedKey(
    JSON.stringify({ v4: { baseURL: "https://api.neuralwatt.com/v1", model: "m", apiKey: "k", protocol: "ollama" } }),
    [],
  ),
);
assert.equal(ollamaSlot.v4.protocol, undefined, "proxy is OpenAI-compatible");

// The allowlist decides the ids; "*" and an empty list keep the defaults.
const allowed = JSON.parse(
  applyClaimedKey(TEMPLATE, ["other-model", "deepseek-v4.1-flash", "deepseek-v4-flash"]),
);
assert.equal(allowed["v4.1"].model, "deepseek-v4.1-flash");
assert.equal(allowed.v4.model, "deepseek-v4-flash");

const star = JSON.parse(applyClaimedKey(TEMPLATE, ["*"]));
assert.equal(star.v4.model, "deepseek-v4-flash");
assert.equal(star["v4.1"].model, "deepseek-v4.1-flash");

const only = JSON.parse(applyClaimedKey(TEMPLATE, ["single-model"]));
assert.equal(only.v4.model, "single-model");
assert.equal(only["v4.1"].model, "single-model");

assert.throws(() => applyClaimedKey("not json", []), /not valid JSON/);
assert.throws(() => applyClaimedKey("[]", []), /must be an object/);

// ── claim response mapping ────────────────────────────────────────────────
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const claimed = await claimFreeKey(
  fakeFetch(201, {
    key: "bsk_live_" + "a".repeat(32),
    scope: "ai",
    tokens_remaining: 25000,
    requests_remaining: 20,
    expires_at: "2026-11-10T00:00:00Z",
    allowed_models: ["deepseek-v4.1-flash"],
    base_url: BOBSWAP_AI_BASE_URL,
  }),
);
assert.equal(claimed.key, "bsk_live_" + "a".repeat(32));
assert.equal(claimed.tokensRemaining, 25000);
assert.equal(claimed.requestsRemaining, 20);
assert.equal(claimed.expiresAt, "2026-11-10T00:00:00Z");
assert.deepEqual(claimed.allowedModels, ["deepseek-v4.1-flash"]);

await assert.rejects(
  () => claimFreeKey(fakeFetch(403, { error: "claiming disabled" })),
  (err: unknown) => err instanceof ClaimError && err.status === 403 && /turned off/.test(err.message),
);
await assert.rejects(
  () => claimFreeKey(fakeFetch(429, { error: "rate limited" })),
  (err: unknown) => err instanceof ClaimError && err.status === 429 && /busy/.test(err.message),
);
await assert.rejects(
  () => claimFreeKey(fakeFetch(200, { nope: true })),
  /unexpected response/,
);
await assert.rejects(
  () =>
    claimFreeKey((async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch),
  /could not reach BobSwap/,
);

console.log("ai-claim tests passed");
