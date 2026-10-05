// src/admin.ts
//
// Web UI for grandpa-bob. Starts an HTTP server on ADMIN_PORT (default
// 8080) with two pages:
//
//   /          — chat front page: talk to the agent by text or voice
//                (audio is recorded in the browser and transcribed
//                locally via the configured STT backend). Every grandma-
//                kat tree event streams live over SSE and is rendered as
//                steps under the message.
//   /settings  — admin page: .env credentials, bot/sherpa tmux status,
//                log tails, bot restart, workspace git sync, tree
//                patterns, workspace file browser.
//
// Access from the phone's browser:
//   http://127.0.0.1:8080
// Or from the laptop (same Wi-Fi):
//   http://<phone-ip>:8080
//
// Note: browser microphone access (voice input) requires a secure
// context — it works on http://localhost but not on plain-http LAN IPs.

import http from "node:http";
import { readFile, writeFile, readdir, stat, mkdir, unlink } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Agent } from "./agent.js";
import { checkLlmEntry } from "./agent.js";
import { loadModels } from "./models.js";
import { listSecretRequests, validSecretName, type SecretsStore } from "./secrets.js";
import {
  transcribeAudioBytes,
  convertToWav,
  transcribeWavStreaming,
  wavDurationSeconds,
  type SttBackendOptions,
} from "./stt.js";
import { TreeLogReader, logDbPath } from "./treeLog.js";
import { DEFAULT_PATTERN, loadPattern, splitTreeRef } from "./pattern-loader.js";
import { PATTERNS_DIR_NAME, listPatterns, listTreeSources } from "./tree-sources.js";
import {
  KEEP_VERSIONS,
  scanTreeVersions,
  snapshotTree,
  promoteTree,
  pruneVersions,
  resolveTreeEntry,
} from "./tree-versions.js";
import { serializeTree } from "./tree-serialize.js";
import { attachmentPrompt, saveAttachment, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { createNodePlatform } from "./platform/node.js";
import { applyDatabaseDumps, withSyncLock, writeDatabaseDumps } from "./db-sync.js";

/** Secret config files are small (credentials, JSON, keys). */
const MAX_SECRET_BYTES = 1024 * 1024;
import { emitValue, type EmitButton } from "./util/emit-text.js";
import { buildChatHtml, buildSettingsHtml } from "./ui/pages.js";

const execFileAsync = promisify(execFile);

// ── config ────────────────────────────────────────────────────────────
export interface AdminConfig {
  port: number;
  homeDir: string;
  projectDir: string;
  envPath: string;
  workspaceDir: string;
  botLog: string;
  sherpaLog: string;
  botSession: string;
  sherpaSession: string;
}

function defaultConfig(): AdminConfig {
  const HOME = process.env.HOME || "/data/data/com.termux/files/home";
  const PROJECT_DIR = process.env.PROJECT_DIR || `${HOME}/grandpa-bob-bot`;
  const WORKSPACE_DIR = process.env.WORKSPACE_DIR || `${HOME}/grandma-workspace`;
  return {
    port: parseInt(process.env.ADMIN_PORT || "8080", 10),
    homeDir: HOME,
    projectDir: PROJECT_DIR,
    envPath: `${PROJECT_DIR}/.env`,
    workspaceDir: WORKSPACE_DIR,
    botLog: `${HOME}/bot.log`,
    sherpaLog: `${HOME}/sherpa.log`,
    botSession: "bot",
    sherpaSession: "sherpa",
  };
}

// ── tmux helper ───────────────────────────────────────────────────────
async function tmux(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("tmux", args, { timeout: 5000 });
    return { ok: true, out: stdout, err: stderr };
  } catch (e: any) {
    return { ok: false, out: e.stdout || "", err: e.stderr || e.message };
  }
}

// ── file helpers ──────────────────────────────────────────────────────
async function readTail(file: string, lines = 60): Promise<string> {
  try {
    const data = await readFile(file, "utf8");
    return data.split("\n").slice(-lines).join("\n");
  } catch (e: any) {
    return `(unable to read ${file}: ${e.message})`;
  }
}

async function readEnv(envPath: string): Promise<Record<string, string> | null> {
  try {
    const data = await readFile(envPath, "utf8");
    const out: Record<string, string> = {};
    for (const line of data.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Merge `updates` into the .env file, preserving comments and line order.
 * A value of `null` removes the key entirely. New keys are appended at the
 * end. The parsed form is a flat `KEY=value` file — values are stored
 * verbatim, secrets are not logged.
 */
export async function writeEnv(envPath: string, updates: Record<string, string | null>) {
  let lines: string[] = [];
  try {
    lines = (await readFile(envPath, "utf8")).split("\n");
  } catch { /* no existing file */ }
  const pending = new Map(Object.entries(updates));
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1])!;
      pending.delete(m[1]);
      if (v === null) continue; // key removed
      out.push(`${m[1]}=${v}`);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of pending) {
    if (v !== null) out.push(`${k}=${v}`); // new keys
  }
  await writeFile(envPath, out.join("\n").replace(/\n+$/, "") + "\n", { mode: 0o600 });
}

// ── service health ────────────────────────────────────────────────────
// Real reachability probes instead of the old tmux-session guesswork
// (the desktop runs have no tmux at all). Each probe answers
// up | down | "n/a" (not configured) plus a one-line detail.
export interface ServiceState {
  name: string;
  up: boolean | null;
  detail: string;
}

async function fetchProbe(url: string, headers: Record<string, string>, timeoutMs = 3000): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    return res.status;
  } catch {
    return null;
  }
}

async function probeTelegram(token: string): Promise<ServiceState> {
  if (!token) return { name: "telegram", up: null, detail: "no bot token configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
    return data?.ok
      ? { name: "telegram", up: true, detail: "@" + (data.result?.username ?? "?") }
      : { name: "telegram", up: false, detail: `getMe failed (HTTP ${res.status})` };
  } catch (e) {
    return { name: "telegram", up: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function probeVoice(stt: SttBackendOptions | undefined): Promise<ServiceState> {
  if (!stt) return { name: "voice", up: null, detail: "not configured" };
  const base = (stt.backend === "sherpa" || stt.backend === "parakeet" ? stt.sherpaUrl : stt.whisperUrl).replace(/\/$/, "");
  const host = new URL(base).host;
  // Any HTTP answer at all (even 404) means the server is listening.
  for (const p of ["/health", "/v1/models", "/"]) {
    const status = await fetchProbe(base + p, {}, 2500);
    if (status !== null) return { name: "voice", up: true, detail: `${stt.backend} @ ${host}` };
  }
  return { name: "voice", up: false, detail: `${stt.backend} @ ${host} unreachable` };
}

let modelsWarned = false;
async function probeLlm(projectDir: string): Promise<ServiceState> {
  let registry: Record<string, { baseURL: string; apiKey: string; protocol?: string }> = {};
  try {
    registry = await loadModels(projectDir);
  } catch (e) {
    if (!modelsWarned) { modelsWarned = true; console.warn("[status] models.json unreadable:", e); }
    return { name: "llm", up: null, detail: "models not configured" };
  }
  const bases = [...new Map(Object.values(registry).map((m) => [m.baseURL, m])).entries()];
  if (!bases.length) return { name: "llm", up: null, detail: "no models configured" };
  const results = await Promise.all(
    bases.map(async ([baseURL, m]) => ({
      host: new URL(baseURL).host,
      ok: await checkLlmEntry(baseURL, m.apiKey, m.protocol, 3000),
    })),
  );
  const bad = results.filter((r) => !r.ok);
  return {
    name: "llm",
    up: bad.length === 0,
    detail: bad.length
      ? `${results.length - bad.length}/${results.length} reachable — down: ${bad.map((b) => b.host).join(", ")}`
      : `${results.length} endpoint${results.length === 1 ? "" : "s"} reachable: ${results.map((r) => r.host).join(", ")}`,
  };
}

let servicesCache: { at: number; services: ServiceState[] } | null = null;

async function serviceStatus(
  config: AdminConfig,
  stt: SttBackendOptions | undefined,
  env: Record<string, string>,
): Promise<ServiceState[]> {
  if (servicesCache && Date.now() - servicesCache.at < 5000) return servicesCache.services;
  const [telegram, voice, llm] = await Promise.all([
    probeTelegram(env.TELEGRAM_BOT_TOKEN || ""),
    probeVoice(stt),
    probeLlm(config.projectDir),
  ]);
  const services = [telegram, voice, llm];
  servicesCache = { at: Date.now(), services };
  return services;
}

// ── tmux status ───────────────────────────────────────────────────────
async function tmuxStatus(botSession: string, sherpaSession: string) {
  const r = await tmux(["list-sessions", "-F", "#{session_name}"]);
  const sessions = new Set<string>();
  if (r.ok) for (const line of r.out.split("\n")) if (line.trim()) sessions.add(line.trim());
  return {
    bot: sessions.has(botSession),
    sherpa: sessions.has(sherpaSession),
  };
}

/**
 * Restart the bot tmux session.
 *
 * The admin server runs INSIDE the bot's tmux session, so killing that
 * session from this process would SIGHUP ourselves before the new session
 * is created — the bot would die and never come back. Instead the whole
 * restart runs in a detached child (own process group, unref'd), which
 * survives the kill.
 *
 * Sequence: drop any leftover temp session, create the new session under a
 * temp name, give the HTTP response time to flush, THEN kill the old
 * session, then rename the new one into place.
 */
function restartBot(projectDir: string, botSession: string) {
  const newName = `${botSession}-new`;
  const sessionCmd = `sh -c "cd ${projectDir} && exec npm run dev 2>&1 | tee ~/bot.log"`;
  const script = [
    `tmux kill-session -t ${newName} 2>/dev/null;`,
    `tmux new-session -d -s ${newName} '${sessionCmd}';`,
    `sleep 1;`,
    `tmux kill-session -t ${botSession} 2>/dev/null;`,
    `tmux rename-session -t ${newName} ${botSession}`,
  ].join(" ");
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
}

// ── git sync ────────────────────────────────────────────────────────
async function gitSync(workspaceDir: string, direction: "push" | "pull", local = "master", remote = local) {
  const args = direction === "pull"
    ? ["-C", workspaceDir, "pull", "--ff-only", "sync", remote]
    : ["-C", workspaceDir, "push", "sync", `${local}:${remote}`];
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { timeout: 30000 });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (e: any) {
    return { ok: false, output: (e.stdout || "") + (e.stderr || e.message) };
  }
}

// ── git commit ───────────────────────────────────────────────────────
async function gitCommitAll(workspaceDir: string, message: string) {
  try {
    const status = await execFileAsync("git", ["-C", workspaceDir, "status", "--porcelain"], { timeout: 15000 });
    if (!status.stdout.trim()) {
      return { ok: true, committed: false, output: "nothing to commit (workspace clean)", hash: null };
    }
    await execFileAsync("git", ["-C", workspaceDir, "add", "-A"], { timeout: 15000 });
    await execFileAsync("git", ["-C", workspaceDir, "commit", "-m", message], { timeout: 15000 });
    const hash = (await execFileAsync("git", ["-C", workspaceDir, "rev-parse", "--short", "HEAD"], { timeout: 10000 })).stdout.trim();
    return { ok: true, committed: true, output: status.stdout.trim(), hash };
  } catch (e: any) {
    return { ok: false, committed: false, output: (e.stdout && e.stdout + "\n") + (e.stderr || e.message) };
  }
}

// ── pattern registry ──────────────────────────────────────────────────
// Discovery lives in tree-sources.ts (shared with the agent's tree tools);
// re-exported here for the web UI and the bot commands.
export { listTreeSources };

async function readPattern(workspaceDir: string, name: string) {
  try {
    return await readFile(path.join(workspaceDir, PATTERNS_DIR_NAME, `${name}.mjs`), "utf8");
  } catch {
    return null;
  }
}

async function writePattern(workspaceDir: string, name: string, content: string) {
  const dir = path.join(workspaceDir, PATTERNS_DIR_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.mjs`), content, { mode: 0o644 });
}

async function deletePattern(workspaceDir: string, name: string) {
  try { await unlink(path.join(workspaceDir, PATTERNS_DIR_NAME, `${name}.mjs`)); } catch {}
}

// ── active tree pattern ───────────────────────────────────────────────
// Which patterns/*.mjs the agent loads on each turn. Kept in process
// memory (mutable at runtime without a restart) and persisted to .env as
// TREE_PATTERN so it survives restarts. The Telegram bot and the web chat
// both resolve the pattern through getSelectedPattern(), so a switch takes
// effect on the next turn of both.
let selectedPattern = process.env.TREE_PATTERN || DEFAULT_PATTERN;

/** Current active tree pattern name (filename without .mjs). */
export function getSelectedPattern(): string {
  return selectedPattern;
}

/** Set the active tree pattern name (in memory; persists via /api/pattern). */
export function setSelectedPattern(name: string): void {
  selectedPattern = name;
}

// The active VERSION ref for new sessions ("v1", "draft"; "" = prod default).
// Separate from selectedPattern so switching version never drops sessions —
// only new sessions adopt it. Persisted to .env as TREE_REF.
let selectedRef = process.env.TREE_REF || "";

/** Active version ref for new sessions, or undefined for the prod default. */
export function getSelectedRef(): string | undefined {
  return selectedRef || undefined;
}

/** Set the active version ref (in memory; persists via /api/tree/version/active). */
export function setSelectedRef(ref: string): void {
  selectedRef = ref === "prod" ? "" : ref;
}

// ── file browser ──────────────────────────────────────────────────────
/**
 * The secret store and its journals are never browsable/servable — the
 * store normally lives OUTSIDE the workspace (SECRETS_DB), but a custom
 * path inside it must stay unreachable too.
 */
function isSecretStorePath(resolved: string): boolean {
  const db = secretsStore?.dbPath;
  if (!db) return false;
  return resolved === db || resolved.startsWith(db + "-");
}

function safePath(workspaceDir: string, p: string) {
  const resolved = path.resolve(workspaceDir, p || ".");
  if (!resolved.startsWith(workspaceDir)) throw new Error("path outside workspace");
  if (isSecretStorePath(resolved)) {
    throw new Error("the secret store is not accessible through the file browser");
  }
  return resolved;
}

async function listFiles(workspaceDir: string, dir: string) {
  const resolved = safePath(workspaceDir, dir);
  const entries = await readdir(resolved, { withFileTypes: true });
  const out: { name: string; isDir: boolean; size: number; mtime: string | null }[] = [];
  for (const e of entries) {
    const full = path.join(resolved, e.name);
    if (isSecretStorePath(full)) continue;
    const s = await stat(full).catch(() => null);
    out.push({ name: e.name, isDir: e.isDirectory(), size: s ? s.size : 0, mtime: s ? s.mtime.toISOString() : null });
  }
  out.sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
  return out;
}

async function saveFile(workspaceDir: string, p: string, content: Buffer | string) {
  const resolved = safePath(workspaceDir, p);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, { mode: 0o644 });
}

async function deleteFile(workspaceDir: string, p: string) {
  await unlink(safePath(workspaceDir, p));
}

// ── multipart parser ─────────────────────────────────────────────────
function readMultipart(req: http.IncomingMessage, boundary: string) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const str = buf.toString("latin1");
      const parts = str.split("--" + boundary).slice(1, -1);
      const result: Record<string, any> = {};
      for (const part of parts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        const header = part.slice(0, headerEnd);
        const body = part.slice(headerEnd + 4, part.length - 2);
        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        if (filenameMatch) {
          result[name] = { filename: filenameMatch[1], content: Buffer.from(body, "latin1") };
        } else {
          result[name] = body;
        }
      }
      resolve(result);
    });
    req.on("error", reject);
  });
}

function readBody(req: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── web chat: turns, events, SSE ─────────────────────────────────────
// The chat front page talks to the agent under a single conversation key.
// Turns are strictly serialized (like the bot's per-topic queue) and every
// grandma-kat event logged during a turn is sanitized (the raw events embed
// the full message history — far too big to stream), kept in a small
// in-memory history, and broadcast to connected browsers over SSE.

const WEB_KEY = "web:chat";
// Current memory values for the web chat's tree, resolved by scope. A slot
// is identified by (scope_id, name): .memoryUpdate() deep in a branch writes
// to the slot's *declaring* scope, so keying by scope_id collapses updates
// onto the .memory() node instead of leaving it stuck at its seed value.
const webMemoryValues = new Map<string, unknown>(); // `${scopeId}/${name}` -> value
const webMemoryPaths = new Map<string, Set<string>>(); // slot key -> node paths that write to it
const MAX_TURNS_KEPT = 20;
const MAX_EVENT_STR = 400;

interface SanitizedEvent {
  kind: string;
  branch_path: string;
  iteration: number;
  scope_id: number | null;
  content: Record<string, unknown> | null;
  ts: number;
}

interface TurnRecord {
  turnId: string;
  input: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "done" | "error";
  error: string | null;
  output: string | null;
  /** Chat-facing text of each emit, in order — one bubble per entry. */
  emits?: string[] | null;
  /** Channel level per emit (parallel to `emits`): "machine", or null. */
  levels?: (string | null)[] | null;
  /** Buttons of the last emit that carried any; null when none ever did. */
  buttons?: EmitButton[] | null;
  events: SanitizedEvent[];
}

// Every web session (`web:<id>`) owns a label and a bounded turn buffer.
// Sessions are NEVER auto-resumed after a restart: `activeSession` starts
// null and the chat page shows a session picker until the user explicitly
// resumes one (loads its history + arms the stored continuation for the
// next message) or starts a new one. This keeps a stale/broken checkpoint
// from hanging the first turn after a refresh.
interface WebSession {
  label: string;
  /** Tree pattern this session last ran under (for the picker). */
  pattern: string;
  updatedAt: number;
  turns: TurnRecord[];
}
const sessionTurns = new Map<string, WebSession>();
let activeSession: string | null = null;
const MAX_SESSIONS_KEPT = 10;

// Persisted copy of `sessionTurns` so chat history survives bot restarts.
// Set inside startAdmin (config isn't available at module scope).
let webTurnsPath = "";

function slimTurn(t: TurnRecord): TurnRecord {
  return {
    ...t,
    // Live raw `messages` attached to events (full prompt + system text)
    // are session telemetry already in grandma-kat.db — no reason to
    // duplicate them on disk.
    events: t.events.map((ev) => {
      if (!ev.content || !("messages" in ev.content)) return ev;
      const content = { ...ev.content };
      delete content.messages;
      return { ...ev, content };
    }),
  };
}

function saveTurns(): void {
  if (!webTurnsPath) return;
  try {
    fs.mkdirSync(path.dirname(webTurnsPath), { recursive: true });
    const out: Record<string, { label: string; pattern: string; updatedAt: number; turns: unknown[] }> = {};
    for (const [key, s] of sessionTurns) {
      out[key] = {
        label: s.label,
        pattern: s.pattern,
        updatedAt: s.updatedAt,
        turns: s.turns.filter((t) => t.status !== "running").map(slimTurn),
      };
    }
    const tmp = webTurnsPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, webTurnsPath);
  } catch (e) {
    console.warn("[admin] failed to save web turns:", e instanceof Error ? e.message : e);
  }
}

function loadTurns(): void {
  if (!webTurnsPath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(webTurnsPath, "utf8"));
    // v1 was a bare array of turns for the single implicit `web:chat`
    // session; v2 is a map of sessions. Migrate transparently.
    const entries: [string, unknown][] = Array.isArray(raw)
      ? [[WEB_KEY, { label: "", pattern: "", updatedAt: 0, turns: raw }]]
      : raw && typeof raw === "object"
        ? Object.entries(raw)
        : [];
    for (const [key, val] of entries) {
      const v = val as Partial<WebSession>;
      const turns = Array.isArray(v?.turns)
        ? v.turns.filter((t: TurnRecord) => t && t.status !== "running").slice(-MAX_TURNS_KEPT)
        : [];
      if (!turns.length && !v?.label) continue;
      sessionTurns.set(String(key), {
        label: typeof v?.label === "string" ? v.label : "",
        pattern: typeof v?.pattern === "string" ? v.pattern : "",
        updatedAt: Number(v?.updatedAt) || (turns.at(-1)?.endedAt ?? turns.at(-1)?.startedAt) || 0,
        turns,
      });
    }
    if (sessionTurns.size) console.log(`[admin] restored ${sessionTurns.size} web chat session(s) from disk`);
  } catch {
    // no persisted history yet
  }
}

function newSessionKey(): string {
  return `web:${randomUUID().slice(0, 8)}`;
}

// ── auto-follow: the webui mirrors the live Telegram conversation ─────
// One-way by design. Telegram always runs its own conversation keys
// ("chatId:threadId", see bot.ts) and NEVER adopts a web key — there is
// no code path from bot.ts into the web session store. The webui, in
// contrast, resolves its active session to the freshest Telegram key on
// every /api/session read, so whatever grandma is discussing on her
// phone is what the browser continues typing into. Explicitly picking a
// local web session (or starting a new chat) turns following off until
// it's re-enabled in settings.
let autoFollowTelegram = true;
let webSettingsPath = "";

// Reverse follow, established by "send to telegram": the Telegram chat adopts
// the web session's own conversation key, so a message sent from either end
// continues the same tree. tgKey ("chatId:threadId") -> webKey ("web:<id>").
// Deliberately the mirror image of autoFollowTelegram.
const telegramFollow = new Map<string, string>();

function loadFollowSetting(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(webSettingsPath, "utf8"));
    if (typeof raw?.followTelegram === "boolean") autoFollowTelegram = raw.followTelegram;
    if (raw?.telegramFollow && typeof raw.telegramFollow === "object") {
      for (const [tg, web] of Object.entries(raw.telegramFollow as Record<string, unknown>)) {
        if (typeof tg === "string" && typeof web === "string") telegramFollow.set(tg, web);
      }
    }
  } catch { /* first boot — default on */ }
}

function saveFollowSetting(): void {
  if (!webSettingsPath) return;
  try {
    fs.mkdirSync(path.dirname(webSettingsPath), { recursive: true });
    fs.writeFileSync(
      webSettingsPath,
      JSON.stringify({
        followTelegram: autoFollowTelegram,
        telegramFollow: Object.fromEntries(telegramFollow),
      }),
    );
  } catch (e) {
    console.warn("[admin] failed to save follow setting:", e);
  }
}

/** The web session a Telegram key has adopted, if any (reverse follow). */
export function telegramFollowKey(tgKey: string): string | undefined {
  return telegramFollow.get(tgKey);
}

/** The Telegram key following a web session, if any. */
export function webFollowTarget(webKey: string): string | undefined {
  for (const [tg, web] of telegramFollow) if (web === webKey) return tg;
  return undefined;
}

/**
 * Bind a Telegram chat to a web session. Called after "send to telegram" so
 * the phone continues the same conversation. Web-follows-telegram is turned
 * off, or resolveFollow would pull the page back onto the phone's own key.
 */
export function bindTelegramFollow(tgKey: string, webKey: string): void {
  telegramFollow.set(tgKey, webKey);
  autoFollowTelegram = false;
  saveFollowSetting();
  broadcast({ type: "followWeb", key: webKey, tgKey });
}

/** Drop every Telegram binding that points at a web session. */
export function unbindWebSession(webKey: string): void {
  let changed = false;
  for (const [tg, web] of [...telegramFollow]) {
    if (web === webKey) {
      telegramFollow.delete(tg);
      changed = true;
    }
  }
  if (changed) {
    saveFollowSetting();
    broadcast({ type: "followWeb", key: null, tgKey: null });
  }
}

/** Freshest live Telegram conversation key, or null when none exists. */
function followTarget(agent?: Agent): string | null {
  const meta = agent?.sessionMeta?.() ?? [];
  const tg = meta
    .filter((s) => !String(s.key).startsWith("web:") && s.updatedAt > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return tg.length ? tg[0].key : null;
}

function resolveFollow(agent?: Agent): void {
  if (!autoFollowTelegram) return;
  const target = followTarget(agent);
  if (!target) return; // no Telegram conversation to follow yet — keep current state
  if (!sessionTurns.has(target)) {
    sessionTurns.set(target, {
      label: describeForeignKey(target), pattern: getSelectedPattern(), updatedAt: Date.now(), turns: [],
    });
    saveTurns();
  }
  if (activeSession !== target) {
    activeSession = target;
    webMemoryValues.clear();
    webMemoryPaths.clear();
    broadcast({ type: "follow", key: target, label: sessionTurns.get(target)?.label ?? target });
  }
}

// Module handle on the agent so remote turns can prune the store too.
let adminAgent: Agent | undefined;
// Deliver webui-run turns to the originating transport (see AdminOptions).
let telegramNotify: ((key: string, text: string) => void) | undefined;
// App secret store (logs/secrets.db); undefined when not wired.
let secretsStore: SecretsStore | undefined;

/**
 * Track memory-slot writes from a raw agent event. Slots are identified
 * by (scope_id, name) — see webMemoryValues above. Shared by web-run
 * turns and mirrored Telegram turns so the tree panel stays truthful
 * whichever transport ran the step.
 */
function trackMemoryWrite(e: unknown): void {
  const raw = e as {
    scope_id?: number | null; branch_path?: string; kind?: string;
    content?: { child?: unknown; value?: unknown; op?: unknown };
  };
  // Memory writes are record events with op memory/memoryUpdate; older
  // runs logged them as their own "memory" kind.
  const memWrite =
    raw?.kind === "memory" ||
    (raw?.kind === "record" && (raw.content?.op === "memory" || raw.content?.op === "memoryUpdate"));
  if (!memWrite || raw.scope_id == null) return;
  const child = typeof raw.content?.child === "string" ? raw.content.child : "";
  const slotKey = `${raw.scope_id}/${child}`;
  if (raw.content && "value" in raw.content) webMemoryValues.set(slotKey, raw.content.value);
  const nodePath = (raw.branch_path ?? "") + (child ? "/" + child : "");
  if (nodePath) {
    let paths = webMemoryPaths.get(slotKey);
    if (!paths) { paths = new Set(); webMemoryPaths.set(slotKey, paths); }
    paths.add(nodePath);
  }
}

/** Find or create the web-store entry for a (foreign) conversation key. */
function ensureSessionEntry(key: string): WebSession {
  let s = sessionTurns.get(key);
  if (!s) {
    s = { label: describeForeignKey(key), pattern: getSelectedPattern(), updatedAt: Date.now(), turns: [] };
    sessionTurns.set(key, s);
    pruneSessions(adminAgent);
    saveTurns();
  }
  return s;
}

// Live mirror of a turn that runs on another transport (Telegram). bot.ts
// feeds these three calls while it runs the tree, so a followed browser
// shows the exchange — bubbles AND tree steps — exactly like a web turn.
// The key is normally the Telegram chat's; when the phone is reverse-following
// a web session (see bindTelegramFollow) it is that session's `web:` key, and
// recording here keeps the browser in step. Web-run turns use runTurn.
export function remoteTurnStart(key: string, input: string): void {
  if (!key) return;
  const s = ensureSessionEntry(key);
  const turnId = randomUUID();
  const now = Date.now();
  s.turns.push({
    turnId, input, startedAt: now, endedAt: null, status: "running",
    error: null, output: null, events: [],
  });
  while (s.turns.length > MAX_TURNS_KEPT) s.turns.shift();
  s.updatedAt = now;
  saveTurns();
  if (activeSession === key) broadcast({ type: "turn_start", turnId, session: key, input, ts: now });
}

export function remoteTurnEvent(key: string, event: unknown): void {
  if (!key) return;
  const s = sessionTurns.get(key);
  const t = s?.turns.at(-1);
  if (!t || t.status !== "running") return;
  trackMemoryWrite(event);
  const clean = sanitizeEvent(event as Parameters<typeof sanitizeEvent>[0]);
  t.events.push(clean);
  if (activeSession === key) broadcast({ type: "event", turnId: t.turnId, event: clean });
}

export function remoteTurnEnd(key: string, output: string, ok = true): void {
  if (!key) return;
  const s = sessionTurns.get(key);
  if (!s) return;
  const now = Date.now();
  let t = s.turns.at(-1);
  if (!t || t.status !== "running") {
    // End without a start (e.g. the grow pass failed before start) —
    // record a one-line turn rather than dropping the exchange.
    t = { turnId: randomUUID(), input: "", startedAt: now, endedAt: null, status: "running", error: null, output: null, events: [] };
    s.turns.push(t);
    while (s.turns.length > MAX_TURNS_KEPT) s.turns.shift();
    if (activeSession === key) broadcast({ type: "turn_start", turnId: t.turnId, session: key, input: "", ts: now });
  }
  t.endedAt = now;
  t.status = ok ? "done" : "error";
  t.output = ok ? output || null : null;
  t.error = ok ? null : output || "agent error";
  s.updatedAt = now;
  saveTurns();
  if (activeSession === key) {
    broadcast({ type: "turn_end", turnId: t.turnId, status: t.status, error: t.error, output: t.output, ts: now });
  }
}

function sessionList(agent?: Agent) {
  const local = [...sessionTurns.entries()].map(([key, s]) => ({
    key, label: s.label, pattern: s.pattern, updatedAt: s.updatedAt, turns: s.turns.length, remote: false,
    ref: agent?.sessionRef?.(key) ?? "",
  }));
  // Live continuations this page has no transcript for — Telegram topics
  // and web sessions pruned from the store. The web UI may FOLLOW any of
  // them: selecting one sends web messages into the same conversation key
  // the other transport uses, shared tree and all.
  const foreign = (agent?.sessionKeys() ?? [])
    .filter((k) => !sessionTurns.has(k))
    .map((k) => ({ key: k, label: describeForeignKey(k), pattern: "", updatedAt: 0, turns: 0, remote: true, ref: agent?.sessionRef?.(k) ?? "" }));
  return [...local, ...foreign].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** "chatId:threadId" (Telegram) → a readable label. */
function describeForeignKey(key: string): string {
  if (key.startsWith("web:")) return `web ${key.slice(4)} (no history)`;
  const m = key.match(/^(-?\d+):(\d+)$/);
  if (!m) return key;
  const [, chat, thread] = m;
  return `telegram · chat ${chat}${thread === "0" ? " (general)" : ` · topic ${thread}`}`;
}

/** Drop the least recently active sessions past the cap (and their trees). */
function pruneSessions(agent: Agent | undefined): void {
  if (sessionTurns.size <= MAX_SESSIONS_KEPT) return;
  const keys = sessionList().filter((s) => !s.remote).map((s) => s.key).filter((k) => k !== activeSession);
  for (const key of keys.slice(MAX_SESSIONS_KEPT)) {
    sessionTurns.delete(key);
    agent?.clear(key);
  }
}

const sseClients = new Set<http.ServerResponse>();
let webQueue: Promise<void> = Promise.resolve();
let activeTurns = 0;
let pendingTurns = 0;

/** True while a web turn is running; the auto-sync timer waits for a quiet moment. */
export function isAdminBusy(): boolean {
  return activeTurns > 0;
}

function broadcast(msg: unknown): void {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* client went away */ }
  }
}

/**
 * Tell connected web clients the tree/version catalog changed (a snapshot,
 * promote, or active-ref switch) so their selectors refresh right away.
 * Changes made outside the process (manual renames, an editor) are caught by
 * the client's periodic scan of the directory.
 */
export function notifyTreesChanged(name?: string): void {
  broadcast({ type: "trees", name: name ?? null });
}

function truncStr(s: string): string {
  return s.length > MAX_EVENT_STR ? s.slice(0, MAX_EVENT_STR) + "…" : s;
}

/** Recursively cap string length and long arrays so events stay streamable. */
function sanitizeValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return truncStr(v);
  if (v === null || typeof v !== "object") return v;
  if (depth > 4) return "…";
  if (Array.isArray(v)) {
    if (v.length > 6) {
      return { _summary: `${v.length} items`, last: sanitizeValue(v[v.length - 1], depth + 1) };
    }
    return v.map((x) => sanitizeValue(x, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = sanitizeValue(val, depth + 1);
  }
  return out;
}

function sanitizeEvent(e: { kind?: string; branch_path?: string; iteration?: number; scope_id?: number | null; content?: Record<string, unknown> | null }): SanitizedEvent {
  const content: Record<string, unknown> = { ...(e.content ?? {}) };
  // Keep the prompt input exactly as sent: attach it raw after generic
  // sanitization, which would otherwise truncate strings and collapse the
  // message array into a summary.
  const messages = Array.isArray(content.messages) ? content.messages : null;
  delete content.messages;
  const clean = sanitizeValue(content) as Record<string, unknown>;
  if (messages) clean.messages = messages;
  return {
    kind: e.kind ?? "unknown",
    branch_path: e.branch_path ?? "",
    iteration: e.iteration ?? 0,
    scope_id: e.scope_id ?? null,
    content: clean,
    ts: Date.now(),
  };
}

function enqueueChat(agent: Agent, key: string, content: unknown, displayText: string): { turnId: string; queued: boolean } {
  const turnId = randomUUID();
  pendingTurns++;
  // "queued" = another turn is running OR ahead in the queue, so the UI
  // shows a pending bubble until this turn's turn_start arrives.
  const queued = activeTurns > 0 || pendingTurns > 1;
  webQueue = webQueue
    .then(() => runTurn(agent, key, turnId, content, displayText))
    .catch((err) => console.error("[web-chat]", err));
  return { turnId, queued };
}

async function runTurn(agent: Agent, key: string, turnId: string, content: unknown, displayText: string): Promise<void> {
  pendingTurns--;
  activeTurns++;
  const session = sessionTurns.get(key);
  if (!session) {
    console.warn(`[web-chat] dropped turn for unknown session ${key}`);
    activeTurns--;
    return;
  }
  if (!session.label && displayText) session.label = displayText.slice(0, 60);
  // Stamp the tree this session is actually running under (the pattern is
  // global, but a session may have been created before a switch).
  session.pattern = getSelectedPattern();
  const record: TurnRecord = {
    turnId,
    input: displayText,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    error: null,
    output: null,
    emits: [],
    events: [],
  };
  session.turns.push(record);
  while (session.turns.length > MAX_TURNS_KEPT) session.turns.shift();
  broadcast({ type: "turn_start", turnId, session: key, input: displayText, ts: record.startedAt });

  // A web-run turn that belongs to (or is followed by) a Telegram chat is
  // mirrored to the phone LIVE — the user's line now, each emit as it is
  // produced, and any final/error line at turn end. Previously everything was
  // sent once at turn end, so a long run (e.g. enrich-profile) left the phone
  // silent until it finished. Sends share one chain to keep their order.
  const mirrorTarget = key.startsWith("web:") ? webFollowTarget(key) : key;
  let mirrorChain: Promise<void> = Promise.resolve();
  const mirror = (text: string | null | undefined) => {
    const target = mirrorTarget;
    if (!telegramNotify || !target || !text) return;
    const body = text;
    mirrorChain = mirrorChain
      .then(() => telegramNotify!(target, body))
      .catch((e) => console.warn("[web-chat] telegram notify failed:", e));
  };
  mirror(`\ud83d\udcbb ${displayText}`);

  const onEvent = (e: unknown) => {
    trackMemoryWrite(e);
    const s = sanitizeEvent(e as Parameters<typeof sanitizeEvent>[0]);
    record.events.push(s);
    broadcast({ type: "event", turnId, event: s });
  };

  try {
    // First message of the conversation: grow trunk-style trees to their
    // first .human(). Input-driven app trees (they declare `input`) consume
    // the message directly, so they get no grow pass. Explicit session
    // selection guarantees this only ever runs for a session the user chose
    // — never automatically after a restart.
    if (!agent.hasContinuation(key) && !(await agent.consumesInputDirectly())) {
      await agent.run(key, "", () => {}, { onEvent });
    }
    const res = await agent.run(
      key,
      content,
      (value) => {
        // Trees emit { text, buttons? } or engine narration ({ machine, level? });
        // the chat shows the text (a readable line for narration), never the JSON.
        const { text, buttons, level } = emitValue(value);
        if (buttons?.length) record.buttons = buttons;
        if (text || buttons?.length) {
          if (text) {
            record.output = record.output ? record.output + "\n\n" + text : text;
            (record.emits ??= []).push(text);
            (record.levels ??= []).push(level ?? null);
            mirror(text);
          }
          // Stream it now; turn_end still carries the final list, so the UI
          // can overwrite whatever a rewound/retried branch emitted.
          broadcast({ type: "emit", turnId, text, buttons, level });
        }
      },
      { onEvent },
    );
    // Non-looping trees complete instead of pausing at .human() — show
    // their final result as the reply when nothing was emitted.
    if (res.status === "done" && !record.output && res.result != null) {
      const { text, buttons } = emitValue(res.result);
      if (text) record.output = text;
      if (buttons?.length) record.buttons = buttons;
    }
    record.status = "done";
  } catch (err) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
    console.error("[web-chat]", err);
  } finally {
    activeTurns--;
    record.endedAt = Date.now();
    session.updatedAt = record.endedAt;
    broadcast({
      type: "turn_end",
      turnId,
      status: record.status,
      error: record.error,
      output: record.output,
      emits: record.emits ?? null,
      levels: record.levels ?? null,
      buttons: record.buttons,
      ts: record.endedAt,
    });
    saveTurns();
    // The mirror was live (see `mirror` above): everything streamed already
    // reached the phone. Send only what did not stream — the final result of a
    // non-looping tree, or the error line — then flush the chain.
    if (mirrorTarget) {
      if (record.status === "error") mirror(`\u26a0\ufe0f ${record.error ?? "error"}`);
      else if (!record.emits?.length && record.output) mirror(record.output);
      await mirrorChain;
    }
  }
}

// ── server ────────────────────────────────────────────────────────────
export interface AdminOptions extends Partial<AdminConfig> {
  /** The agent instance — required for the chat front page. */
  agent?: Agent;
  /**
   * Secret config store for workspace apps (logs/secrets.db). Enables the
   * "App secrets" upload section on /settings.
   */
  secrets?: SecretsStore;
  /**
   * Deliver a webui-run turn back to its originating transport (Telegram).
   * Called when a turn runs under a non-`web:` key — i.e. the browser
   * continued a Telegram conversation — so the phone sees the exchange
   * too. index.ts wires it to bot.api.sendMessage.
   */
  telegramNotify?: (key: string, text: string) => void | Promise<void>;
  /** STT backend options — required for voice input on the chat page. */
  stt?: SttBackendOptions;
}

export function startAdmin(cfg?: AdminOptions): http.Server {
  const config: AdminConfig = { ...defaultConfig(), ...cfg };
  const platform = createNodePlatform(config.workspaceDir);
  const agent = cfg?.agent;
  telegramNotify = cfg?.telegramNotify;
  secretsStore = cfg?.secrets;
  adminAgent = agent;
  const stt = cfg?.stt;
  const SETTINGS_HTML = buildSettingsHtml(config);
  const sttLabel = stt
    ? `voice: ${stt.backend} @ ${new URL(stt.backend === "sherpa" || stt.backend === "parakeet" ? stt.sherpaUrl : stt.whisperUrl).host}`
    : "voice: not configured";
  const CHAT_HTML = buildChatHtml(config, sttLabel);

  // A fingerprint of the served pages. A browser tab keeps running the JS it
  // loaded; after a restart with changed page code it would keep the old client
  // (and miss fixes) until a manual reload. Embed the fingerprint and expose it
  // on /api/status so the client can reload itself when it goes stale.
  const UI_VERSION = createHash("sha256")
    .update(CHAT_HTML)
    .update(SETTINGS_HTML)
    .digest("hex")
    .slice(0, 12);
  const injectUiVersion = (html: string): string =>
    html.replace("</head>", `<script>window.__UI_VERSION__=${JSON.stringify(UI_VERSION)}</script></head>`);
  const CHAT_PAGE = injectUiVersion(CHAT_HTML);
  const SETTINGS_PAGE = injectUiVersion(SETTINGS_HTML);

  // Restore the web chat history from the previous run (before any browser
  // polls /api/turns).
  webTurnsPath = path.resolve(config.workspaceDir, "logs", "web-turns.json");
  webSettingsPath = path.resolve(config.workspaceDir, "logs", "web-settings.json");
  loadFollowSetting();
  loadTurns();
  // By default the webui follows the live Telegram conversation; only when
  // there is nothing to follow does the classic rule apply — never re-arm
  // a stored session automatically after a restart (picker), except on a
  // true first boot, which opens a fresh chat.
  if (autoFollowTelegram) resolveFollow(agent);
  if (!activeSession) {
    if (sessionTurns.size === 0) {
      const key = newSessionKey();
      sessionTurns.set(key, { label: "", pattern: getSelectedPattern(), updatedAt: Date.now(), turns: [] });
      activeSession = key;
      saveTurns();
    } else {
      console.log(`[admin] ${sessionTurns.size} web session(s) on disk awaiting explicit selection`);
    }
  } else if (autoFollowTelegram) {
    console.log(`[admin] webui follows telegram conversation ${activeSession}`);
  }

  // Keep SSE connections alive through proxies/idle timeouts.
  const heartbeat = setInterval(() => {
    for (const res of sseClients) {
      try { res.write(": ping\n\n"); } catch { /* ignore */ }
    }
  }, 25000);
  heartbeat.unref();

  // --- grandma-kat tree log: read-only SSE for apps ---
  // Opens the workspace's grandma-kat.db read-only. Nodes running a turn
  // broadcast new events to /api/tree/events subscribers on a poll cadence.
  const treeDbPath = logDbPath(config.workspaceDir);
  let treeReader: TreeLogReader;
  let treeReaderErr: string | null = null;
  try {
    treeReader = new TreeLogReader(treeDbPath);
  } catch (e: any) {
    treeReaderErr = e.message;
    console.warn(`[admin] grandma-kat log unavailable at ${treeDbPath}: ${e.message}`);
  }
  const treeClients: { res: http.ServerResponse; since: number }[] = [];
  const treePoll = setInterval(() => {
    if (!treeReader) return;
    let max = treeReader.maxSeq();
    for (const c of treeClients) {
      if (max <= c.since) continue;
      const events = treeReader.eventsSince(c.since);
      for (const ev of events) {
        try { c.res.write(`data: ${JSON.stringify({ type: "event", event: ev })}\n\n`); } catch { /* client left */ }
      }
      c.since = max;
    }
  }, 1000);
  treePoll.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, `http://localhost:${config.port}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(CHAT_PAGE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/settings") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(SETTINGS_PAGE);
        return;
      }

      // --- web chat ---

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write("retry: 2000\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/turns") {
        const turns = activeSession ? sessionTurns.get(activeSession)?.turns ?? [] : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ turns, session: activeSession }));
        return;
      }

      // --- web sessions ---
      // Nothing resumes automatically after a restart: until the user
      // picks a session here (or starts a new one), /api/chat is refused
      // and no stored checkpoint is touched.
      if (req.method === "GET" && url.pathname === "/api/session") {
        resolveFollow(agent);
        const active = activeSession ? sessionTurns.get(activeSession) : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          active: activeSession,
          label: active?.label || "",
          follow: autoFollowTelegram,
          sessions: sessionList(agent),
          turns: active ? active.turns.map(slimTurn) : null,
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = await readBody(req);
        let sel: { key?: unknown; new?: unknown; delete?: unknown; follow?: unknown };
        try { sel = JSON.parse(body); } catch { res.writeHead(400); res.end('{"error":"invalid JSON body"}'); return; }

        if (typeof sel.follow === "boolean") {
          autoFollowTelegram = sel.follow;
          saveFollowSetting();
          if (autoFollowTelegram) resolveFollow(agent);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, active: activeSession, follow: autoFollowTelegram, sessions: sessionList(agent) }));
          return;
        }

        if (sel.new === true) {
          // Taking the deliberate step of a private web chat ends the
          // telegram-follow until it's switched back on in settings.
          if (autoFollowTelegram) { autoFollowTelegram = false; saveFollowSetting(); }
          const key = newSessionKey();
          sessionTurns.set(key, { label: "", pattern: getSelectedPattern(), updatedAt: Date.now(), turns: [] });
          pruneSessions(agent);
          activeSession = key;
          webMemoryValues.clear();
          webMemoryPaths.clear();
          saveTurns();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, active: key, follow: autoFollowTelegram, turns: [] }));
          return;
        }
        if (typeof sel.delete === "string") {
          if (!sessionTurns.has(sel.delete)) { res.writeHead(404); res.end('{"error":"no such session"}'); return; }
          sessionTurns.delete(sel.delete);
          agent?.clear(sel.delete);
          unbindWebSession(sel.delete);
          if (activeSession === sel.delete) {
            activeSession = null;
            broadcast({ type: "cleared" });
          }
          saveTurns();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, active: activeSession, sessions: sessionList(agent) }));
          return;
        }
        if (typeof sel.key === "string") {
          let s = sessionTurns.get(sel.key);
          if (!s && agent?.hasContinuation(sel.key)) {
            // FOLLOW a conversation owned by another transport (a Telegram
            // topic): adopt its key. Messages here run the very same tree;
            // the transcript view starts empty (state lives in the
            // checkpoint, and the other chat keeps working unchanged).
            s = { label: describeForeignKey(sel.key), pattern: getSelectedPattern(), updatedAt: Date.now(), turns: [] };
            sessionTurns.set(sel.key, s);
            saveTurns();
          }
          if (!s) { res.writeHead(404); res.end('{"error":"no such session"}'); return; }
          // Pinning a local web session also releases the telegram-follow;
          // selecting a telegram key by hand is compatible with staying on.
          if (autoFollowTelegram && sel.key.startsWith("web:")) { autoFollowTelegram = false; saveFollowSetting(); }
          activeSession = sel.key;
          // Memory slots belong to the selected tree; the panel must not
          // show the previous session's values until this one logs again.
          webMemoryValues.clear();
          webMemoryPaths.clear();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, active: sel.key, follow: autoFollowTelegram, turns: s.turns.map(slimTurn) }));
          return;
        }
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"key, new, or delete required"}');
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        if (!agent) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"agent not available"}');
          return;
        }
        if (!activeSession) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end('{"error":"no session selected — resume one or start a new chat"}');
          return;
        }
        const body = await readBody(req);
        if (body.length > 64 * 1024) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end('{"error":"message too large"}');
          return;
        }
        let text: unknown;
        try {
          text = JSON.parse(body).text;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"invalid JSON body"}');
          return;
        }
        if (typeof text !== "string" || !text.trim()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"text is required"}');
          return;
        }
        const message = text.trim();
        const { turnId, queued } = enqueueChat(agent, activeSession, message, message);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, turnId, queued }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat/upload") {
        if (!agent) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"agent not available"}');
          return;
        }
        if (!activeSession) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end('{"error":"no session selected — resume one or start a new chat"}');
          return;
        }
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("multipart/form-data")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"multipart required"}');
          return;
        }
        const boundary = contentType.split("boundary=")[1];
        if (!boundary) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"no boundary"}');
          return;
        }
        const parts = await readMultipart(req, boundary);
        const file = parts.file;
        if (!file?.content?.length) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"no file"}');
          return;
        }
        if (file.content.length > MAX_ATTACHMENT_BYTES) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end('{"error":"attachment too large (max 50 MB)"}');
          return;
        }
        const attachment = await saveAttachment(
          platform,
          file.filename || "upload",
          file.content,
          file.contentType || "application/octet-stream",
        );
        const caption = typeof parts.caption === "string" ? parts.caption.trim() : "";
        const content = attachmentPrompt(attachment, caption);
        const display = caption ? `${caption}\n[attached: ${attachment.filename}]` : `[attached: ${attachment.filename}]`;
        const { turnId, queued } = enqueueChat(agent, activeSession, content, display);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, turnId, queued, attachment }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/transcribe") {
        if (!stt) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"STT backend not configured"}');
          return;
        }
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("multipart/form-data")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"multipart required"}');
          return;
        }
        const boundary = contentType.split("boundary=")[1];
        if (!boundary) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"no boundary"}');
          return;
        }
        const parts = await readMultipart(req, boundary);
        const file = parts.file;
        if (!file || !file.content || !file.content.length) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"no audio file"}');
          return;
        }
        if (file.content.length > 25 * 1024 * 1024) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end('{"error":"audio too large"}');
          return;
        }
        try {
          const ext = path.extname(file.filename || "") || ".webm";
          const text = await transcribeAudioBytes(file.content, { ext, ...stt });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text }));
        } catch (e: any) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `transcription failed: ${e.message}` }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/transcribe-stream") {
        if (!stt) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"STT backend not configured"}');
          return;
        }
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("multipart/form-data")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"multipart required"}');
          return;
        }
        const boundary = contentType.split("boundary=")[1];
        if (!boundary) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"no boundary"}');
          return;
        }
        const parts = await readMultipart(req, boundary);
        const file = parts.file;
        if (!file || !file.content || !file.content.length) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"no audio file"}');
          return;
        }
        if (file.content.length > 100 * 1024 * 1024) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end('{"error":"audio too large (max 100 MB)"}');
          return;
        }

        // SSE response: info → partial* → done | error.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        });
        const send = (obj: unknown) => {
          try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client left */ }
        };
        try {
          const ext = path.extname(file.filename || "") || ".webm";
          const wav = await convertToWav(file.content, ext, stt.tmpDir);
          const duration = wavDurationSeconds(wav);
          if (duration > 1800) throw new Error("audio too long (max 30 minutes)");
          send({ type: "info", duration });
          const text = await transcribeWavStreaming(wav, stt, (partial, at) =>
            send({ type: "partial", text: partial, ...(at !== undefined ? { at } : {}) }),
          );
          send({ type: "done", text });
        } catch (e: any) {
          send({ type: "error", error: e.message });
        }
        res.end();
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/clear") {
        // Wipe the ACTIVE session's history + tree, but stay on it (fresh
        // start under the same key). Session removal lives in /api/session.
        if (activeSession) {
          agent?.clear(activeSession);
          sessionTurns.set(activeSession, { label: "", pattern: getSelectedPattern(), updatedAt: Date.now(), turns: [] });
          saveTurns();
        }
        webMemoryValues.clear();
        webMemoryPaths.clear();
        broadcast({ type: "cleared" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, active: activeSession }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/send-to-telegram") {
        // Mirror the ACTIVE session's transcript onto the user's own
        // Telegram chat ("my linked chat"): reuse the existing one-way
        // notify hook rather than inventing a new send path — the same code
        // that mirrors webui-run turns onto the phone.
        if (!activeSession) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end('{"error":"no session selected — resume one or start a new chat"}');
          return;
        }
        const session = sessionTurns.get(activeSession);
        if (!session || !session.turns.length) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end('{"error":"this session has no turns to send yet"}');
          return;
        }
        if (!telegramNotify) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"telegram is not wired up (no telegramNotify hook)"}');
          return;
        }
        // "My linked chat": the Telegram key tied to the active session.
        // A web:-owned session has no Telegram key, so fall back to the
        // freshest live Telegram conversation; with no Telegram key at
        // all (phone never messaged the bot) there is nowhere to send.
        let target = activeSession.startsWith("web:") ? null : activeSession;
        if (!target) {
          target = followTarget(agent) ?? null;
          if (!target) {
            res.writeHead(409, { "content-type": "application/json" });
            res.end('{"error":"no telegram chat linked yet — message the bot on Telegram first"}');
            return;
          }
        }
        // Plain-text transcript: one block per turn, errors kept as ⚠️
        // lines. No buttons — mirrors are text-only by design (see the
        // emit-buttons continuation record).
        const lines: string[] = [
          `📋 transcript · ${session.label || sessionTurns.get(target)?.label || activeSession} (${session.turns.length} turn${session.turns.length === 1 ? "" : "s"})`,
        ];
        for (const t of session.turns) {
          lines.push("", `—— you ——`, t.input || "(empty)");
          lines.push(
            `—— bob ——`,
            t.status === "error" ? `⚠️ ${t.error ?? "error"}` : (t.output || "(no reply)"),
          );
        }
        const text = lines.join("\n");
        try {
          // Same chunking the phone path uses (Telegram caps at 4096).
          const MAX = 4000;
          const parts: string[] = [];
          let rest = text;
          while (rest.length > MAX) {
            let cut = rest.lastIndexOf("\n", MAX);
            if (cut < MAX / 2) cut = MAX;
            parts.push(rest.slice(0, cut));
            rest = rest.slice(cut).replace(/^\n+/, "");
          }
          if (rest.trim()) parts.push(rest);
          for (const part of parts) await telegramNotify(target, part);
          // The phone now follows this web session: a message from either
          // end continues the same conversation. Only web-owned sessions can
          // be adopted (a Telegram transcript has nowhere new to point).
          const followWeb = activeSession.startsWith("web:") ? activeSession : null;
          if (followWeb) {
            bindTelegramFollow(target, followWeb);
            await telegramNotify(
              target,
              "\ud83d\udd17 This chat now follows the web session — messages from either end continue it.",
            );
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, key: target, parts: parts.length, turns: session.turns.length, followWeb }));
        } catch (e: unknown) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        const env = await readEnv(config.envPath);
        const [status, services] = await Promise.all([
          tmuxStatus(config.botSession, config.sherpaSession),
          serviceStatus(config, stt, env || {}),
        ]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          env: env || {},
          ...status,
          services,
          uiVersion: UI_VERSION,
          uptimeSec: Math.round(process.uptime()),
          pid: process.pid,
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/env") {
        const body = await readBody(req);
        const updates = JSON.parse(body);
        await writeEnv(config.envPath, updates);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/models") {
        let json = "";
        try {
          json = await readFile(path.resolve(config.projectDir, "models.json"), "utf8");
        } catch {
          /* no models.json yet */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ json }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/models") {
        const body = await readBody(req);
        const json = (JSON.parse(body || "{}") as { json?: string }).json ?? "";
        await writeFile(path.resolve(config.projectDir, "models.json"), String(json), "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/restart-bot") {
        restartBot(config.projectDir, config.botSession);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sync/pull") {
        const body = await readBody(req);
        const local = JSON.parse(body).local || "master";
        const remote = JSON.parse(body).remote || local;
        const result = await gitSync(config.workspaceDir, "pull", local, remote);
        const dbSync = await applyDatabaseDumps(createNodePlatform(config.workspaceDir)).catch(() => null);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...result, dbSync }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sync/push") {
        const body = await readBody(req);
        const local = JSON.parse(body).local || "master";
        const remote = JSON.parse(body).remote || local;
        const platform = createNodePlatform(config.workspaceDir);
        let result: unknown;
        try {
          result = await withSyncLock(platform, { remote: "sync" }, async () => {
            await writeDatabaseDumps(platform).catch(() => {});
            await gitCommitAll(config.workspaceDir, "sync: database dumps");
            return gitSync(config.workspaceDir, "push", local, remote);
          });
        } catch (err) {
          result = { ok: false, output: err instanceof Error ? err.message : String(err) };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/commit") {
        const body = await readBody(req);
        const msg = (JSON.parse(body).message || "manual commit from admin UI").trim();
        await writeDatabaseDumps(createNodePlatform(config.workspaceDir)).catch(() => {});
        const result = await gitCommitAll(config.workspaceDir, msg);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/log") {
        const file = url.searchParams.get("file");
        const logPath = file === "bot" ? config.botLog : file === "sherpa" ? config.sherpaLog : null;
        if (!logPath) { res.writeHead(400); res.end('{"error":"file must be bot or sherpa"}'); return; }
        const content = await readTail(logPath, 60);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/patterns") {
        const patterns = await listPatterns(config.workspaceDir);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ patterns }));
        return;
      }

      // --- tree structure for the chat page's side panel ---
      // Loads the pattern (default: the active one) and serializes its Tree
      // definition to JSON. Node paths match runtime branch_path values so
      // the UI can highlight live progress.
      if (req.method === "GET" && url.pathname === "/api/tree") {
        const name = url.searchParams.get("pattern") || getSelectedPattern();
        try {
          const tree = await loadPattern(config.workspaceDir, name);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ pattern: name, tree: serializeTree(tree) }));
        } catch (e: any) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/patterns/")) {
        const name = url.pathname.split("/").pop()!;
        const content = await readPattern(config.workspaceDir, name);
        if (content === null) { res.writeHead(404); res.end('{"error":"pattern not found"}'); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name, content }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/patterns") {
        const body = await readBody(req);
        const p = JSON.parse(body);
        if (!p.name || !p.content) { res.writeHead(400); res.end('{"error":"pattern must have name and content"}'); return; }
        await writePattern(config.workspaceDir, p.name, p.content);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/patterns/")) {
        const name = url.pathname.split("/").pop()!;
        await deletePattern(config.workspaceDir, name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // --- active pattern selection ---
      // GET returns the current pattern + the available list; POST switches
      // the pattern (and clears the web conversation — the tree pause state
      // is pattern-specific, so it can't be resumed under a different tree).
      if (req.method === "GET" && url.pathname === "/api/pattern") {
        const patterns = await listTreeSources(config.workspaceDir);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ current: getSelectedPattern(), ref: getSelectedRef() ?? "", patterns }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/pattern") {
        const body = await readBody(req);
        let name: unknown;
        try { name = JSON.parse(body).name; } catch { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid JSON body"}'); return; }
        if (typeof name !== "string" || !name) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"name is required"}'); return; }
        const patterns = await listTreeSources(config.workspaceDir);
        if (!patterns.some((p) => p.name === name)) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `pattern not found: ${name}` }));
          return;
        }
        // Re-selecting the same logical tree is a no-op: keep every session
        // (the selector polls, and a redundant POST must not wipe chats).
        if (name === getSelectedPattern()) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, pattern: name }));
          return;
        }
        setSelectedPattern(name);
        try { await writeEnv(config.envPath, { TREE_PATTERN: name }); } catch { /* persist best-effort */ }
        // Pause state is pattern-specific: no stored continuation can be
        // resumed under a different tree. The active session is wiped (and
        // the page told via "cleared"); every other session's stale token is
        // dropped too — its history stays, and the next message under it
        // grows a fresh tree.
        if (activeSession) {
          sessionTurns.set(activeSession, { label: "", pattern: getSelectedPattern(), updatedAt: Date.now(), turns: [] });
        }
        for (const key of sessionTurns.keys()) agent?.clear(key);
        webMemoryValues.clear();
        webMemoryPaths.clear();
        saveTurns();
        broadcast({ type: "cleared" });
        notifyTreesChanged(name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pattern: name }));
        return;
      }

      // --- tree versions ---
      // The version list for one logical tree, plus the ref new sessions
      // adopt. Snapshots come straight from the filenames, so a manual
      // rename is observed on the next read (no hidden state).
      if (req.method === "GET" && url.pathname === "/api/tree/versions") {
        const name = url.searchParams.get("name") ?? "";
        if (!name) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"name is required"}');
          return;
        }
        const catalog = (await scanTreeVersions(config.workspaceDir)).find((c) => c.logical === name);
        const source = (await listTreeSources(config.workspaceDir)).find((s) => s.name === name);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            name,
            versions: catalog?.versions ?? [],
            specs: catalog?.specVersions ?? [],
            prod: catalog?.hasProd ? (catalog.prodVersion ?? "prod") : null,
            draft: catalog?.draft ?? false,
            draftSpec: catalog?.draftSpec ?? false,
            active: getSelectedRef() ?? "",
            description: source?.description ?? "",
            pinned: agent?.pinnedVersions?.(name) ?? [],
          }),
        );
        return;
      }

      // The paired spec (source of truth for behavior) of a resolved version.
      if (req.method === "GET" && url.pathname === "/api/tree/spec") {
        const pattern = url.searchParams.get("pattern") || getSelectedPattern();
        const { logical, ref } = splitTreeRef(pattern);
        const entry = await resolveTreeEntry(config.workspaceDir, logical, ref);
        if (!entry || !entry.specAbs) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `no spec for '${pattern}'` }));
          return;
        }
        try {
          const spec = await readFile(entry.specAbs, "utf8");
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ pattern, specFile: entry.specFile, spec }));
        } catch (err) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      // Snapshot the draft into the next immutable version.
      if (req.method === "POST" && url.pathname === "/api/tree/versions") {
        const body = await readBody(req);
        let name: unknown;
        try { name = JSON.parse(body).name; } catch { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid JSON body"}'); return; }
        if (typeof name !== "string" || !name) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"name is required"}');
          return;
        }
        try {
          const snap = await snapshotTree(config.workspaceDir, name);
          await pruneVersions(config.workspaceDir, name, KEEP_VERSIONS, agent?.pinnedVersions?.(name) ?? []);
          notifyTreesChanged(name);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, version: snap.version, created: snap.created }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      // Set the active ref for NEW sessions. Unlike /api/pattern this never
      // clears a session: already-running chats keep their pinned version.
      if (req.method === "POST" && url.pathname === "/api/tree/version/active") {
        const body = await readBody(req);
        let parsed: { name?: unknown; ref?: unknown };
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid JSON body"}'); return; }
        const name = typeof parsed.name === "string" ? parsed.name : "";
        const ref = typeof parsed.ref === "string" ? parsed.ref : "";
        if (!name) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"name is required"}');
          return;
        }
        setSelectedRef(ref);
        try { await writeEnv(config.envPath, { TREE_REF: ref && ref !== "prod" ? ref : null }); } catch { /* persist best-effort */ }
        notifyTreesChanged(name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ref: getSelectedRef() ?? "" }));
        return;
      }

      // Promote a snapshot to production (rename) and prune old snapshots.
      if (req.method === "POST" && url.pathname === "/api/tree/version/promote") {
        const body = await readBody(req);
        let parsed: { name?: unknown; version?: unknown };
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid JSON body"}'); return; }
        const name = typeof parsed.name === "string" ? parsed.name : "";
        const version = typeof parsed.version === "string" ? parsed.version : "";
        if (!name || !version) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":"name and version are required"}');
          return;
        }
        try {
          const promoted = await promoteTree(config.workspaceDir, name, version);
          await pruneVersions(config.workspaceDir, name, KEEP_VERSIONS, agent?.pinnedVersions?.(name) ?? []);
          notifyTreesChanged(name);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...promoted }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      // --- app secrets ---
      // Apps declare the files they need in app/<name>/secrets.json; the
      // user uploads them here. Bytes live in logs/secrets.db (0600,
      // gitignored, hidden from the file browser); app tools read only
      // their own app's entries via the context execute() receives.
      if (req.method === "GET" && url.pathname === "/api/secrets") {
        const requests = await listSecretRequests(config.workspaceDir);
        const stored = new Map((secretsStore?.list() ?? []).map((s) => [`${s.app}/${s.name}`, s]));
        const secrets = requests.map((r) => {
          const hit = stored.get(`${r.app}/${r.name}`);
          stored.delete(`${r.app}/${r.name}`);
          return { ...r, present: !!hit, size: hit?.size ?? 0, updatedAt: hit?.updatedAt ?? null, contentType: hit?.contentType ?? r.contentType };
        });
        for (const orphan of stored.values()) {
          secrets.push({ app: orphan.app, name: orphan.name, description: "(no longer requested by its app)", contentType: orphan.contentType, present: true, size: orphan.size, updatedAt: orphan.updatedAt });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ secrets }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/secrets") {
        if (!secretsStore) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"secret store not available"}'); return; }
        const appName = url.searchParams.get("app") || "";
        const secretName = url.searchParams.get("name") || "";
        if (!validSecretName(appName) || !validSecretName(secretName)) {
          res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid app or secret name"}'); return;
        }
        // Only declared requests are uploadable — a manifest is the only
        // way to open an upload slot, and names are opaque keys, not paths.
        const declared = await listSecretRequests(config.workspaceDir);
        const request = declared.find((r) => r.app === appName && r.name === secretName);
        if (!request) {
          res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"no declared secret request with that app/name"}'); return;
        }
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("multipart/form-data")) {
          res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"multipart required"}'); return;
        }
        const boundary = contentType.split("boundary=")[1];
        if (!boundary) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"no boundary"}'); return; }
        const parts = await readMultipart(req, boundary);
        const file = parts.file;
        if (!file?.content?.length) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"no file"}'); return; }
        if (file.content.length > MAX_SECRET_BYTES) {
          res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":"secret too large (max 1 MB)"}'); return;
        }
        secretsStore.put(appName, secretName, file.content, file.contentType || request.contentType);
        console.log(`[secrets] stored ${appName}/${secretName} (${file.content.length} bytes)`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, app: appName, name: secretName, size: file.content.length }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/secrets/vars") {
        if (!secretsStore) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"secret store not available"}'); return; }
        const appName = url.searchParams.get("app") || "";
        const secretName = url.searchParams.get("name") || "";
        if (!validSecretName(appName) || !validSecretName(secretName)) {
          res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid app or secret name"}'); return;
        }
        const declared = await listSecretRequests(config.workspaceDir);
        if (!declared.find((r) => r.app === appName && r.name === secretName)) {
          res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"no declared secret request with that app/name"}'); return;
        }
        let value: unknown;
        try {
          value = (JSON.parse((await readBody(req)) || "{}") as { value?: unknown }).value;
        } catch {
          res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid JSON body"}'); return;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"value must be an object"}'); return;
        }
        const bytes = Buffer.from(JSON.stringify(value, null, 2));
        if (bytes.length > MAX_SECRET_BYTES) {
          res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":"secret too large (max 1 MB)"}'); return;
        }
        secretsStore.put(appName, secretName, bytes, "application/json");
        console.log(`[secrets] stored ${appName}/${secretName} (vars, ${bytes.length} bytes)`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, app: appName, name: secretName, size: bytes.length }));
        return;
      }

      // Import a desktop secrets.db (app_secrets table) — e.g. copied from
      // another machine. Body: { base64 }. Upserts every row it can read.
      if (req.method === "POST" && url.pathname === "/api/secrets/import") {
        if (!secretsStore) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"secret store not available"}'); return; }
        const body = await readBody(req);
        let b64 = "";
        try { b64 = String(JSON.parse(body).base64 ?? ""); } catch { /* invalid JSON */ }
        if (!b64) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"base64 required"}'); return; }
        const tmp = path.join(os.tmpdir(), `secrets-import-${randomUUID()}.db`);
        try {
          await writeFile(tmp, Buffer.from(b64, "base64"));
          const db = new DatabaseSync(tmp, { readOnly: true });
          let imported = 0;
          try {
            const rows = db
              .prepare("SELECT app, name, content, content_type FROM app_secrets")
              .all() as Array<Record<string, unknown>>;
            for (const row of rows) {
              const app = String(row.app ?? "");
              const name = String(row.name ?? "");
              if (!app || !name) continue;
              const raw = row.content;
              const buf = Buffer.isBuffer(raw) ? raw : Buffer.from((raw as ArrayLike<number>) ?? []);
              secretsStore.put(app, name, buf, row.content_type == null ? null : String(row.content_type));
              imported++;
            }
          } finally {
            db.close();
          }
          console.log(`[secrets] imported ${imported} secret(s)`);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, imported }));
        } catch (err) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        } finally {
          await unlink(tmp).catch(() => {});
        }
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/secrets") {
        if (!secretsStore) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"secret store not available"}'); return; }
        const appName = url.searchParams.get("app") || "";
        const secretName = url.searchParams.get("name") || "";
        if (!validSecretName(appName) || !validSecretName(secretName)) {
          res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid app or secret name"}'); return;
        }
        const removed = secretsStore.delete(appName, secretName);
        res.writeHead(removed ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: removed }));
        return;
      }

      // --- file browser ---
      if (req.method === "GET" && url.pathname === "/api/files") {
        const dir = url.searchParams.get("path") || "";
        const files = await listFiles(config.workspaceDir, dir);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ dir, files }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/files/download") {
        const p = url.searchParams.get("path");
        if (!p) { res.writeHead(400); res.end('{"error":"path required"}'); return; }
        const content = await readFile(safePath(config.workspaceDir, p));
        const filename = path.basename(p);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${filename}"` });
        res.end(content);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/files/upload") {
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("multipart/form-data")) { res.writeHead(400); res.end('{"error":"multipart required"}'); return; }
        const boundary = contentType.split("boundary=")[1];
        if (!boundary) { res.writeHead(400); res.end('{"error":"no boundary"}'); return; }
        const parts = await readMultipart(req, boundary);
        const file = parts.file;
        const destPath = parts.path || "";
        if (!file || !file.filename) { res.writeHead(400); res.end('{"error":"no file"}'); return; }
        const saveTo = path.join(destPath, file.filename);
        await saveFile(config.workspaceDir, saveTo, file.content);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: saveTo, size: file.content.length }));
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/files") {
        const p = url.searchParams.get("path");
        if (!p) { res.writeHead(400); res.end('{"error":"path required"}'); return; }
        await deleteFile(config.workspaceDir, p);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // --- grandma-kat tree log (read-only, for apps) ---

      if (req.method === "GET" && url.pathname === "/api/tree/runs") {
        if (treeReaderErr) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: treeReaderErr })); return; }
        const runs = treeReader.listRuns(Number(url.searchParams.get("limit") || "50"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ runs }));
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/tree/run/")) {
        if (treeReaderErr) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: treeReaderErr })); return; }
        const runId = decodeURIComponent(url.pathname.slice("/api/tree/run/".length));
        const run = treeReader.run(runId);
        if (!run.events.length) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"run not found"}'); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(run));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/tree/events") {
        if (treeReaderErr) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: treeReaderErr })); return; }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write("retry: 1500\n\n");
        const emit = (obj: unknown) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client left */ } };
        emit({ type: "runs", runs: treeReader.listRuns(50) });
        const last = treeReader.maxSeq();
        treeClients.push({ res, since: last });
        req.on("close", () => {
          const i = treeClients.findIndex((c) => c.res === res);
          if (i >= 0) treeClients.splice(i, 1);
        });
        return;
      }

      // --- current memory values for the tree side panel ---
      // Returns the last-written value for every memory/memoryUpdate node,
      // keyed by node path. Because values are resolved by scope (see
      // webMemoryPaths), a .memoryUpdate() deep in a branch updates the
      // declaring .memory() node's value too. `?path=` returns one full value
      // (used by the popup); without it, the full map (used for inline values).
      if (req.method === "GET" && url.pathname === "/api/tree/memory") {
        const values: Record<string, unknown> = {};
        for (const [slotKey, paths] of webMemoryPaths) {
          const v = webMemoryValues.get(slotKey);
          if (v === undefined) continue;
          for (const p of paths) values[p] = v;
        }
        res.writeHead(200, { "content-type": "application/json" });
        const pathParam = url.searchParams.get("path");
        if (pathParam) {
          res.end(JSON.stringify({ path: pathParam, value: values[pathParam] ?? null }));
        } else {
          res.end(JSON.stringify({ values }));
        }
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (e: any) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error: " + e.message);
    }
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`admin UI : http://0.0.0.0:${config.port} (bound on all interfaces)`);
  });

  server.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(treePoll);
    treeReader?.close();
  });

  return server;
}
