/**
 * Provider-registry checks: the shipped model templates and the Settings
 * presets must agree on each provider's exact API root. CommandCode's
 * Provider API lives under `/provider/v1`; grandma-kat appends
 * `/chat/completions`, and an endpoint probe appends `/models`, so a root
 * without that segment silently sends every call to a 404.
 *
 * No network: these are the files a fresh profile and a copied example start
 * from. Run with `npm run test:providers`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseModels } from "../web/src/model-config.js";
import { MODEL_PRESETS, presetId } from "../web/src/model-presets.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const COMMANDCODE_ROOT = "https://api.commandcode.ai/provider/v1";

// ── Settings preset ──────────────────────────────────────────────────────
const commandcodePreset = MODEL_PRESETS.commandcode;
assert.ok(commandcodePreset, "Settings → Models offers a CommandCode preset");
assert.equal(commandcodePreset.baseURL, COMMANDCODE_ROOT);
assert.equal(commandcodePreset.protocol, undefined, "Provider API is OpenAI-compatible, not Ollama-native");
assert.equal(presetId(COMMANDCODE_ROOT, undefined), "commandcode");
assert.equal(presetId(COMMANDCODE_ROOT, ""), "commandcode");
assert.equal(presetId(`${COMMANDCODE_ROOT}/`, undefined), "custom", "preset matching stays exact");
assert.equal(presetId("https://ollama.com", "ollama"), "ollama-cloud", "protocol still participates in matching");
assert.equal(presetId(COMMANDCODE_ROOT, "ollama"), "custom", "the provider API is not native Ollama");
for (const [id, preset] of Object.entries(MODEL_PRESETS)) {
  assert.ok(preset.label, `preset ${id} has a label`);
  assert.equal(typeof preset.baseURL, "string", `preset ${id} has a base URL`);
  if (preset.protocol !== undefined) {
    assert.equal(preset.protocol, "ollama", `preset ${id} only uses the supported protocol`);
  }
}

// ── Seeded standalone registry ──────────────────────────────────────────
const seededEnv = { COMMAND_CODE_API_KEY: "cmd-test-key" };
const seeded = parseModels(read("../web/public/models.standalone.json"), seededEnv);
assert.equal(seeded.commandcode.baseURL, commandcodePreset.baseURL);
assert.equal(seeded.commandcode.apiKey, "cmd-test-key", "the seed references ${COMMAND_CODE_API_KEY}");
assert.equal(seeded.commandcode.model, "deepseek/deepseek-v4.1-flash");
assert.equal(seeded["commandcode-cheap"].baseURL, commandcodePreset.baseURL);
assert.equal(seeded["commandcode-cheap"].model, "deepseek/deepseek-v4-flash");
assert.equal(seeded["commandcode-cheap"].apiKey, "cmd-test-key");
assert.equal(presetId(seeded.commandcode.baseURL, seeded.commandcode.protocol), "commandcode");
assert.equal(
  `${seeded.commandcode.baseURL}/chat/completions`,
  "https://api.commandcode.ai/provider/v1/chat/completions",
);
assert.equal(seeded.cheap, seeded.v4, "the seeded role aliases still resolve");
assert.equal(seeded.strong, seeded["v4.1"], "the seeded role aliases still resolve");

// A missing key leaves an empty string, so the Settings UI can show "(unset)"
// and the app can still offer its free-key flow rather than a literal `${...}`.
const keyless = parseModels(read("../web/public/models.standalone.json"), {});
assert.equal(keyless.commandcode.apiKey, "");

// ── models.example.json ─────────────────────────────────────────────────
const example = parseModels(read("../models.example.json"), seededEnv);
assert.equal(example.commandcode.baseURL, commandcodePreset.baseURL);
assert.equal(example.commandcode.apiKey, "cmd-test-key");
assert.equal(example["commandcode-cheap"].baseURL, commandcodePreset.baseURL);

console.log("provider-registry: CommandCode preset, seed and example registry agree OK");
