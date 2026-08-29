import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`FATAL: missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return v.trim();
}

const root = process.cwd();

const DEFAULT_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "find", "rg", "grep", "pwd",
  "git", "mkdir", "touch", "date", "file", "stat", "du", "df",
  "diff", "which", "echo", "sort", "uniq",
  "comms",
];

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUserIds: new Set(
    required("ALLOWED_USER_IDS")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  ),
  workspaceDir: path.resolve(root, process.env.WORKSPACE_DIR ?? "workspace"),
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
  /** Exa Search API key for the exa_search web search tool (optional — tool errors if unset). */
  exaApiKey: process.env.EXO_API_KEY ?? "",
  /**
   * Absolute path to a single SQLite database the agent's sql tools
   * (sql_query read-only, sql_write read-write) are locked to. When set, the
   * agent can only touch that one file and can never reach any other
   * database. Leave empty for free choice of any .db inside the workspace
   * (sql_query is always read-only regardless).
   */
  sqliteLockPath: process.env.SQLITE_LOCK_PATH ? path.resolve(process.env.SQLITE_LOCK_PATH) : "",
  allowedCommands: (process.env.ALLOWED_COMMANDS ?? DEFAULT_COMMANDS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxToolIterations: 12,
};

export type Config = typeof config;
