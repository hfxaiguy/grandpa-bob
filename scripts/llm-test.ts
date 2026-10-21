/**
 * Live end-to-end test of the agent against the configured LLM backend:
 * asks the model to create a file via tools and verifies the auto-commit.
 * Uses real .env credentials. Run: npx tsx scripts/llm-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/index.js";
import { Agent } from "../src/agent.js";
import { loadModels } from "../src/models.js";
import { ensureRepo, git } from "../src/tools/git.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "grandma-llm-test-"));
await ensureRepo(ws);
// The Agent's session store lives in the log DB under logs/.
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

const tools = new ToolRegistry(ws, ["git", "cat", "ls", "echo"]);
const models = await loadModels();
const agent = new Agent({ models, workspace: ws, tools });

const strong = models.strong ?? models.default ?? Object.values(models)[0];
console.log(`model: ${strong?.model} @ ${strong?.baseURL}`);

const emitted: string[] = [];
const result = await agent.run(
  "test:1",
  "Create a file called hello.txt containing exactly: hello from the agent. Then tell me when done.",
  (v) => { if (typeof v === "string") emitted.push(v); },
);
console.log("emitted:", emitted);

assert.equal(result.status, "waiting", "should pause at .human()");
const lastEmit = emitted[emitted.length - 1];
assert.ok(lastEmit, `expected an emitted response, got: ${JSON.stringify(emitted)}`);
console.log("agent says:", lastEmit);

const content = await fs.readFile(path.join(ws, "hello.txt"), "utf8").catch(() => null);
assert.ok(content?.includes("hello from the agent"), `file content wrong: ${JSON.stringify(content)}`);
const log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(write_file\): hello\.txt/, "auto-commit missing");

await fs.rm(ws, { recursive: true, force: true });
console.log("llm-test: PASS — tool call executed, file written, git commit created");
