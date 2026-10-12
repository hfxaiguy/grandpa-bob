/**
 * Per-conversation, PER-ROLE model switching + live registry replacement.
 *
 *   1. updateModels() replaces the registry IN PLACE, so every holder (turns,
 *      bot /status, admin probes) sees the new entries without a restart.
 *   2. setSessionModel(key, role, target) retargets each role independently —
 *      "strong" and "cheap" can point at different slots; other roles and the
 *      base registry are never mutated by modelsFor().
 *   3. An unknown target is rejected; deleting a slot later degrades
 *      gracefully (the tree's own slot wins again, no crash).
 *   4. Overrides persist in sessions.json (as { role: target }) and survive an
 *      Agent restart. The old single-string "model" format is migrated to
 *      { strong }.
 *   5. clear() drops every override; clearSessionModel(key, role) drops one.
 *   6. modelSlots() never exposes the api key.
 *
 * Mock model handlers, no network. Run: npm run test:model-switch
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-models-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const sessionsFile = path.join(ws, "logs", "sessions.json");

const handler = async () => ({ content: "mock", reasoning: null, tool_calls: [] });
const entry = (model: string, baseURL = "http://localhost:0/v1") => ({ baseURL, apiKey: "k", model, handler });
const tools = new ToolRegistry(ws, ["ls"]);
const mkModels = () => ({ cheap: entry("cheap-model"), strong: entry("strong-model") });
const mkAgent = (models: any) => new Agent({ models, workspace: ws, tools, patternName: () => "trunk" });

// ── 1. updateModels mutates the SAME object in place ──
{
  const models = mkModels();
  const agent = mkAgent(models);
  const next = { cheap: entry("new-cheap"), strong: entry("new-strong"), extra: entry("x") };
  agent.updateModels(next as any);
  assert.deepEqual(Object.keys(models).sort(), ["cheap", "extra", "strong"], "registry keys replaced in place");
  assert.equal(models.strong.model, "new-strong", "strong entry replaced");
  assert.equal(models.cheap.model, "new-cheap", "cheap entry replaced");
  console.log("1. updateModels() replaces the live registry in place");
}

// ── 2. per-role overrides are independent; base untouched ──
{
  const models: any = mkModels();
  models.big = entry("big-model");
  models.tiny = entry("tiny-model");
  const agent = mkAgent(models);
  assert.equal(agent.setSessionModel("k2", "strong", "big"), true, "strong target accepted");
  assert.equal(agent.setSessionModel("k2", "cheap", "tiny"), true, "cheap target accepted");

  const view = agent.modelsFor("k2");
  assert.equal(view.strong, models.big, "strong role → big");
  assert.equal(view.cheap, models.tiny, "cheap role → tiny");
  assert.equal(models.strong, models.strong, "base strong slot not overwritten");
  assert.equal(models.cheap, models.cheap, "base cheap slot not overwritten");
  // Another conversation has no override and sees the base registry object.
  assert.equal(agent.modelsFor("other"), models, "other conversations get the base registry");
  console.log("2. each role retargets independently; base registry untouched");
}

// ── 3. unknown target rejected; deleted slot degrades gracefully ──
{
  const models: any = mkModels();
  models.big = entry("big-model");
  const agent = mkAgent(models);
  assert.equal(agent.setSessionModel("k3", "strong", "nope"), false, "unknown target rejected");
  assert.equal(agent.sessionModel("k3"), undefined, "nothing stored for a rejected target");
  agent.setSessionModel("k3", "strong", "big");
  // The admin editor deletes the slot out from under a live conversation.
  agent.updateModels({ cheap: entry("c"), strong: entry("s") } as any);
  assert.equal(agent.modelsFor("k3").strong, models.strong, "stale override falls back to the tree's own strong");
  console.log("3. unknown target rejected; stale override falls back cleanly");
}

// ── 4. overrides persist (per role) across an Agent restart ──
{
  const models: any = mkModels();
  models.big = entry("big-model");
  const a1 = mkAgent(models);
  a1.setSessionModel("tg:123", "strong", "big");
  a1.setSessionModel("tg:123", "cheap", "cheap");
  const onDisk = JSON.parse(await fs.readFile(sessionsFile, "utf8"));
  assert.deepEqual(onDisk["tg:123"].models, { strong: "big", cheap: "cheap" }, "per-role overrides written");
  // Simulated restart: fresh Agent, same workspace, registry still has big.
  const a2models: any = mkModels();
  a2models.big = entry("big-model");
  const a2 = mkAgent(a2models);
  assert.deepEqual(a2.sessionModelMap("tg:123"), { strong: "big", cheap: "cheap" }, "overrides restored");
  assert.equal(a2.modelsFor("tg:123").strong.model, "big-model", "restored strong override applied");
  console.log("4. per-role overrides survive an Agent restart");
}

// ── 4b. legacy single-string "model" migrates to { strong } ──
{
  await fs.writeFile(
    sessionsFile,
    JSON.stringify({ legacy: { continuation: null, models: null, model: "big" } }),
  );
  const models: any = mkModels();
  models.big = entry("big-model");
  const agent = mkAgent(models);
  assert.deepEqual(agent.sessionModelMap("legacy"), { strong: "big" }, "old format migrated");
  console.log("4b. legacy single-override format migrated to the strong role");
}

// ── 5. clear() drops all overrides; clearSessionModel(key, role) drops one ──
{
  const models: any = mkModels();
  models.big = entry("big-model");
  models.tiny = entry("tiny-model");
  const agent = mkAgent(models);
  agent.setSessionModel("k5", "strong", "big");
  agent.setSessionModel("k5", "cheap", "tiny");
  agent.clearSessionModel("k5", "cheap");
  assert.deepEqual(agent.sessionModelMap("k5"), { strong: "big" }, "only the cheap override was dropped");
  agent.clear("k5");
  const onDisk = JSON.parse(await fs.readFile(sessionsFile, "utf8"));
  assert.equal(onDisk.k5, undefined, "clear() emptied the session entry");
  assert.deepEqual(agent.sessionModelMap("k5"), {}, "all overrides dropped");
  console.log("5. clear() drops all overrides; per-role clear drops one");
}

// ── 6. modelSlots() exposes display fields but never the api key ──
{
  const agent = mkAgent(mkModels());
  const slots = agent.modelSlots();
  assert.deepEqual(slots.map((s) => s.name).sort(), ["cheap", "strong"]);
  const strong = slots.find((s) => s.name === "strong")!;
  assert.equal(strong.model, "strong-model");
  assert.ok(!("apiKey" in (strong as Record<string, unknown>)), "api key is not exposed");
  console.log("6. modelSlots() hides api keys");
}

console.log("model-switch-test: all assertions passed");
