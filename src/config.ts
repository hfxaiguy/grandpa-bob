/**
 * Channel configuration — the standalone-only process reads only what a
 * pass-through channel needs: the Telegram token/allowlist, STT backends and
 * the .env location. Workspace/shell/tool config died with the Node agent
 * host; the browser configures itself (settings page, workspace models.json).
 */
import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import { resolveEnvFile } from "./env-file.js";

const root = process.cwd();

// Precedence: ENV_FILE override > ~/.bobkat/.env > <project>/.env.
const envFile = resolveEnvFile({ root, home: os.homedir(), override: process.env.ENV_FILE });
dotenv.config({ path: envFile });

export const config = {
  // One source of truth for the config file (editor, docs, tests).
  envFile,
  // Optional: the combined process always boots; without a token the bot
  // stays off and only the mailbox/bridge API is served.
  telegramToken: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
  allowedUserIds: new Set(
    (process.env.ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  ),
  tmpDir: path.resolve(root, "tmp"),
  /** STT backend: "whisper" (whisper.cpp), "sherpa" (sherpa-onnx online websocket), or "parakeet" (sherpa-onnx offline websocket + NeMo parakeet). */
  sttBackend: (() => {
    const b = (process.env.STT_BACKEND ?? "whisper").toLowerCase();
    return (b === "sherpa" || b === "parakeet" ? b : "whisper") as "whisper" | "sherpa" | "parakeet";
  })(),
  whisperUrl: (process.env.WHISPER_URL ?? "http://127.0.0.1:8178").replace(/\/$/, ""),
  sherpaUrl: (process.env.SHERPA_URL ?? "http://127.0.0.1:8178").replace(/\/$/, ""),
  /** Spoken language for STT (e.g. "en", "de", "auto"). Empty = server default ("en"). */
  sttLanguage: process.env.STT_LANGUAGE ?? process.env.WHISPER_LANGUAGE ?? "",
};

export type Config = typeof config;
