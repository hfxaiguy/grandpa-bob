import fs from "node:fs/promises";
import path from "node:path";
// @ts-ignore — grandma-kat ships no .d.ts files.
import { createLogger } from "grandma-kat";
import { config } from "./config.js";
import { ensureRepo, ensureWorkspaceGitignore } from "./tools/git.js";
import { ToolRegistry } from "./tools/index.js";
import { Agent, checkLlmEntry } from "./agent.js";
import { loadModels } from "./models.js";
import { createBot } from "./bot.js";
import { checkStt } from "./stt.js";
import { startAdmin, getSelectedPattern } from "./admin.js";

async function main(): Promise<void> {
  await fs.mkdir(config.workspaceDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });
  await ensureRepo(config.workspaceDir);
  // The grandma-kat SQLite log lives under the workspace, not the project
  // root — it contains user prompts/responses. Create the dir up front and
  // exclude it from the workspace's git history.
  await fs.mkdir(path.join(config.workspaceDir, "logs"), { recursive: true });
  await ensureWorkspaceGitignore(config.workspaceDir, ["logs/grandma-kat.db*", "assets/inbox/"]);

  const tools = new ToolRegistry(
    config.workspaceDir,
    config.allowedCommands,
    config.exaApiKey,
    config.sqliteLockPath || undefined,
  );
  const models = await loadModels();
  // Shared SQLite + console logger. Passing a logger object (instead of the
  // db path string) lets Agent.run() wrap it per-run so the web UI can
  // stream tree events live.
  const katLogger = createLogger(path.join(config.workspaceDir, "logs/grandma-kat.db"), "info");
  // patternName is a getter so the admin UI's dropdown can switch it at runtime.
  const agent = new Agent({ models, workspace: config.workspaceDir, tools, logger: katLogger, patternName: getSelectedPattern });

  const modelReachable = await Promise.all(
    Object.entries(models).map(async ([name, m]) => [name, await checkLlmEntry(m.baseURL, m.apiKey, m.protocol)] as const),
  );
  for (const [name, ok] of modelReachable) {
    if (!ok) {
      console.warn(
        `[warn] LLM "${name}" (${models[name].model} @ ${models[name].baseURL}) not reachable.`,
      );
    }
  }

  const sttUrl = config.sttBackend === "sherpa" ? config.sherpaUrl : config.whisperUrl;
  const sttOk = await checkStt(config.sttBackend, config.whisperUrl, config.sherpaUrl);
  if (!sttOk) {
    console.warn(
      `[warn] ${config.sttBackend}-server not reachable at ${sttUrl} — voice messages will fail.`,
    );
  }

  // Start the web UI: chat front page (/) + settings page (/settings).
  const adminPort = parseInt(process.env.ADMIN_PORT || "8080", 10);
  startAdmin({
    port: adminPort,
    agent,
    stt: {
      backend: config.sttBackend,
      whisperUrl: config.whisperUrl,
      sherpaUrl: config.sherpaUrl,
      tmpDir: config.tmpDir,
      language: config.sttLanguage || undefined,
    },
  });

  const bot = createBot({
    token: config.telegramToken,
    allowedUserIds: config.allowedUserIds,
    workspace: config.workspaceDir,
    tmpDir: config.tmpDir,
    sttBackend: config.sttBackend,
    whisperUrl: config.whisperUrl,
    sherpaUrl: config.sherpaUrl,
    sttLanguage: config.sttLanguage,
    models,
    agent,
  });

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  await bot.start({
    onStart: (me) => {
      console.log(`grandpa-bob-bot up as @${me.username}`);
      console.log(`workspace : ${config.workspaceDir} (git auto-commit on)`);
      for (const [name, m] of Object.entries(models)) {
        const reachable = modelReachable.find(([n]) => n === name)?.[1];
        console.log(`llm ${name.padEnd(6)} : ${m.model} @ ${m.baseURL} ${reachable ? "(reachable)" : "(NOT reachable)"}`);
      }
      console.log(`stt       : ${config.sttBackend} @ ${sttUrl} ${sttOk ? "(reachable)" : "(NOT reachable)"}`);
      console.log(`users     : ${[...config.allowedUserIds].join(", ")}`);
    },
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
