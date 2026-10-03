import fs from "node:fs/promises";
import path from "node:path";
// @ts-ignore — grandma-kat ships no .d.ts files.
import { createLogger, runLogTools } from "grandma-kat";
import { config } from "./config.js";
import { ensureRepo, ensureWorkspaceGitignore } from "./tools/git.js";
import { ToolRegistry } from "./tools/index.js";
import { Agent, checkLlmEntry } from "./agent.js";
import { loadModels } from "./models.js";
import { createBot } from "./bot.js";
import { checkStt } from "./stt.js";
import { startAdmin, getSelectedPattern, getSelectedRef, telegramFollowKey, remoteTurnStart, remoteTurnEvent, remoteTurnEnd } from "./admin.js";
import type { Bot } from "grammy";
import { loadAppTools } from "./app-tools.js";
import { SecretsStore } from "./secrets.js";
import { makeTreeContext } from "./tree-context.js";
import { KEEP_VERSIONS, scanTreeVersions, pruneVersions } from "./tree-versions.js";

async function main(): Promise<void> {
  await fs.mkdir(config.workspaceDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });
  await ensureRepo(config.workspaceDir);
  // The grandma-kat SQLite log lives under the workspace, not the project
  // root — it contains user prompts/responses. Create the dir up front and
  // exclude it from the workspace's git history.
  await fs.mkdir(path.join(config.workspaceDir, "logs"), { recursive: true });
  await ensureWorkspaceGitignore(config.workspaceDir, [
    "logs/grandma-kat.db*",
    "logs/sessions.json",
    "logs/web-turns.json",
    "logs/web-settings.json",
    "assets/inbox/",
  ]);

  const secrets = new SecretsStore(config.secretsDb);
  const appTools = [
    ...(await loadAppTools(config.workspaceDir, secrets)),
    // KAT's own run-log reader, so a tree can recall what happened in past
    // sessions (grandma-kat/src/runlog.mjs). Same DB as katLogger below.
    ...runLogTools(path.join(config.workspaceDir, "logs", "grandma-kat.db")),
  ];
  console.log(`[app-tools] loaded ${appTools.length} tool(s) from workspace apps`);
  const tools = new ToolRegistry(
    config.workspaceDir,
    config.allowedCommands,
    config.exaApiKey,
    config.sqliteLockPath || undefined,
    appTools,
  );
  const models = await loadModels();
  // Shared SQLite + console logger. Passing a logger object (instead of the
  // db path string) lets Agent.run() wrap it per-run so the web UI can
  // stream tree events live.
  const katLogger = createLogger(path.join(config.workspaceDir, "logs/grandma-kat.db"), "info");
  // patternName/patternRef are getters so the admin UI's selector can switch
  // the active tree and version for NEW sessions at runtime; running sessions
  // stay pinned to the version they started on.
  // Host context for tree registers (grandma-kat runtime.context): an app tree
  // reaches the app-secrets store through it, so an app can expose only a tree.
  const treeContext = {
    secret: (app: string, name: string) => secrets.get(app, name)?.content ?? null,
    secretText: (app: string, name: string) =>
      secrets.get(app, name)?.content?.toString("utf8") ?? null,
    requireSecret: (app: string, name: string) => {
      const bytes = secrets.get(app, name)?.content;
      if (!bytes) {
        throw new Error(
          `secret "${name}" for app "${app}" is missing — upload it in the WebUI: settings page → App secrets`,
        );
      }
      return bytes.toString("utf8");
    },
    listSecrets: (app: string) =>
      secrets.list(app).map((s) => ({ name: s.name, updatedAt: s.updatedAt, size: s.size })),
    trees: makeTreeContext(config.workspaceDir),
  };
  const agent = new Agent({ models, workspace: config.workspaceDir, tools, logger: katLogger, patternName: getSelectedPattern, patternRef: getSelectedRef, context: treeContext });

  // Prune old snapshots once at startup. Prod and any version a live session
  // still pins are never removed, so a restart cannot strand a conversation.
  try {
    for (const tree of await scanTreeVersions(config.workspaceDir)) {
      await pruneVersions(
        config.workspaceDir,
        tree.logical,
        KEEP_VERSIONS,
        agent.pinnedVersions(tree.logical),
      );
    }
  } catch (err) {
    console.warn(`[tree-versions] startup prune skipped: ${err instanceof Error ? err.message : err}`);
  }

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
  // projectDir/envPath/workspaceDir must come from the RUNNING config —
  // admin's HOME-based defaults break on hosts where the checkout isn't
  // at ~/grandpa-bob-bot (env editor, models probe and health would read
  // nonexistent files).
  const adminPort = parseInt(process.env.ADMIN_PORT || "8080", 10);
  const envPath = config.envFile;
  // Late-bound Telegram handle: the admin is constructed before the bot,
  // but a webui-run turn into a Telegram conversation must reach the phone.
  let telegramBot: Bot | undefined;
  startAdmin({
    port: adminPort,
    agent,
    telegramNotify: async (key, text) => {
      const [chatId, threadId] = key.split(":");
      try {
        await telegramBot?.api.sendMessage(
          Number(chatId),
          text,
          threadId && threadId !== "0" ? { message_thread_id: Number(threadId) } : {},
        );
      } catch (err) {
        console.warn("[admin] telegram notify failed:", err);
      }
    },
    projectDir: process.cwd(),
    envPath,
    workspaceDir: config.workspaceDir,
    secrets,
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
    turnRecorder: { start: remoteTurnStart, event: remoteTurnEvent, end: remoteTurnEnd },
    allowedUserIds: config.allowedUserIds,
    workspace: config.workspaceDir,
    envPath,
    tmpDir: config.tmpDir,
    sttBackend: config.sttBackend,
    whisperUrl: config.whisperUrl,
    sherpaUrl: config.sherpaUrl,
    sttLanguage: config.sttLanguage,
    models,
    agent,
    telegramFollowKey,
  });

  telegramBot = bot;
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
