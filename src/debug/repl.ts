import readline from "node:readline";
import path from "node:path";
import fs from "node:fs/promises";
import "dotenv/config";
import { config } from "../config.js";
import { ensureRepo, ensureWorkspaceGitignore } from "../tools/git.js";
import { ToolRegistry } from "../tools/index.js";
import { Agent, checkLlmEntry } from "../agent.js";
import { loadModels } from "../models.js";
// @ts-ignore — grandma-kat ships no .d.ts files.
import { createLogger } from "grandma-kat";
import { EventLogger, type KatEvent } from "./event-logger.js";
import { formatEvent, formatAgentOutput } from "./format.js";

const CONV_KEY = "cli:repl";

/**
 * Combine grandma-kat's logger (SQLite + Console) with the EventLogger
 * (real-time events for the TUI). Delegates checkpoint operations to
 * the base logger — EventLogger only handles log().
 */
function combineLoggers(base: { log(e: KatEvent): number | void; close(): void; saveCheckpoint: Function; getCheckpoint: Function; deleteCheckpoint: Function; getEvents: Function }, eventLogger: EventLogger) {
  return {
    log(event: KatEvent): number | void {
      const seq = base.log(event);
      eventLogger.log(event);
      return seq;
    },
    close() {
      base.close();
      eventLogger.close();
    },
    saveCheckpoint(...args: unknown[]) { return (base.saveCheckpoint as Function)(...args); },
    getCheckpoint(...args: unknown[]) { return (base.getCheckpoint as Function)(...args); },
    deleteCheckpoint(...args: unknown[]) { return (base.deleteCheckpoint as Function)(...args); },
    getEvents(...args: unknown[]) { return (base.getEvents as Function)(...args); },
  };
}

async function main(): Promise<void> {
  const debugLevel = process.argv.includes("--debug") ? "debug" : "info";

  await fs.mkdir(config.workspaceDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });
  await ensureRepo(config.workspaceDir);
  await fs.mkdir(path.join(config.workspaceDir, "logs"), { recursive: true });
  await ensureWorkspaceGitignore(config.workspaceDir, ["logs/grandma-kat.db*"]);

  const tools = new ToolRegistry(config.workspaceDir, config.allowedCommands, config.exaApiKey);
  const models = await loadModels();

  // Grandma-kat handles SQLite persistence. Console output via EventLogger below.
  const dbPath = path.join(config.workspaceDir, "logs/grandma-kat.db");
  const baseLogger = createLogger(dbPath, 'none');

  // EventLogger adds real-time events for the TUI.
  const eventLogger = new EventLogger();

  // Combine: fan out log(), delegate checkpoints to baseLogger.
  const logger = combineLoggers(baseLogger, eventLogger);

  const agent = new Agent({
    models,
    workspace: config.workspaceDir,
    tools,
    logger,
    logLevel: "none", // Prevent knit.mjs from creating a second ConsoleLogger.
  });

  // Subscribe to events and print formatted output.
  eventLogger.on("event", (event: KatEvent) => {
    // Filter by level: debug shows everything, info shows a subset.
    if (debugLevel === "info") {
      const INFO_KINDS = new Set(["llm_call", "tool_call", "tool_result", "flow", "memory", "emit", "human"]);
      if (!INFO_KINDS.has(event.kind)) return;
    }
    const lines = formatEvent(event);
    for (const line of lines) {
      process.stderr.write(line + "\n");
    }
  });

  // Collect agent output from onEmit.
  let lastOutput = "";
  const onEmit = (value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text) lastOutput = text;
  };

  // Banner.
  process.stderr.write("\n");
  process.stderr.write(`\x1b[1mgrandpa-bob debug REPL\x1b[0m\n`);
  process.stderr.write(`workspace : ${config.workspaceDir}\n`);
  process.stderr.write(`log level : ${debugLevel}\n`);
  for (const [name, m] of Object.entries(models)) {
    const reachable = await checkLlmEntry(m.baseURL, m.apiKey, m.protocol);
    const status = reachable ? "\x1b[32mreachable\x1b[0m" : "\x1b[31mNOT reachable\x1b[0m";
    process.stderr.write(`llm ${name.padEnd(6)} : ${m.model} @ ${m.baseURL} (${status})\n`);
  }
  process.stderr.write(`\n`);

  // Start the tree — it pauses at .human() immediately.
  process.stderr.write(`\x1b[90m[starting tree…]\x1b[0m\n`);
  await agent.run(CONV_KEY, "", onEmit);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36m> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/clear") {
      agent.clear(CONV_KEY);
      process.stderr.write("\x1b[33mconversation cleared\x1b[0m\n");
      process.stderr.write("\x1b[90mrestarting tree…\x1b[0m\n");
      await agent.run(CONV_KEY, "", onEmit);
      rl.prompt();
      return;
    }

    if (input === "/quit" || input === "/exit") {
      rl.close();
      return;
    }

    lastOutput = "";
    try {
      await agent.run(CONV_KEY, input, onEmit);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\x1b[31merror: ${msg}\x1b[0m\n`);
      if (err instanceof Error && err.stack) {
        process.stderr.write(`\x1b[90m${err.stack.split("\n").slice(1, 4).join("\n")}\x1b[0m\n`);
      }
    }

    // Print agent output after the tree pauses.
    if (lastOutput) {
      const lines = formatAgentOutput(lastOutput);
      for (const line of lines) {
        process.stdout.write(line + "\n");
      }
    } else {
      process.stderr.write(`\x1b[90m(no output — check LLM reachability above)\x1b[0m\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    logger.close();
    process.stderr.write("\nbye\n");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
