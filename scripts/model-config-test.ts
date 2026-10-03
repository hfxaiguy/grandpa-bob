/**
 * Pure model-config parser tests (shared by the Node loader and the browser
 * target). Run: `npm run test:models`.
 */
import assert from "node:assert/strict";
import { parseModels, BUILTIN_TRANSFORMS } from "../src/model-config.js";

const registry = parseModels(
  JSON.stringify({
    cheap: { baseURL: "https://ollama.com", apiKey: "${OLLAMA_API_KEY}", model: "gemma4:31b-cloud", transform: "gemma4Thinking", protocol: "ollama" },
    strong: { baseURL: "http://localhost:11434/v1", model: "qwen3", apiKey: "no-key" },
  }),
  { OLLAMA_API_KEY: "secret-key" },
);

assert.equal(registry.cheap.apiKey, "secret-key", "interpolates env");
assert.equal(registry.cheap.protocol, "ollama");
assert.equal(registry.cheap.transform, BUILTIN_TRANSFORMS.gemma4Thinking, "wires built-in transform");
assert.equal(registry.strong.protocol, undefined);
assert.equal(registry.strong.apiKey, "no-key");
assert.match(registry.strong.baseURL, /localhost:11434/);

// Missing env leaves an empty string, not the literal placeholder.
const missing = parseModels(JSON.stringify({ m: { baseURL: "x", model: "y", apiKey: "${NOT_SET}" } }), {});
assert.equal(missing.m.apiKey, "");

assert.throws(() => parseModels("not json"), /invalid JSON/);
assert.throws(() => parseModels("[]"), /must be an object/);
assert.throws(
  () => parseModels(JSON.stringify({ m: { model: "y" } })),
  /missing required string "baseURL"/,
);
assert.throws(
  () => parseModels(JSON.stringify({ m: { baseURL: "x", model: "y", transform: "nope" } })),
  /unknown transform/,
);
assert.throws(() => parseModels("{}"), /no model entries/);

console.log("model-config: parse, interpolation, transform wiring and errors OK");
