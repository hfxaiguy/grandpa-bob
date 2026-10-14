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

// `thinking` passes protocol-specific reasoning controls through, and empty
// or absent objects leave the field off entirely.
const withThinking = parseModels(
  JSON.stringify({
    a: { baseURL: "x", model: "y", thinking: { reasoning_effort: "high" } },
    b: { baseURL: "x", model: "y", thinking: { think: true, options: { num_ctx: 8192 } } },
    c: { baseURL: "x", model: "y", thinking: {} },
    d: { baseURL: "x", model: "y" },
  }),
);
assert.deepEqual(withThinking.a.thinking, { reasoning_effort: "high" });
assert.deepEqual(withThinking.b.thinking, { think: true, options: { num_ctx: 8192 } });
assert.equal(withThinking.c.thinking, undefined, "empty thinking is dropped");
assert.equal(withThinking.d.thinking, undefined);

assert.throws(
  () => parseModels(JSON.stringify({ m: { baseURL: "x", model: "y", thinking: "high" } })),
  /"thinking" must be an object/,
);
assert.throws(
  () => parseModels(JSON.stringify({ m: { baseURL: "x", model: "y", thinking: { think: "yes" } } })),
  /thinking\.think must be a boolean/,
);
assert.throws(
  () => parseModels(JSON.stringify({ m: { baseURL: "x", model: "y", thinking: { reasoning_effort: {} } } })),
  /thinking\.reasoning_effort must be a string or number/,
);
assert.throws(
  () => parseModels(JSON.stringify({ m: { baseURL: "x", model: "y", thinking: { options: [] } } })),
  /thinking\.options must be an object/,
);

console.log("model-config: parse, interpolation, transform wiring, thinking and errors OK");
