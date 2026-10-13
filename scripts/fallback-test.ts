/**
 * Quota-fallback state on the Agent.
 *
 * A quota wall (402) kills a turn; the transport remembers it via
 * setPendingFallback and offers the model slots. confirmFallback retargets the
 * failed role (persisted, exactly like /model) and hands back the killed
 * turn's input so the caller can re-run it. A bad slot must not consume the
 * pending turn; a normal turn (or /clear) supersedes it.
 *
 * Run: npm run test:fallback
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-fallback-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

const models = {
  strong: { baseURL: "http://127.0.0.1:1/v1", model: "big" },
  cheap: { baseURL: "http://127.0.0.1:1/v1", model: "small" },
  claude: { baseURL: "http://127.0.0.1:1/v1", model: "claude-3" },
};
const agent = new Agent({ models, workspace: ws, tools: undefined as never });

// ── 1. store + read a pending fallback; empty role defaults to "strong" ──
{
  agent.setPendingFallback("web:1", "cheap", { hello: true });
  assert.deepEqual(agent.pendingFallback("web:1"), { role: "cheap", input: { hello: true } });
  agent.setPendingFallback("web:2", "", "typed text");
  assert.deepEqual(agent.pendingFallback("web:2"), { role: "strong", input: "typed text" });
  console.log("1. pending fallback stores the failed role and original input");
}

// ── 2. an unknown slot does not consume the pending turn ──
{
  assert.equal(agent.confirmFallback("web:1", "nope"), null, "unknown slot rejected");
  assert.ok(agent.pendingFallback("web:1"), "the pending turn survives a bad slot");
  assert.equal(agent.sessionModel("web:1", "cheap"), undefined, "no override written");
  console.log("2. an unknown slot leaves the pending fallback intact");
}

// ── 3. a valid slot retargets the failed role and returns the input ──
{
  const pending = agent.confirmFallback("web:1", "claude");
  assert.deepEqual(pending, { role: "cheap", input: { hello: true } });
  assert.equal(agent.sessionModel("web:1", "cheap"), "claude", "the failed role is retargeted");
  assert.equal(agent.pendingFallback("web:1"), undefined, "confirming consumes the pending turn");
  console.log("3. confirming retargets the role, returns the input, clears the pending");
}

// ── 4. the override persists to sessions.json (survives a restart) ──
{
  const saved = JSON.parse(await fs.readFile(path.join(ws, "logs", "sessions.json"), "utf8"));
  assert.equal(saved["web:1"].models.cheap, "claude", "override written to disk");
  const revived = new Agent({ models, workspace: ws, tools: undefined as never });
  assert.equal(revived.sessionModel("web:1", "cheap"), "claude", "a fresh Agent restores it");
  console.log("4. the fallback choice persists across a restart");
}

// ── 5. a normal turn (clearPendingFallback) supersedes the prompt ──
{
  agent.setPendingFallback("web:2", "strong", "old");
  agent.clearPendingFallback("web:2");
  assert.equal(agent.pendingFallback("web:2"), undefined);
  assert.equal(agent.confirmFallback("web:2", "claude"), null, "nothing left to confirm");
  console.log("5. a normal turn clears the pending fallback");
}

// ── 6. /clear drops the pending fallback too ──
{
  agent.setPendingFallback("web:3", "strong", "x");
  agent.clear("web:3");
  assert.equal(agent.pendingFallback("web:3"), undefined);
  console.log("6. clearing the conversation drops the pending fallback");
}

console.log("fallback-test: pending fallback store/confirm/persist/supersede OK");
