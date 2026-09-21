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
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { Agent } from "./agent.js";
import {
  transcribeAudioBytes,
  convertToWav,
  transcribeWavStreaming,
  wavDurationSeconds,
  type SttBackendOptions,
} from "./stt.js";
import { TreeLogReader, logDbPath } from "./treeLog.js";
import { DEFAULT_PATTERN, loadPattern } from "./pattern-loader.js";
import { serializeTree } from "./tree-serialize.js";
import { attachmentPrompt, saveAttachment, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { emitText } from "./util/emit-text.js";

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
async function writeEnv(envPath: string, updates: Record<string, string | null>) {
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
const PATTERNS_DIR_NAME = "patterns";

export async function listPatterns(workspaceDir: string) {
  const patternsDir = path.join(workspaceDir, PATTERNS_DIR_NAME);
  try {
    const files = await readdir(patternsDir);
    const out: { file: string; name: string; description: string }[] = [];
    for (const f of files) {
      if (!f.endsWith(".mjs")) continue;
      if (f.endsWith(".test.mjs")) continue; // smoke tests, not runnable patterns
      try {
        const content = await readFile(path.join(patternsDir, f), "utf8");
        const m = content.match(/^\/\/\s*(\S+\.mjs)\s*[—–-]\s*(.+)/m);
        const name = m ? m[1].replace(/\.mjs$/, "") : f.replace(/\.mjs$/, "");
        const desc = m ? m[2] : "(no description)";
        out.push({ file: f, name, description: desc });
      } catch {
        out.push({ file: f, name: f, description: "(read error)" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

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

// ── file browser ──────────────────────────────────────────────────────
function safePath(workspaceDir: string, p: string) {
  const resolved = path.resolve(workspaceDir, p || ".");
  if (!resolved.startsWith(workspaceDir)) throw new Error("path outside workspace");
  return resolved;
}

async function listFiles(workspaceDir: string, dir: string) {
  const resolved = safePath(workspaceDir, dir);
  const entries = await readdir(resolved, { withFileTypes: true });
  const out: { name: string; isDir: boolean; size: number; mtime: string | null }[] = [];
  for (const e of entries) {
    const full = path.join(resolved, e.name);
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
  events: SanitizedEvent[];
}

const turns: TurnRecord[] = [];
// Persisted copy of `turns` so the chat history survives bot restarts.
// Set inside startAdmin (config isn't available at module scope).
let webTurnsPath = "";

function saveTurns(): void {
  if (!webTurnsPath) return;
  try {
    fs.mkdirSync(path.dirname(webTurnsPath), { recursive: true });
    // Persist only what the UI needs to re-render after a restart. The
    // live raw `messages` attached to events (full prompt + system text)
    // are session telemetry already in grandma-kat.db — no reason to
    // duplicate them on disk.
    const slim = turns.map((t) => ({
      ...t,
      events: t.events.map((ev) => {
        if (!ev.content || !("messages" in ev.content)) return ev;
        const content = { ...ev.content };
        delete content.messages;
        return { ...ev, content };
      }),
    }));
    const tmp = webTurnsPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(slim));
    fs.renameSync(tmp, webTurnsPath);
  } catch (e) {
    console.warn("[admin] failed to save web turns:", e instanceof Error ? e.message : e);
  }
}

function loadTurns(): void {
  if (!webTurnsPath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(webTurnsPath, "utf8"));
    if (!Array.isArray(raw)) return;
    // "running" turns were interrupted by the restart — drop them.
    const restored = raw.filter((t: TurnRecord) => t && t.status !== "running");
    turns.length = 0;
    turns.push(...restored.slice(-MAX_TURNS_KEPT));
    if (turns.length) console.log(`[admin] restored ${turns.length} web chat turn(s) from disk`);
  } catch {
    // no persisted history yet
  }
}

const sseClients = new Set<http.ServerResponse>();
let webQueue: Promise<void> = Promise.resolve();
let activeTurns = 0;
let pendingTurns = 0;

function broadcast(msg: unknown): void {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* client went away */ }
  }
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

function enqueueChat(agent: Agent, content: unknown, displayText: string): { turnId: string; queued: boolean } {
  const turnId = randomUUID();
  pendingTurns++;
  // "queued" = another turn is running OR ahead in the queue, so the UI
  // shows a pending bubble until this turn's turn_start arrives.
  const queued = activeTurns > 0 || pendingTurns > 1;
  webQueue = webQueue
    .then(() => runTurn(agent, turnId, content, displayText))
    .catch((err) => console.error("[web-chat]", err));
  return { turnId, queued };
}

async function runTurn(agent: Agent, turnId: string, content: unknown, displayText: string): Promise<void> {
  pendingTurns--;
  activeTurns++;
  const record: TurnRecord = {
    turnId,
    input: displayText,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    error: null,
    output: null,
    events: [],
  };
  turns.push(record);
  while (turns.length > MAX_TURNS_KEPT) turns.shift();
  broadcast({ type: "turn_start", turnId, input: displayText, ts: record.startedAt });

  const onEvent = (e: unknown) => {
    const raw = e as {
      run_id?: string; scope_id?: number | null; branch_path?: string; kind?: string;
      content?: { child?: unknown; value?: unknown; op?: unknown };
    };
    // Memory writes are record events with op memory/memoryUpdate; older
    // runs logged them as their own "memory" kind.
    const memWrite =
      raw?.kind === "memory" ||
      (raw?.kind === "record" && (raw.content?.op === "memory" || raw.content?.op === "memoryUpdate"));
    if (memWrite && raw.scope_id != null) {
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
    const s = sanitizeEvent(e as Parameters<typeof sanitizeEvent>[0]);
    record.events.push(s);
    broadcast({ type: "event", turnId, event: s });
  };

  try {
    // First message of the conversation: grow the tree (pauses at .human()).
    if (!agent.hasContinuation(WEB_KEY)) {
      await agent.run(WEB_KEY, "", () => {}, { onEvent });
    }
    const res = await agent.run(
      WEB_KEY,
      content,
      (value) => {
        // Trees emit { text } objects; the chat shows the text, not the JSON.
        const t = emitText(value);
        if (t) {
          record.output = record.output ? record.output + "\n\n" + t : t;
          // Stream it now; turn_end still carries the final text, so the UI
          // can overwrite whatever a rewound/retried branch emitted.
          broadcast({ type: "emit", turnId, text: t });
        }
      },
      { onEvent },
    );
    // Non-looping trees complete instead of pausing at .human() — show
    // their final result as the reply when nothing was emitted.
    if (res.status === "done" && !record.output && res.result != null) {
      const t = emitText(res.result);
      if (t) record.output = t;
    }
    record.status = "done";
  } catch (err) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
    console.error("[web-chat]", err);
  } finally {
    activeTurns--;
    record.endedAt = Date.now();
    broadcast({
      type: "turn_end",
      turnId,
      status: record.status,
      error: record.error,
      output: record.output,
      ts: record.endedAt,
    });
    saveTurns();
  }
}

// ── HTML ──────────────────────────────────────────────────────────────
function buildSettingsHtml(config: AdminConfig): string {
  const PORT = config.port;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grandpa-bob settings</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --fg:#e2e8f0; --muted:#94a3b8; --accent:#3b82f6; --green:#10b981; --red:#ef4444; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 16px; max-width: 900px; margin: 0 auto; }
  .topnav { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .topnav a { color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 600; margin-left: auto; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 16px; margin: 24px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .card { background: var(--card); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.on { background: var(--green); }
  .dot.off { background: var(--red); }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input[type=text], input[type=password], textarea, select { width: 100%; padding: 10px 12px; background: #0b1224; color: var(--fg); border: 1px solid #334155; border-radius: 6px; font: 14px ui-monospace, monospace; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
  input.env-key { background: transparent; border: none; color: var(--muted); font: 12px ui-monospace, monospace; width: auto; min-width: 80px; padding: 0; }
  input.env-key:focus { outline: none; border-bottom: 1px solid var(--accent); color: var(--fg); }
  button { background: var(--accent); color: white; border: none; padding: 10px 18px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button.secondary { background: #475569; }
  button.danger { background: var(--red); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  pre { background: #0b1224; color: #cbd5e1; padding: 12px; border-radius: 6px; font: 12px ui-monospace, monospace; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .toast { position: fixed; top: 16px; right: 16px; background: var(--green); color: white; padding: 10px 16px; border-radius: 6px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.err { background: var(--red); }
  a { color: var(--accent); }
  small { color: var(--muted); }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 600px) { .grid-2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="topnav">
  <h1>grandpa-bob settings</h1>
  <a href="/">&larr; chat</a>
</div>

<div class="card">
  <div class="row">
    <span class="status"><span id="dot-bot" class="dot"></span> bot</span>
    <span class="status"><span id="dot-sherpa" class="dot"></span> sherpa-onnx</span>
    <span class="status"><span id="dot-admin" class="dot on"></span> admin (this)</span>
    <span style="margin-left:auto"><small id="uptime"></small></span>
  </div>
  <div class="actions">
    <button onclick="restartBot()">Restart bot</button>
    <button class="secondary" onclick="refreshAll()">Refresh</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Workspace sync</h2>
  <p style="margin:4px 0"><small>Push/pull the workspace to/from the desktop's git-daemon (port 9418). The bot auto-commits file changes; use these to sync with the desktop.</small></p>
  <label>Local branch → Remote branch</label>
  <div class="row">
    <input id="sync-local" type="text" value="master" placeholder="master" style="width:120px">
    <span style="color:var(--muted)">→</span>
    <input id="sync-remote" type="text" value="master" placeholder="master" style="width:120px">
  </div>
  <div id="sync-status" style="margin:8px 0; font:12px ui-monospace,monospace; color:var(--muted)">(not synced yet)</div>
  <div class="actions">
    <button onclick="gitCommit()">Commit workspace</button>
    <button onclick="gitPull()">Pull from desktop</button>
    <button onclick="gitPush()">Push to desktop</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Credentials &amp; .env</h2>
  <form id="envForm" onsubmit="saveEnv(event)">
    <div class="grid-2">
      <div>
        <label>Telegram bot token <span id="cur-token" style="float:right"></span></label>
        <input id="f-token" type="password" placeholder="123456:ABC-DEF...">
      </div>
      <div>
        <label>Your Telegram user ID <span id="cur-uid" style="float:right"></span></label>
        <input id="f-uid" type="text" inputmode="numeric" placeholder="123456789">
      </div>
    </div>
    <label>Hugging Face API key <span id="cur-hf" style="float:right"></span></label>
    <input id="f-hf" type="password" placeholder="hf_...">
    <label>Ollama API key <span id="cur-ollama" style="float:right"></span></label>
    <input id="f-ollama" type="password" placeholder="ollama-api-key...">
    <small>Shortcuts for the most common keys — every other key in <code>.env</code> is editable below.</small>
    <div class="actions">
      <button type="submit">Save credentials</button>
    </div>
  </form>
  <div style="margin:16px 0; border-top:1px solid var(--border,#334155)"></div>
  <h3 style="margin:0 0 8px; font-size:14px">All .env keys</h3>
  <p style="margin:0 0 8px"><small>Values visible. Edit a value, rename a key, add or remove keys. Changes apply after a bot restart.</small></p>
  <div id="env-keys">(loading...)</div>
  <div class="actions">
    <button class="secondary" onclick="addEnvKey()">+ Add key</button>
    <button onclick="saveAllEnv()">Save all keys</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Logs</h2>
  <div class="row" style="margin-bottom:8px">
    <button class="secondary" onclick="loadLog('bot')">bot.log</button>
    <button class="secondary" onclick="loadLog('sherpa')">sherpa.log</button>
    <span style="margin-left:auto"><small>last 60 lines</small></span>
  </div>
  <pre id="log">(click a log button)</pre>
</div>

<div class="card">
  <h2 style="margin-top:0">Tree patterns</h2>
  <p style="margin:4px 0"><small>grandma-kat Tree patterns (<code>.mjs</code>) in <code>workspace/patterns/</code>. The agent re-reads the active pattern on each turn — edit it to change behavior without restarting. The agent can also modify its own patterns using file tools. <b>Which one runs</b> is selected from the dropdown on the <a href="/" style="color:var(--accent)">chat page</a> (persisted as <code>TREE_PATTERN</code> in <code>.env</code>).</small></p>
  <div id="pattern-list">(loading...)</div>
  <div class="actions">
    <button class="secondary" onclick="refreshPatterns()">Refresh</button>
    <button onclick="showNewPattern()">New pattern</button>
  </div>
  <div id="pattern-editor" style="display:none; margin-top:12px">
    <label>Pattern name (no spaces, e.g. "my-pattern")</label>
    <input id="p-name" type="text" placeholder="my-pattern">
    <label>Pattern code (.mjs — export default async function)</label>
    <textarea id="p-code" style="width:100%; min-height:200px; background:#0b1224; color:#cbd5e1; border:1px solid #334155; border-radius:6px; padding:12px; font:12px ui-monospace,monospace; resize:vertical"></textarea>
    <div class="actions">
      <button onclick="savePattern()">Save pattern</button>
      <button class="secondary" onclick="hideNewPattern()">Cancel</button>
    </div>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Files</h2>
  <p style="margin:4px 0"><small>Browse, upload, and download files in the workspace.</small></p>
  <div id="file-nav" class="row" style="margin-bottom:8px; flex-wrap:wrap">
    <button class="secondary" onclick="filesBrowse()">↻ Refresh</button>
    <span id="file-path" style="margin-left:auto; font-size:12px; color:var(--muted)">/</span>
  </div>
  <div id="file-list" style="max-height:300px; overflow:auto; border:1px solid #334155; border-radius:6px; padding:8px; background:#0b1224; font:12px ui-monospace,monospace">(loading...)</div>
  <div class="actions" style="margin-top:8px">
    <input id="file-upload-input" type="file" style="display:none" onchange="uploadFile(this)" multiple />
    <button onclick="document.getElementById('file-upload-input').click()">Upload file</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Access</h2>
  <p style="margin:4px 0"><small>This UI runs on the phone at <code>http://0.0.0.0:${PORT}</code>.</small></p>
  <p style="margin:4px 0"><small>If you're on the same Wi-Fi, open <code>http://&lt;phone-ip&gt;:${PORT}</code> from your laptop.</small></p>
  <p style="margin:4px 0"><small>To expose to the internet, run an SSH reverse tunnel or use Termux's <code>pkg install cloudflared</code>.</small></p>
</div>

<div id="toast" class="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let startedAt = Date.now();
let envRows = []; // { key, orig, value, removed } — orig = key as loaded from .env
let currentDir = "";

function toast(msg, isErr, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => t.className = "toast" + (isErr ? " err" : ""), ms || (isErr ? 6000 : 3500));
}

function syncResult(r, done, failed) {
  const ok = r.ok !== false;
  $("sync-status").textContent = (ok ? "✓ " + done : "✗ " + failed) + (r.output ? "\\n" + r.output : "");
  $("sync-status").style.color = ok ? "var(--green)" : "var(--red)";
  toast(ok ? done : failed, !ok, ok ? 3500 : 8000);
}

async function api(path, opts) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { toast(data.error || \`HTTP \${r.status}\`, true); throw new Error(data.error); }
  return data;
}

async function refreshStatus() {
  const s = await api("/api/status");
  $("dot-bot").className = "dot " + (s.bot ? "on" : "off");
  $("dot-sherpa").className = "dot " + (s.sherpa ? "on" : "off");
  const env = s.env || {};
  $("cur-token").textContent  = env.TELEGRAM_BOT_TOKEN ? "current: " + env.TELEGRAM_BOT_TOKEN.slice(0,8) + "..." : "(unset)";
  $("cur-uid").textContent    = env.ALLOWED_USER_IDS    ? "current: " + env.ALLOWED_USER_IDS : "(unset)";
  $("cur-hf").textContent     = env.LLM_API_KEY         ? "current: " + env.LLM_API_KEY.slice(0,6) + "..." : "(unset)";
  $("cur-ollama").textContent = env.OLLAMA_API_KEY      ? "current: " + env.OLLAMA_API_KEY.slice(0,6) + "..." : "(unset)";
  // Populate the all-keys editor only when it's not holding unsaved edits.
  if (!envRows.length) {
    envRows = Object.entries(env).map(([key, value]) => ({ key, orig: key, value: String(value), removed: false }));
    renderEnvKeys();
  }
}

function renderEnvKeys() {
  const box = $("env-keys");
  if (!box) return;
  box.innerHTML = "";
  const rows = envRows.filter((r) => !r.removed);
  if (!rows.length) { box.textContent = "(no keys — add one below)"; return; }
  rows.forEach((r) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:10px";
    const lab = document.createElement("label");
    lab.style.cssText = "margin-top:0";
    const k = document.createElement("input");
    k.className = "env-key";
    k.value = r.key;
    k.placeholder = "KEY NAME";
    k.spellcheck = false;
    k.oninput = () => { r.key = k.value; };
    const del = document.createElement("button");
    del.className = "secondary";
    del.textContent = "×";
    del.title = "Remove this key";
    del.style.cssText = "float:right;padding:2px 10px";
    del.onclick = () => { r.removed = true; renderEnvKeys(); };
    const v = document.createElement("input");
    v.className = "env-val";
    v.type = "text";
    v.value = r.value;
    v.placeholder = "value";
    v.oninput = () => { r.value = v.value; };
    lab.append(k, del);
    wrap.append(lab, v);
    box.appendChild(wrap);
  });
}

function addEnvKey() {
  envRows.push({ key: "", orig: "", value: "", removed: false });
  renderEnvKeys();
}

function collectEnvUpdates() {
  const updates = {};
  for (const r of envRows) {
    if (r.removed) {
      if (r.key) updates[r.key] = null;
      continue;
    }
    const key = r.key.trim();
    if (!key) continue;
    if (r.orig && r.orig !== key && !(r.orig in updates)) updates[r.orig] = null;
    updates[key] = r.value;
  }
  return updates;
}

async function saveAllEnv() {
  const updates = collectEnvUpdates();
  if (!Object.keys(updates).length) { toast("nothing to change", true); return; }
  try {
    await api("/api/env", { method: "POST", body: JSON.stringify(updates) });
    toast("saved — restart the bot to apply");
    envRows = [];
    renderEnvKeys();
    await refreshStatus();
  } catch {}
}

async function refreshAll() {
  try { await refreshStatus(); toast("refreshed"); } catch (e) {}
}

async function saveEnv(e) {
  e.preventDefault();
  const body = {};
  if ($("f-token").value)  body.TELEGRAM_BOT_TOKEN = $("f-token").value;
  if ($("f-uid").value)    body.ALLOWED_USER_IDS    = $("f-uid").value;
  if ($("f-hf").value)     body.LLM_API_KEY         = $("f-hf").value;
  if ($("f-ollama").value) body.OLLAMA_API_KEY      = $("f-ollama").value;
  if (Object.keys(body).length === 0) { toast("nothing to save", true); return; }
  try {
    await api("/api/env", { method: "POST", body: JSON.stringify(body) });
    toast("saved");
    $("f-token").value = $("f-uid").value = $("f-hf").value = $("f-ollama").value = "";
    await refreshStatus();
  } catch {}
}

async function restartBot() {
  try { await api("/api/restart-bot", { method: "POST" }); toast("bot restarting..."); setTimeout(refreshStatus, 2000); } catch {}
}

async function gitCommit() {
  const msg = (prompt('Commit message (blank = "manual commit from admin UI"):') || "").trim();
  $("sync-status").textContent = "committing...";
  try {
    const r = await api("/api/commit", { method: "POST", body: JSON.stringify({ message: msg }) });
    const line = r.committed
      ? \`committed \${r.hash}\${r.output ? ":\\n" + r.output : ""}\`
      : (r.ok ? "nothing to commit (clean workspace)" : "error");
    $("sync-status").textContent = line;
    toast(r.ok ? (r.committed ? "committed " + r.hash : "workspace clean") : "commit failed", !r.ok);
  } catch (e) { $("sync-status").textContent = "error: " + e.message; }
}

async function gitPull() {
  const local = $("sync-local").value.trim() || "master";
  const remote = $("sync-remote").value.trim() || local;
  $("sync-status").textContent = "pulling " + remote + "...";
  $("sync-status").style.color = "var(--muted)";
  try {
    const r = await api("/api/sync/pull", { method: "POST", body: JSON.stringify({ local, remote }) });
    syncResult(r, "pulled " + remote, "pull failed: " + remote);
  } catch (e) { $("sync-status").textContent = "✗ " + e.message; $("sync-status").style.color = "var(--red)"; toast("pull failed", true, 8000); }
}

async function gitPush() {
  const local = $("sync-local").value.trim() || "master";
  const remote = $("sync-remote").value.trim() || local;
  $("sync-status").textContent = "pushing " + local + " → " + remote + "...";
  $("sync-status").style.color = "var(--muted)";
  try {
    const r = await api("/api/sync/push", { method: "POST", body: JSON.stringify({ local, remote }) });
    syncResult(r, "pushed " + local + " → " + remote, "push failed: " + local + " → " + remote);
  } catch (e) { $("sync-status").textContent = "error: " + e.message; $("sync-status").style.color = "var(--red)"; toast("push failed", true, 8000); }
}

async function loadLog(name) {
  try {
    const r = await api("/api/log?file=" + name);
    $("log").textContent = r.content || "(empty)";
  } catch {}
}

async function refreshPatterns() {
  try {
    const r = await api("/api/patterns");
    const list = $("pattern-list");
    if (r.patterns.length === 0) {
      list.innerHTML = '<small style="color:var(--muted)">No patterns yet. Click "New pattern" to create one.</small>';
      return;
    }
    list.innerHTML = r.patterns.map(p => {
      const name = p.name || p.file;
      const desc = p.description || "(no description)";
      return \`<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #334155">
        <div>
          <strong>\${name}</strong> <small style="color:var(--muted)">— \${desc}</small>
        </div>
        <div>
          <button class="secondary" style="padding:4px 8px; font-size:12px" onclick="viewPattern('\${name}')">View</button>
          <button class="danger" style="padding:4px 8px; font-size:12px" onclick="deletePattern('\${name}')">Delete</button>
        </div>
      </div>\`;
    }).join("");
  } catch {}
}

async function viewPattern(name) {
  try {
    const r = await api("/api/patterns/" + name);
    $("p-name").value = r.name || name;
    $("p-code").value = r.content || "";
    $("pattern-editor").style.display = "block";
  } catch {}
}

function showNewPattern() {
  $("p-name").value = "";
  $("p-code").value = \`// my-pattern.mjs — description of what this pattern does
//
// The function receives the Tree builder API as arguments.
// Available: { Tree, when, goback, max }
//
// Must return a Tree definition (the result of Tree.name(...).branch(...).until(...)).
//
// Memory slots available in prompt functions (m):
//   m.system      — the system prompt string
//   m.messages    — conversation history array [{role, content}, ...]
//   m.main_input  — the current user message
//   m.branch.X    — exported value of branch X
//   m.prev[i]     — most-recent-first sibling outputs
//   m.raw.prev[i] — full record: { content, reasoning, toolCalls, toolResults }
//   m.error       — feedback from last failed check

export default function({ Tree, when, goback, max }) {
  return Tree.name("my-pattern")
    .human("main_input")
    .prompt((m) => "You said: " + m.main_input + ". Respond briefly.")
    .emit((m) => m.prev[0])
    .until(() => false, max(100000));
}
\`;
  $("pattern-editor").style.display = "block";
}

function hideNewPattern() { $("pattern-editor").style.display = "none"; }

async function savePattern() {
  const name = $("p-name").value.trim();
  if (!name) { toast("pattern name required", true); return; }
  const content = $("p-code").value;
  if (!content.trim()) { toast("pattern code required", true); return; }
  try {
    await api("/api/patterns", { method: "POST", body: JSON.stringify({ name, content }) });
    toast("pattern saved");
    hideNewPattern();
    refreshPatterns();
  } catch {}
}

async function deletePattern(name) {
  if (!confirm(\`Delete pattern "\${name}"?\`)) return;
  try { await api("/api/patterns/" + name, { method: "DELETE" }); toast("pattern deleted"); refreshPatterns(); } catch {}
}

// ----- file browser -----
async function filesBrowse(dir) {
  if (dir !== undefined) currentDir = dir;
  try {
    const r = await api("/api/files?path=" + encodeURIComponent(currentDir));
    $("file-path").textContent = "/" + (r.dir || "(root)");
    const list = $("file-list");
    if (r.files.length === 0) {
      list.innerHTML = '<small style="color:var(--muted)">(empty directory)</small>';
      return;
    }
    list.innerHTML = r.files.map(f => {
      const size = f.isDir ? "dir" : formatSize(f.size);
      const mtime = f.mtime ? new Date(f.mtime).toLocaleString() : "";
      const click = f.isDir ? \`onclick="filesBrowse('\${escPath(r.dir, f.name)}')"\` : "";
      const dl = !f.isDir ? \`<a href="/api/files/download?path=\${escPath(r.dir, f.name)}" style="color:var(--accent); text-decoration:none; font-size:11px">↓</a>\` : "";
      const rm = !f.isDir ? \`<button class="danger" style="padding:2px 6px; font-size:11px" onclick="delFile('\${escPath(r.dir, f.name)}','\${f.name}')">×</button>\` : "";
      return \`<div style="display:flex; align-items:center; padding:3px 0; border-bottom:1px solid #1e293b">
        <span \${click} style="cursor:\${f.isDir?'pointer':'default'}; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          \${f.isDir ? '📁 ' : '📄 '}\${f.name}
        </span>
        <span style="width:60px; text-align:right; color:var(--muted); font-size:11px">\${size}</span>
        <span style="width:140px; text-align:right; color:var(--muted); font-size:11px">\${mtime}</span>
        <span style="width:30px; text-align:center">\${dl}\${rm}</span>
      </div>\`;
    }).join("");
  } catch (e) { $("file-list").textContent = "error: " + e.message; }
}

function escPath(dir, name) {
  const p = dir ? dir + "/" + name : name;
  return p.replace(/'/g, "\\'");
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

async function delFile(p, name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try { await api("/api/files?path=" + encodeURIComponent(p), { method: "DELETE" }); toast("deleted " + name); filesBrowse(); } catch {}
}

async function uploadFile(input) {
  const files = input.files;
  if (!files.length) return;
  for (const file of files) {
    const fd = new FormData();
    fd.append("path", currentDir);
    fd.append("file", file);
    try {
      const r = await fetch("/api/files/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) { toast(d.error || "upload failed", true); continue; }
      toast("uploaded " + file.name);
    } catch (e) { toast("upload failed: " + e.message, true); }
  }
  input.value = "";
  filesBrowse();
}

setInterval(() => {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  $("uptime").textContent = \`uptime: \${m}m \${s}s\`;
}, 1000);

refreshStatus();
refreshPatterns();
filesBrowse();
</script>
</body>
</html>
`;
}

// ── chat front page ───────────────────────────────────────────────────
function buildChatHtml(config: AdminConfig, sttLabel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grandpa-bob</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --fg:#e2e8f0; --muted:#94a3b8; --accent:#3b82f6; --green:#10b981; --red:#ef4444; --border:#334155; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100dvh; }
  header { display: flex; align-items: baseline; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: #0b1224; }
  header h1 { font-size: 17px; margin: 0; }
  header .sub { color: var(--muted); font-size: 12px; }
  header nav { margin-left: auto; }
  header nav a { color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 600; }
  #pattern-sel { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; padding: 3px 6px; }
  main { flex: 1; overflow-y: auto; padding: 16px; }
  .inner { max-width: 860px; margin: 0 auto; }
  .empty { color: var(--muted); text-align: center; margin-top: 18vh; font-size: 15px; }
  .turn { margin-bottom: 20px; }
  .msg-user { display: flex; justify-content: flex-end; margin: 6px 0; }
  .msg-user .bubble { background: #1d4ed8; color: #fff; padding: 8px 14px; border-radius: 14px 14px 4px 14px; max-width: 85%; white-space: pre-wrap; word-break: break-word; }
  .msg-user .qtag { align-self: center; margin-right: 8px; font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; }
  .heard { color: var(--muted); font-size: 12.5px; font-style: italic; margin: 6px 2px; }
  .steps { background: var(--card); border: 1px solid var(--border); border-radius: 8px; margin: 8px 0; }
  .steps > summary { cursor: pointer; padding: 8px 12px; color: var(--muted); font-size: 12px; display: flex; gap: 8px; align-items: center; list-style: none; }
  .steps > summary::-webkit-details-marker { display: none; }
  .steps .count { margin-left: auto; font-family: ui-monospace, monospace; }
  .steps .copy-log { flex: none; font: inherit; font-size: 11px; color: var(--muted); background: transparent; border: 1px solid var(--border); border-radius: 5px; padding: 1px 8px; cursor: pointer; }
  .steps .copy-log:hover { color: var(--fg); border-color: var(--accent); }
  .spinner { width: 12px; height: 12px; flex: none; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .step-list { margin: 0; padding: 4px 12px 10px; list-style: none; border-top: 1px solid var(--border); }
  .step { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .step details > summary { cursor: pointer; padding: 3px 0; display: flex; gap: 8px; align-items: baseline; list-style: none; }
  .step details > summary::-webkit-details-marker { display: none; }
  .badge { flex: none; min-width: 58px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; background: #334155; color: var(--fg); text-transform: uppercase; }
  .step-id { color: #94a3b8; font-size: 11px; flex: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spath { color: #64748b; font-size: 11px; flex: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stext { color: #cbd5e1; word-break: break-word; }
  .step pre { margin: 2px 0 8px 66px; padding: 8px; background: #0b1224; border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all; color: #94a3b8; max-height: 240px; overflow: auto; }
  .k-llm .badge { background: #155e75; }
  .k-tool .badge { background: #713f12; }
  .k-result .badge { background: #14532d; }
  .k-emit .badge { background: #065f46; color: #6ee7b7; }
  .k-emit .stext { color: #a7f3d0; font-weight: 600; }
  .k-human .badge { background: #374151; color: #fff; }
  .k-flow .badge { background: #1e3a8a; }
  .k-check .badge { background: #4a044e; }
  .k-loop .badge { background: #4a044e; }
  .k-memory .badge { background: #312e81; }
  .k-err .badge { background: #7f1d1d; }
  .k-err .stext { color: #fca5a5; }
  .k-dim .badge { background: #1f2937; color: var(--muted); }
  .k-dim .stext { color: var(--muted); }
  .k-map .badge { background: #3730a3; }
  .k-map .stext { color: #c7d2fe; }
  .k-map-item .badge { background: #1e1b4b; }
  .step-list.nested { border-top: none; padding: 0 0 6px 12px; }
  .msg-answer { display: flex; gap: 8px; margin: 8px 0; align-items: flex-start; }
  .msg-answer .who { flex: none; font-size: 12px; font-weight: 700; color: var(--green); padding-top: 10px; }
  .msg-answer .bubble { background: var(--card); border: 1px solid var(--border); border-radius: 4px 14px 14px 14px; padding: 10px 14px; max-width: 90%; white-space: pre-wrap; word-break: break-word; }
  .msg-error { color: #fca5a5; border: 1px solid #7f1d1d; background: #450a0a; border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-size: 13px; white-space: pre-wrap; }
  footer { border-top: 1px solid var(--border); background: #0b1224; padding: 10px 16px 12px; }
  .input-row { display: flex; gap: 8px; max-width: 860px; margin: 0 auto; align-items: flex-end; }
  textarea { flex: 1; resize: none; padding: 10px 12px; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; font: 15px system-ui; max-height: 140px; }
  textarea:focus { outline: none; border-color: var(--accent); }
  button { background: var(--accent); color: #fff; border: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button.secondary { background: #475569; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  #mic-btn { background: #475569; font-size: 16px; padding: 8px 14px; }
  #mic-btn.recording { background: var(--red); animation: pulse 1.2s ease-in-out infinite; }
  #file-btn { background: #475569; font-size: 15px; padding: 8px 14px; }
  @keyframes pulse { 50% { opacity: 0.6; } }
  #mic-timer { align-self: center; font-size: 12px; color: var(--muted); min-width: 28px; }
  .file-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
  .file-card .fc-head { display: flex; gap: 8px; align-items: center; font-size: 13px; }
  .file-card .fc-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-card .fc-status { margin-left: auto; color: var(--muted); font-size: 12px; flex: none; }
  .file-card .fc-text { margin-top: 6px; font-size: 13.5px; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; }
  .file-card.done .fc-text { color: var(--fg); }
  .file-card.err { border-color: #7f1d1d; }
  .file-card.err .fc-text { color: #fca5a5; }
  .foot-note { max-width: 860px; margin: 6px auto 0; font-size: 11px; color: #64748b; display: flex; gap: 10px; }
  .foot-note .right { margin-left: auto; }
  .toast { position: fixed; top: 16px; right: 16px; background: var(--green); color: #fff; padding: 10px 16px; border-radius: 6px; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 10; }
  .toast.show { opacity: 1; }
  .toast.err { background: var(--red); }
  #tree-btn { background: #475569; font-size: 12px; padding: 4px 10px; }
  #internals-btn { background: #475569; font-size: 12px; padding: 4px 10px; }
  #internals-btn.on { background: #2563eb; color: #fff; }
  body:not(.show-internals) .step.k-internals { display: none; }
  #tree-panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(430px, 92vw); background: #0b1224; border-left: 1px solid var(--border); transform: translateX(105%); transition: transform 0.22s ease; z-index: 21; display: flex; flex-direction: column; }
  #tree-panel.open { transform: none; box-shadow: 0 0 40px rgba(0,0,0,0.5); }
  .tp-head-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .tp-head-row h2 { font-size: 14px; margin: 0; }
  .tp-head-row .tp-cur { color: var(--muted); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #tree-close { background: #475569; padding: 4px 10px; font-size: 12px; }
  #tree-body { flex: 1; overflow: auto; padding: 10px 12px; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tp-meta { color: #64748b; font-size: 11px; margin: 4px 0 8px; white-space: pre-wrap; }
  .tp-children { list-style: none; margin: 0; padding-left: 14px; border-left: 1px dashed #334155; }
  .tp-node { margin: 2px 0; border-radius: 6px; }
  .tp-node > details > summary, .tp-row { display: flex; gap: 6px; align-items: baseline; padding: 2px 4px; border-radius: 5px; list-style: none; }
  .tp-node > details > summary { cursor: pointer; }
  .tp-node > details > summary::-webkit-details-marker { display: none; }
  .tp-badge { flex: none; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; background: #334155; padding: 1px 5px; border-radius: 4px; min-width: 52px; text-align: center; }
  .tp-name { color: #e2e8f0; font-weight: 600; }
  .tp-gate { color: #94a3b8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tp-body { margin: 2px 0 6px 8px; }
  .tp-info { display: flex; gap: 6px; margin: 2px 0; }
  .tp-k { flex: none; color: #64748b; font-size: 10px; text-transform: uppercase; min-width: 48px; }
  .tp-v { margin: 0; color: #94a3b8; font-size: 11px; white-space: pre-wrap; word-break: break-word; flex: 1; max-height: 160px; overflow: auto; }
  .tp-node.k-prompt .tp-badge { background: #155e75; }
  .tp-node.k-human .tp-badge { background: #374151; color: #fff; }
  .tp-node.k-emit .tp-badge { background: #065f46; color: #6ee7b7; }
  .tp-node.k-branch .tp-badge, .tp-node.k-map .tp-badge { background: #1e3a8a; }
  .tp-node.k-until .tp-badge, .tp-node.k-check .tp-badge { background: #4a044e; }
  .tp-node.k-memory .tp-badge, .tp-node.k-memoryUpdate .tp-badge { background: #312e81; }
  .tp-node.k-call .tp-badge { background: #713f12; }
  .tp-node.tp-visited .tp-badge { background: #14532d; }
  .tp-node.tp-active { background: rgba(30,58,138,0.35); outline: 1px solid var(--accent); }
  .tp-node.tp-active > details > summary .tp-badge, .tp-node.tp-active > .tp-row .tp-badge { background: var(--accent); }
  .tp-empty { color: var(--muted); }
  .tp-mem-btn { text-align: left; background: none; border: none; padding: 0; font: inherit; cursor: pointer; color: #a5b4fc; }
  .tp-mem-btn:hover { text-decoration: underline; }
  #mem-popup { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; background: rgba(2,6,23,0.72); }
  #mem-popup .mem-box { width: min(720px, 94vw); max-height: 84vh; display: flex; flex-direction: column; background: #0b1224; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  #mem-popup .mem-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  #mem-popup .mem-head h3 { font-size: 13px; margin: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #mem-popup .mem-head button { background: #475569; padding: 3px 10px; font-size: 12px; border: 0; border-radius: 5px; color: #e2e8f0; cursor: pointer; }
  #mem-popup .mem-body { flex: 1; overflow: auto; padding: 12px 14px; }
  #mem-popup pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd5e1; }
</style>
</head>
<body>
<header>
  <h1>grandpa-bob</h1>
  <span class="sub">${sttLabel}</span>
  <select id="pattern-sel" title="tree pattern to run (patterns/*.mjs)"></select>
  <button id="tree-btn" title="show the structure of the active tree">tree</button>
  <button id="internals-btn" title="show runtime bookkeeping steps (record, scope)">internals</button>
  <nav><a href="/settings">settings</a></nav>
</header>
<main id="main"><div class="inner" id="conversation"></div></main>
<footer>
  <div class="input-row">
    <button id="mic-btn" title="hold a conversation by voice">&#127908;</button>
    <span id="mic-timer"></span>
    <button id="file-btn" title="attach a file">&#128206;</button>
    <input id="file-input" type="file" style="display:none">
    <textarea id="input" rows="1" placeholder="type a message&hellip;" enterkeyhint="send"></textarea>
    <button id="send-btn">Send</button>
  </div>
  <div class="foot-note">
    <span>Enter to send &middot; Shift+Enter for a new line</span>
    <span class="right"><button id="clear-btn" class="secondary" style="padding:2px 10px;font-size:12px">clear conversation</button></span>
  </div>
</footer>
<div id="toast" class="toast"></div>
<aside id="tree-panel" aria-label="tree structure">
  <div class="tp-head-row">
    <h2>tree</h2>
    <span class="tp-cur" id="tp-pattern"></span>
    <button id="tree-close">close</button>
  </div>
  <div id="tree-body"><div class="tp-empty">loading&hellip;</div></div>
</aside>
<script>
const $ = (id) => document.getElementById(id);
const conv = $("conversation");
const mainEl = $("main");
const blocks = new Map(); // turnId -> live turn block

function toast(msg, isErr, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => (t.className = "toast" + (isErr ? " err" : "")), ms || (isErr ? 6000 : 3000));
}

function short(s, n) {
  if (s === null || s === undefined) return "";
  s = String(s).replace(/\\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "\\u2026" : s;
}
function jshort(v, n) { return short(typeof v === "string" ? v : JSON.stringify(v), n ?? 120); }

function maybeScroll(force) {
  const nearBottom = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 140;
  if (force || nearBottom) mainEl.scrollTop = mainEl.scrollHeight;
}

function hideEmpty() {
  const hint = $("empty-hint");
  if (hint) hint.remove();
}
function showEmpty() {
  if (conv.querySelector(".turn, .msg-user, .heard")) return;
  const hint = document.createElement("div");
  hint.className = "empty";
  hint.id = "empty-hint";
  hint.textContent = "Say something \\u2014 type it, or tap the mic. Every step the tree takes appears under your message.";
  conv.appendChild(hint);
}

function describeEvent(ev) {
  const c = ev.content || {};
  const iter = ev.iteration > 1 ? " #" + ev.iteration : "";
  switch (ev.kind) {
    case "human":
      return { badge: "human", cls: "k-human", text: (c.child ?? "?") + " \\u2014 paused, waiting for input" };
    case "llm_call": {
      let t = (c.model ?? "?") + (c.round > 1 ? " round " + c.round : "") + iter;
      if (c.messages?.count) t += " (input: " + c.messages.count + " msgs)";
      if (Array.isArray(c.toolCalls) && c.toolCalls.length) {
        t += " \\u2192 tool calls: " + c.toolCalls.map((tc) => tc.name ?? tc.function?.name ?? "?").join(", ");
      } else if (c.content) {
        t += " \\u2192 " + jshort(c.content, 160);
      }
      return { badge: "llm", cls: "k-llm", text: t };
    }
    case "llm_error":
      return { badge: "llm-err", cls: "k-err", text: (c.model ?? "?") + " failed: " + jshort(c.error, 160) };
    case "tool_call":
      return {
        badge: "tool", cls: "k-tool",
        text: (c.tool ?? "?") + (c.args ? "(" + jshort(JSON.stringify(c.args), 80) + ")" : "") +
          (c.result !== undefined ? " \\u2192 " + jshort(c.result, 100) : ""),
      };
    case "tool_result":
      return {
        badge: c.isError ? "error" : "result", cls: c.isError ? "k-err" : "k-result",
        text: (c.tool ?? "?") + " \\u2192 " + jshort(c.result, 160),
      };
    case "tool_error":
      return { badge: "error", cls: "k-err", text: (c.tool ?? "?") + " failed: " + jshort(c.error, 160) };
    case "check":
      return { badge: "check", cls: c.pass ? "k-check" : "k-err", text: (c.child ?? "?") + (c.pass ? " \\u2014 pass" : " \\u2014 FAIL: " + jshort(c.feedback, 120)) };
    case "until":
      return { badge: "until", cls: c.pass ? "k-check" : "k-loop", text: (c.child ?? "?") + (c.pass ? " \\u2014 done" : " \\u2014 loop: " + jshort(c.feedback, 120)) };
    case "gate":
      return { badge: "gate", cls: "k-flow", text: (c.child ?? "?") + " \\u2192 " + jshort(c.result, 80) };
    case "flow":
      return {
        badge: "flow", cls: "k-flow",
        text: (c.type ?? "?") + (c.n ? "(" + c.n + ")" : "") + (c.child ? " from " + c.child : "") + (c.used ? " (" + c.used + "/" + (c.max ?? "?") + ")" : ""),
      };
    case "memory":
      return { badge: "memory", cls: "k-memory", text: (c.child ?? "?") + " = " + jshort(c.value, 100) };
    case "emit":
      return { badge: "emit", cls: "k-emit", text: jshort(c.value, 200) };
    case "record":
      // Memory writes are record rows with an op flag; they stay visible.
      if (c.op === "memory" || c.op === "memoryUpdate") {
        return { badge: "memory", cls: "k-memory", text: (c.child ?? "?") + " = " + jshort(c.value, 100) };
      }
      return { badge: "record", cls: "k-dim", internals: true, text: (c.child ?? "?") + " = " + jshort(c.value, 80) };
    case "scope_init":
      return { badge: "scope", cls: "k-dim", internals: true, text: "#" + c.scopeId + (c.parentScopeId != null ? " (parent #" + c.parentScopeId + ")" : "") };
    case "map":
      return { badge: "map", cls: "k-dim", text: (c.child ?? "?") + " \\u2014 " + c.count + " item(s)" };
    case "map_item":
      return { badge: "map", cls: "k-dim", text: (c.child ?? "?") + "[" + c.index + "] = " + jshort(c.value, 80) };
    case "return":
      return { badge: "return", cls: "k-dim", text: (c.child ?? "?") + " = " + jshort(c.value, 80) };
    default:
      return { badge: ev.kind, cls: "k-dim", text: jshort(JSON.stringify(c), 120) };
  }
}

function collectStepLines(list, depth, lines) {
  for (const li of Array.from(list.children)) {
    if (!li.classList || !li.classList.contains("step")) continue;
    const sum = li.querySelector(":scope > details > summary");
    if (sum) {
      const badge = sum.querySelector(".badge")?.textContent ?? "?";
      const id = sum.querySelector(".step-id")?.textContent ?? "";
      const path = sum.querySelector(".spath")?.textContent ?? "";
      const text = sum.querySelector(".stext")?.textContent ?? "";
      lines.push("    ".repeat(depth) + [badge, id, path, text].filter(Boolean).join(" "));
    }
    const pre = li.querySelector(":scope > details > pre");
    if (pre?.textContent) {
      lines.push(...pre.textContent.split("\\n").map((line) => "    ".repeat(depth + 1) + line));
    }
    const nested = li.querySelector(":scope > details > .step-list");
    if (nested) collectStepLines(nested, depth + 1, lines);
    lines.push("");
  }
}

function turnLogText(turn) {
  const lines = [];
  const input = turn.querySelector(".msg-user .bubble");
  if (input) lines.push("[user] " + input.textContent, "");
  const list = turn.querySelector(".step-list");
  if (list) collectStepLines(list, 0, lines);
  const answer = turn.querySelector(".msg-answer .bubble");
  if (answer) lines.push("[bob] " + answer.textContent);
  const err = turn.querySelector(".msg-error");
  if (err) lines.push("[error] " + err.textContent);
  return lines.join("\\n").trim();
}

async function copyTurnLog(turn, btn) {
  const text = turnLogText(turn);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = "copied";
  setTimeout(() => (btn.textContent = old), 1200);
}

function startTurn(turnId, input) {
  hideEmpty();
  const pending = conv.querySelector('.msg-user.pending[data-turnid="' + turnId + '"]');
  const turn = document.createElement("div");
  turn.className = "turn";

  const userMsg = document.createElement("div");
  userMsg.className = "msg-user";
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.textContent = input;
  userMsg.appendChild(bub);
  turn.appendChild(userMsg);

  const steps = document.createElement("details");
  steps.className = "steps";
  steps.open = true;
  const sum = document.createElement("summary");
  const spin = document.createElement("span");
  spin.className = "spinner";
  const lab = document.createElement("span");
  lab.textContent = "running tree\\u2026";
  const cnt = document.createElement("span");
  cnt.className = "count";
  const copy = document.createElement("button");
  copy.className = "copy-log";
  copy.type = "button";
  copy.textContent = "copy";
  copy.title = "Copy the full conversation log for this turn";
  copy.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyTurnLog(turn, copy);
  });
  sum.append(spin, lab, cnt, copy);
  const list = document.createElement("ol");
  list.className = "step-list";
  steps.append(sum, list);
  turn.appendChild(steps);

  if (pending) pending.replaceWith(turn);
  else conv.appendChild(turn);

  const block = { turn, list, spin, lab, cnt };
  blocks.set(turnId, block);
  maybeScroll(true);
  return block;
}

function renderStepLi(ev) {
  const d = describeEvent(ev);
  const li = document.createElement("li");
  li.className = "step " + d.cls;
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = d.badge;
  const content = ev.content || {};
  const identity = content.child ?? content.name ??
    (content.scopeId != null ? "#" + content.scopeId : "");
  const id = document.createElement("span");
  id.className = "step-id";
  id.textContent = identity ? String(identity) : "";
  const sp = document.createElement("span");
  sp.className = "spath";
  sp.textContent = ev.branch_path ? "[" + ev.branch_path + "]" : "";
  const txt = document.createElement("span");
  txt.className = "stext";
  txt.textContent = d.text;
  sum.append(badge, id, sp, txt);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(ev.content, null, 2);
  det.append(sum, pre);
  li.appendChild(det);
  if (d.internals) li.classList.add("k-internals");
  return li;
}

// ---- map runs ----------------------------------------------------------
// A .map() runs its subtree once per item, so an import logs thousands of
// rows. Each map run collapses into one block; its items become one row each
// (all of the item's events live in that row's details).

// Walk a scope's parents (scope_init events) looking for an ancestor.
function inScope(block, scopeId, ancestorId) {
  if (scopeId == null || ancestorId == null) return false;
  let s = scopeId;
  for (let i = 0; i < 64; i++) {
    if (s === ancestorId) return true;
    s = block.scopeParent.get(s);
    if (s == null) return false;
  }
  return false;
}

function mapItemLi(events, item) {
  const li = document.createElement("li");
  li.className = "step k-map-item";
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  const badge = document.createElement("span");
  badge.className = "badge";
  const tool = events.find((e) => e.kind === "tool_call");
  badge.textContent = tool?.content?.tool ? String(tool.content.tool) : "map";
  const id = document.createElement("span");
  id.className = "step-id";
  id.textContent = "[" + (item.content?.index ?? "?") + "]";
  const txt = document.createElement("span");
  txt.className = "stext";
  txt.textContent = jshort(item.content?.value, 120);
  sum.append(badge, id, txt);
  const pre = document.createElement("pre");
  pre.textContent = [...events, item]
    .map((e) => "// " + e.kind + (e.branch_path ? " [" + e.branch_path + "]" : "") +
      "\\n" + JSON.stringify(e.content, null, 2))
    .join("\\n\\n");
  det.append(sum, pre);
  li.appendChild(det);
  return li;
}

function openMapGroup(block, scopeId, child) {
  const li = document.createElement("li");
  li.className = "step k-map";
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "map";
  const id = document.createElement("span");
  id.className = "step-id";
  id.textContent = child;
  const txt = document.createElement("span");
  txt.className = "stext";
  txt.textContent = "running\\u2026";
  sum.append(badge, id, txt);
  const body = document.createElement("ol");
  body.className = "step-list nested";
  det.append(sum, body);
  li.appendChild(det);
  block.list.appendChild(li);
  const group = { scopeId, child, body, txt, buffer: [], count: 0 };
  block.maps.push(group);
  return group;
}

function flushMapItem(block, group, item) {
  group.body.appendChild(mapItemLi(group.buffer, item));
  group.buffer = [];
  group.count++;
  group.txt.textContent = group.count + " item(s)";
  updateCount(block);
  maybeScroll(false);
}

function finishMap(block, group, ev) {
  for (const e of group.buffer) group.body.appendChild(renderStepLi(e));
  group.buffer = [];
  group.txt.textContent = group.count + " item(s)";
  if (block.maps[block.maps.length - 1] === group) block.maps.pop();
  updateCount(block);
  maybeScroll(false);
}

// Map items stream their events before the closing map/map_item event, so the
// first item's rows were already rendered. Move them into the group buffer.
function adoptRendered(block, group) {
  const adopted = [];
  for (let i = block.rendered.length - 1; i >= 0; i--) {
    const r = block.rendered[i];
    if (!inScope(block, r.ev.scope_id, group.scopeId)) break;
    r.li.remove();
    adopted.push(r.ev);
    block.rendered.splice(i, 1);
  }
  adopted.reverse();
  group.buffer = adopted.concat(group.buffer);
}

function addStep(turnId, ev) {
  const block = blocks.get(turnId);
  if (!block) return;
  if (!block.scopeParent) block.scopeParent = new Map();
  if (!block.rendered) block.rendered = [];
  if (!block.maps) block.maps = [];

  if (ev.kind === "scope_init" && ev.content && ev.content.scopeId != null) {
    block.scopeParent.set(ev.content.scopeId, ev.content.parentScopeId ?? null);
  }

  const top = block.maps[block.maps.length - 1];
  // Events persisted before scope_id was logged have none; render them flat
  // rather than grouping them half-way.
  const ownMapEvent = top && ev.scope_id != null && ev.scope_id === top.scopeId;

  if (ownMapEvent && ev.kind === "map" && ev.content?.child === top.child) {
    finishMap(block, top, ev);
    return;
  }
  if (ownMapEvent && ev.kind === "map_item") {
    flushMapItem(block, top, ev);
    return;
  }
  if (top && inScope(block, ev.scope_id, top.scopeId)) {
    top.buffer.push(ev);
    return;
  }
  if (ev.kind === "map_item" && ev.scope_id != null) {
    // First item of a map run: open the block, adopt its already-rendered
    // events, then add its row.
    const group = openMapGroup(block, ev.scope_id, ev.content?.child ?? "?");
    adoptRendered(block, group);
    flushMapItem(block, group, ev);
    return;
  }
  if (ev.kind === "map" && ev.scope_id != null) {
    const group = openMapGroup(block, ev.scope_id, ev.content?.child ?? "?");
    adoptRendered(block, group);
    finishMap(block, group, ev);
    return;
  }

  const li = renderStepLi(ev);
  block.list.appendChild(li);
  block.rendered.push({ ev, li });
  updateCount(block);
  maybeScroll(false);
}

function emitToTurn(turnId, text) {
  const block = blocks.get(turnId);
  if (!block) return;
  if (!block.answerBub) {
    const ans = document.createElement("div");
    ans.className = "msg-answer";
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = "bob";
    const bub = document.createElement("div");
    bub.className = "bubble";
    ans.append(who, bub);
    block.turn.appendChild(ans);
    block.answerBub = bub;
  }
  block.answerBub.textContent = block.answerBub.textContent
    ? block.answerBub.textContent + "\\n\\n" + text
    : text;
  maybeScroll(false);
}

function endTurn(turnId, status, error, output) {
  const block = blocks.get(turnId);
  if (!block) return;
  blocks.delete(turnId);
  block.spin.remove();
  block.lab.textContent = status === "error" ? "tree failed" : "tree steps";
  if (status === "error") {
    const errEl = document.createElement("div");
    errEl.className = "msg-error";
    errEl.textContent = "Something went wrong: " + (error || "unknown error");
    block.turn.appendChild(errEl);
  }
  if (output) {
    if (block.answerBub) {
      // The bubble streamed live; settle on the server's final text so
      // anything a rewound branch emitted disappears again.
      block.answerBub.textContent = output;
    } else {
      const ans = document.createElement("div");
      ans.className = "msg-answer";
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = "bob";
      const bub = document.createElement("div");
      bub.className = "bubble";
      bub.textContent = output;
      ans.append(who, bub);
      block.turn.appendChild(ans);
    }
  }
  maybeScroll(true);
}

function addPending(turnId, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg-user pending";
  wrap.dataset.turnid = turnId;
  const tag = document.createElement("span");
  tag.className = "qtag";
  tag.textContent = "queued";
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.textContent = text;
  wrap.append(tag, bub);
  conv.appendChild(wrap);
  maybeScroll(true);
}

async function sendText(text) {
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "send failed", true); return; }
    if (d.queued) addPending(d.turnId, text);
    hideEmpty();
  } catch (e) {
    toast("send failed: " + e.message, true);
  }
}

async function uploadAttachment(file) {
  const caption = input.value.trim();
  const fd = new FormData();
  fd.append("file", file);
  if (caption) fd.append("caption", caption);
  try {
    const r = await fetch("/api/chat/upload", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "upload failed", true); return; }
    const display = caption ? caption + "\\n[attached: " + file.name + "]" : "[attached: " + file.name + "]";
    if (d.queued) addPending(d.turnId, display);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    hideEmpty();
  } catch (e) {
    toast("upload failed: " + e.message, true);
  }
}

// ---- input box ----
const input = $("input");
$("send-btn").onclick = doSend;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
});
function doSend() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  sendText(text);
}

// ---- voice input (MediaRecorder -> /api/transcribe -> auto-send) ----
const micBtn = $("mic-btn");
const micTimer = $("mic-timer");
const canMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
if (!canMic) {
  micBtn.disabled = true;
  micBtn.title = "voice input needs a secure context (localhost or https)";
}
let rec = null, recStream = null, recChunks = [], recInt = null, recSecs = 0;

micBtn.onclick = async () => {
  if (rec && rec.state === "recording") { rec.stop(); return; }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("microphone unavailable: " + e.message, true, 8000);
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
    .find((t) => MediaRecorder.isTypeSupported(t)) || "";
  rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = onRecStop;
  rec.start();
  recSecs = 0;
  micBtn.classList.add("recording");
  micTimer.textContent = "0s";
  recInt = setInterval(() => { recSecs++; micTimer.textContent = recSecs + "s"; }, 1000);
};

async function onRecStop() {
  clearInterval(recInt);
  micBtn.classList.remove("recording");
  micTimer.textContent = "";
  if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
  const mimeType = rec.mimeType || "audio/webm";
  const blob = new Blob(recChunks, { type: mimeType });
  rec = null;
  if (!blob.size) return;
  if (recSecs < 1) { toast("recording too short", true); return; }
  toast("transcribing\\u2026", false, 2000);
  const fd = new FormData();
  fd.append("file", blob, "voice" + (mimeType.includes("mp4") ? ".mp4" : ".webm"));
  try {
    const r = await fetch("/api/transcribe", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "transcription failed", true, 8000); return; }
    hideEmpty();
    const heard = document.createElement("div");
    heard.className = "heard";
    heard.textContent = 'heard: "' + d.text + '"';
    conv.appendChild(heard);
    maybeScroll(true);
    sendText(d.text);
  } catch (e) {
    toast("transcription failed: " + e.message, true, 8000);
  }
}

// ---- audio file upload with streaming transcription ----
$("file-btn").onclick = () => $("file-input").click();
$("file-input").addEventListener("change", () => {
  const file = $("file-input").files[0];
  $("file-input").value = "";
  if (!file) return;
  if (file.type.startsWith("audio/") || /\.(ogg|oga|opus|webm|mp3|m4a|mp4|wav|flac)$/i.test(file.name)) {
    transcribeFile(file);
  } else {
    uploadAttachment(file);
  }
});

async function transcribeFile(file) {
  hideEmpty();
  const card = document.createElement("div");
  card.className = "file-card";
  const head = document.createElement("div");
  head.className = "fc-head";
  const spin = document.createElement("span");
  spin.className = "spinner";
  const name = document.createElement("span");
  name.className = "fc-name";
  name.textContent = file.name;
  const status = document.createElement("span");
  status.className = "fc-status";
  status.textContent = "uploading\\u2026";
  head.append(spin, name, status);
  const textEl = document.createElement("div");
  textEl.className = "fc-text";
  card.append(head, textEl);
  conv.appendChild(card);
  maybeScroll(true);

  const fd = new FormData();
  fd.append("file", file);
  let duration = 0, finalText = "";
  try {
    const res = await fetch("/api/transcribe-stream", { method: "POST", body: fd });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || "HTTP " + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\\n\\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\\n")) {
          if (!line.startsWith("data: ")) continue;
          let msg;
          try { msg = JSON.parse(line.slice(6)); } catch { continue; }
          if (msg.type === "info") {
            duration = msg.duration || 0;
            status.textContent = duration ? "0s / " + duration + "s" : "transcribing\\u2026";
          } else if (msg.type === "partial") {
            textEl.textContent = msg.text;
            if (duration && msg.at != null) status.textContent = Math.min(msg.at, duration) + "s / " + duration + "s";
            maybeScroll(false);
          } else if (msg.type === "done") {
            finalText = msg.text;
          } else if (msg.type === "error") {
            throw new Error(msg.error || "transcription failed");
          }
        }
      }
    }
    if (!finalText) throw new Error("transcription came back empty");
    spin.remove();
    card.classList.add("done");
    status.textContent = "transcribed" + (duration ? " (" + duration + "s)" : "");
    textEl.textContent = finalText;
    input.value = finalText;
    input.dispatchEvent(new Event("input"));
    input.focus();
    toast("transcript ready \\u2014 review and press Send");
  } catch (e) {
    spin.remove();
    card.classList.add("err");
    status.textContent = "failed";
    textEl.textContent = e.message;
    toast("transcription failed: " + e.message, true, 8000);
  }
  maybeScroll(true);
}

// ---- clear ----
$("clear-btn").onclick = async () => {
  if (!confirm("Clear this conversation? The next message starts a fresh tree.")) return;
  try {
    const r = await fetch("/api/clear", { method: "POST" });
    if (!r.ok) toast("clear failed", true);
  } catch (e) { toast("clear failed: " + e.message, true); }
};

// ---- tree structure side panel ----
const treePanel = $("tree-panel");
const treeBody = $("tree-body");
let treeLoadedFor = null;
const treeVisited = new Set(); // node paths hit during the current turn
let treeActive = null;         // node path of the latest event
// Current memory values, keyed by node path. Seeded/refreshed from
// /api/tree/memory (full values); the per-node DOM buttons are tracked in
// treeMemBtns so live SSE events can update them without re-rendering.
const treeMemory = new Map();
const treeMemBtns = new Map();

function tpEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Open/closed state persists across reloads; the drawer defaults to open.
const TREE_OPEN_KEY = "treePanelOpen";
// Last selected pattern, mirrored client-side so it survives reloads even
// if the server restarts without TREE_PATTERN persisted in .env.
const TREE_PATTERN_KEY = "treePattern";
function setTreePanelOpen(open) {
  // Non-modal: no backdrop, the chat stays usable while the drawer is open.
  treePanel.classList.toggle("open", open);
  try { localStorage.setItem(TREE_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode */ }
  if (open) loadTreePanel();
}
$("tree-btn").onclick = () => setTreePanelOpen(!treePanel.classList.contains("open"));
$("tree-close").onclick = () => setTreePanelOpen(false);

// Runtime bookkeeping rows (record, scope_init) are for debugging the tree,
// not for reading a conversation: hidden by default, revealed on demand.
const INTERNALS_KEY = "gb_show_internals";
function updateCount(block) {
  const show = document.body.classList.contains("show-internals");
  // Only top-level rows count; a collapsed map block is one step, and its
  // item rows belong to it.
  let n = 0;
  for (const li of block.list.children) {
    if (!li.classList.contains("step")) continue;
    if (!show && li.classList.contains("k-internals")) continue;
    n++;
  }
  block.cnt.textContent = n + (n === 1 ? " step" : " steps");
}
function setInternals(on) {
  document.body.classList.toggle("show-internals", on);
  $("internals-btn").classList.toggle("on", on);
  for (const block of blocks.values()) updateCount(block);
  try { localStorage.setItem(INTERNALS_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}
$("internals-btn").onclick = () =>
  setInternals(!document.body.classList.contains("show-internals"));
try {
  setInternals(localStorage.getItem(INTERNALS_KEY) === "1");
} catch { setInternals(false); }
try {
  if (localStorage.getItem(TREE_OPEN_KEY) !== "0") setTreePanelOpen(true);
} catch { setTreePanelOpen(true); }

async function loadTreePanel(force) {
  const name = $("pattern-sel").value;
  if (!force && treeLoadedFor && treeLoadedFor === name) return;
  treeBody.innerHTML = "";
  treeBody.appendChild(tpEl("div", "tp-empty", "loading\\u2026"));
  try {
    const r = await fetch("/api/tree" + (name ? "?pattern=" + encodeURIComponent(name) : ""));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "load failed");
    treeLoadedFor = d.pattern;
    $("tp-pattern").textContent = d.pattern;
    treeBody.innerHTML = "";
    treeMemory.clear();
    treeMemBtns.clear();
    treeBody.appendChild(renderTreeNode(d.tree, true));
    applyTreeMarks();
    refreshTreeMemory();
  } catch (e) {
    treeBody.innerHTML = "";
    treeBody.appendChild(tpEl("div", "tp-empty", "could not load tree: " + e.message));
  }
}

// One info row inside a node's expanded body.
function tpInfo(body, key, value) {
  if (value == null || value === "") return;
  const row = tpEl("div", "tp-info");
  row.append(tpEl("span", "tp-k", key), tpEl("pre", "tp-v", String(value)));
  body.appendChild(row);
}

// Render a serialized tree ({kind:"tree",...}) or a child node. The tree
// header carries model/tools/needs rules; children nest underneath.
function renderTreeNode(n, isRoot) {
  const wrap = tpEl("div", "tp-tree");
  if (isRoot) {
    const head = tpEl("div", "tp-row");
    head.append(tpEl("span", "tp-badge", "tree"), tpEl("span", "tp-name", n.name || "(anon)"));
    head.dataset.path = n.path;
    wrap.appendChild(head);
    const meta = [];
    for (const m of n.models || []) meta.push("model: " + m.value + (m.when ? "   [" + m.when + "]" : ""));
    for (const t of n.tools || []) meta.push("tools: " + t.value.join(", ") + (t.when ? "   [" + t.when + "]" : ""));
    if (n.needs && n.needs.length) meta.push("needs: " + n.needs.join(", "));
    if (meta.length) wrap.appendChild(tpEl("pre", "tp-meta", meta.join("\\n")));
  }
  const ul = tpEl("ul", "tp-children");
  for (const c of n.children || []) ul.appendChild(renderTreeChild(c));
  wrap.appendChild(ul);
  return wrap;
}

function renderTreeChild(c) {
  const li = tpEl("li", "tp-node k-" + c.kind);
  li.dataset.path = c.path;

  const body = tpEl("div", "tp-body");
  if (c.text != null) tpInfo(body, "prompt", c.text);
  if (c.messages) tpInfo(body, "messages", c.messages.map((m) => m.role + ": " + m.content).join("\\n\\n"));
  if (c.fn) tpInfo(body, "fn", c.fn);
  if (c.kind === "memory" || c.kind === "memoryUpdate") {
    const row = tpEl("div", "tp-info");
    row.appendChild(tpEl("span", "tp-k", "value"));
    const btn = tpEl("button", "tp-v tp-mem-btn", shortValue(treeMemory.get(c.path)));
    btn.dataset.path = c.path;
    btn.title = "click for full value";
    btn.addEventListener("click", () => openMemoryPopup(c.path, c.name));
    row.appendChild(btn);
    body.appendChild(row);
    treeMemBtns.set(c.path, btn);
  }
  if (c.tool) tpInfo(body, "tool", c.tool);
  if (c.argsFn) tpInfo(body, "args", c.argsFn);
  if (c.tools) tpInfo(body, "tools", c.tools.join(", "));
  if (c.check) tpInfo(body, "check", c.check);
  if (c.flow) tpInfo(body, "on fail", c.flow);
  if (c.loop) tpInfo(body, "loop", c.loop);
  if (c.contextFn) tpInfo(body, "context", c.contextFn);
  if (c.tree) body.appendChild(renderTreeNode(c.tree, true));

  const summary = document.createElement(body.childNodes.length ? "summary" : "div");
  if (!body.childNodes.length) summary.className = "tp-row";
  summary.append(
    tpEl("span", "tp-badge", c.kind),
    tpEl("span", "tp-name", c.name || ""),
  );
  if (c.gate) summary.appendChild(tpEl("span", "tp-gate", c.gate));
  else if (c.kind === "prompt" && c.text != null) summary.appendChild(tpEl("span", "tp-gate", short(c.text, 60)));

  if (body.childNodes.length) {
    const det = document.createElement("details");
    if (c.kind === "branch" || c.kind === "map") det.open = true;
    det.append(summary, body);
    li.appendChild(det);
  } else {
    li.appendChild(summary);
  }
  return li;
}

// ---- memory values ----

// One-line, truncated rendering of a memory value for the inline display.
function shortValue(v) {
  if (v === undefined) return "(no value)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return short(s, 120);
}

// Update the inline (truncated) value shown on a memory node's button.
function updateMemoryNode(path, value) {
  const btn = treeMemBtns.get(path);
  if (btn) btn.textContent = shortValue(value);
}

// Popup showing a memory slot's full value, lazy-loaded from the server so
// nothing large is shipped unless the user asks for it.
function openMemoryPopup(path, label) {
  document.getElementById("mem-popup")?.remove();
  const overlay = tpEl("div", "", null);
  overlay.id = "mem-popup";
  const box = tpEl("div", "mem-box");
  const head = tpEl("div", "mem-head");
  head.appendChild(tpEl("h3", "", label || path));
  const close = tpEl("button", "", "close");
  close.addEventListener("click", () => overlay.remove());
  head.appendChild(close);
  const body = tpEl("div", "mem-body");
  const pre = document.createElement("pre");
  pre.textContent = "loading\u2026";
  body.appendChild(pre);
  box.append(head, body);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  fetch("/api/tree/memory?path=" + encodeURIComponent(path))
    .then((r) => r.json())
    .then((d) => {
      const v = d.value;
      pre.textContent =
        v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v, null, 2);
    })
    .catch((e) => { pre.textContent = "failed to load: " + e.message; });
}

// Refresh the current memory values from the log DB (full values) and update
// every memory node's inline display. Called on panel load and at turn end.
async function refreshTreeMemory() {
  try {
    const r = await fetch("/api/tree/memory");
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.values) return;
    for (const [p, v] of Object.entries(d.values)) {
      treeMemory.set(p, v);
      updateMemoryNode(p, v);
    }
  } catch { /* memory view is best-effort */ }
}

// Debounce live memory refreshes: a turn writes several memory slots in quick
// succession, and each write should update every node bound to that slot (the
// declaring .memory() node included), so we just re-fetch the resolved map.
let memRefreshTimer = null;
function scheduleMemoryRefresh() {
  if (memRefreshTimer) return;
  memRefreshTimer = setTimeout(() => { memRefreshTimer = null; refreshTreeMemory(); }, 150);
}

// ---- live progress marks (driven by the same SSE events as the steps) ----
function applyTreeMarks() {
  let activeEl = null;
  for (const el of treeBody.querySelectorAll("[data-path]")) {
    const p = el.dataset.path;
    const isActive = treeActive != null && p === treeActive;
    el.classList.toggle("tp-active", isActive);
    el.classList.toggle("tp-visited", treeVisited.has(p));
    if (isActive) activeEl = el;
  }
  if (activeEl && treePanel.classList.contains("open")) {
    // Expand ancestors so the active node is actually visible, then scroll to it.
    let p = activeEl.parentElement;
    while (p && p !== treeBody) {
      if (p.tagName === "DETAILS") p.open = true;
      p = p.parentElement;
    }
    activeEl.scrollIntoView({ block: "nearest" });
  }
}

function treeOnEvent(ev) {
  const c = ev.content || {};
  let p = ev.branch_path || "";
  if (c.child) p = p ? p + "/" + c.child : String(c.child);
  if (!p) return;
  treeVisited.add(p);
  treeActive = p;
  const op = ev.content && ev.content.op;
  if (ev.kind === "memory" || (ev.kind === "record" && (op === "memory" || op === "memoryUpdate"))) {
    scheduleMemoryRefresh();
  }
  applyTreeMarks();
}
function treeOnTurnStart() {
  treeVisited.clear();
  treeActive = null;
  applyTreeMarks();
}
function treeOnTurnEnd() {
  treeActive = null;
  applyTreeMarks();
  refreshTreeMemory();
}

// ---- live events over SSE ----
function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "turn_start") { startTurn(msg.turnId, msg.input); treeOnTurnStart(); }
    else if (msg.type === "event") { addStep(msg.turnId, msg.event); treeOnEvent(msg.event); }
    else if (msg.type === "emit") { emitToTurn(msg.turnId, msg.text); }
    else if (msg.type === "turn_end") { endTurn(msg.turnId, msg.status, msg.error, msg.output); treeOnTurnEnd(); }
    else if (msg.type === "cleared") { conv.innerHTML = ""; blocks.clear(); showEmpty(); treeMemory.clear(); for (const btn of treeMemBtns.values()) btn.textContent = "(no value)"; }
  };
}

// ---- history on load ----
async function loadHistory() {
  try {
    const r = await fetch("/api/turns");
    const d = await r.json();
    for (const t of d.turns || []) {
      startTurn(t.turnId, t.input);
      for (const ev of t.events || []) addStep(t.turnId, ev);
      endTurn(t.turnId, t.status, t.error, t.output);
    }
  } catch { /* server restarted mid-load, etc. */ }
}

showEmpty();
loadHistory();
connect();

// ---- pattern selector -------------------------------------------------
async function loadPatternSelect() {
  try {
    const r = await fetch("/api/pattern");
    const d = await r.json();
    const sel = document.getElementById("pattern-sel");
    sel.innerHTML = "";
    for (const p of d.patterns || []) {
      const o = document.createElement("option");
      o.value = p.name;
      o.textContent = p.name;
      if (p.name === d.current) o.selected = true;
      sel.appendChild(o);
    }
    if (!d.patterns || !d.patterns.length) {
      sel.appendChild(new Option("(no patterns)", "", false, false));
    }
    // Restore the last locally-selected pattern if the server no longer
    // has it (e.g. restarted without TREE_PATTERN persisted in .env).
    let saved = null;
    try { saved = localStorage.getItem(TREE_PATTERN_KEY); } catch { /* private mode */ }
    const names = (d.patterns || []).map((p) => p.name);
    if (saved && names.includes(saved) && saved !== d.current) {
      const rr = await fetch("/api/pattern", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: saved }),
      });
      if (rr.ok) sel.value = saved;
    }
    // The drawer may have loaded before the select was populated — resync.
    if (treePanel.classList.contains("open")) loadTreePanel(true);
  } catch { /* pattern API unreachable — selector just stays empty */ }
}
async function setPattern(name) {
  if (!name) return;
  try {
    const r = await fetch("/api/pattern", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "pattern switch failed", true); return; }
    toast("pattern: " + d.pattern + " — conversation cleared");
    try { localStorage.setItem(TREE_PATTERN_KEY, name); } catch { /* private mode */ }
    treeLoadedFor = null;
    treeVisited.clear();
    treeActive = null;
    if (treePanel.classList.contains("open")) loadTreePanel(true);
  } catch (e) {
    toast("pattern switch failed: " + e.message, true);
  }
}
document.getElementById("pattern-sel").addEventListener("change", (e) => setPattern(e.target.value));
loadPatternSelect();
</script>
</body>
</html>
`;
}

// ── server ────────────────────────────────────────────────────────────
export interface AdminOptions extends Partial<AdminConfig> {
  /** The agent instance — required for the chat front page. */
  agent?: Agent;
  /** STT backend options — required for voice input on the chat page. */
  stt?: SttBackendOptions;
}

export function startAdmin(cfg?: AdminOptions): http.Server {
  const config: AdminConfig = { ...defaultConfig(), ...cfg };
  const agent = cfg?.agent;
  const stt = cfg?.stt;
  const SETTINGS_HTML = buildSettingsHtml(config);
  const sttLabel = stt
    ? `voice: ${stt.backend} @ ${new URL(stt.backend === "sherpa" || stt.backend === "parakeet" ? stt.sherpaUrl : stt.whisperUrl).host}`
    : "voice: not configured";
  const CHAT_HTML = buildChatHtml(config, sttLabel);

  // Restore the web chat history from the previous run (before any browser
  // polls /api/turns).
  webTurnsPath = path.resolve(config.workspaceDir, "logs", "web-turns.json");
  loadTurns();

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
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(CHAT_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/settings") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(SETTINGS_HTML);
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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ turns }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        if (!agent) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"agent not available"}');
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
        const { turnId, queued } = enqueueChat(agent, message, message);
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
          config.workspaceDir,
          file.filename || "upload",
          file.content,
          file.contentType || "application/octet-stream",
        );
        const caption = typeof parts.caption === "string" ? parts.caption.trim() : "";
        const content = attachmentPrompt(attachment, caption);
        const display = caption ? `${caption}\n[attached: ${attachment.filename}]` : `[attached: ${attachment.filename}]`;
        const { turnId, queued } = enqueueChat(agent, content, display);
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
        agent?.clear(WEB_KEY);
        webMemoryValues.clear();
        webMemoryPaths.clear();
        turns.length = 0;
        saveTurns();
        broadcast({ type: "cleared" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        const [env, status] = await Promise.all([readEnv(config.envPath), tmuxStatus(config.botSession, config.sherpaSession)]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ env: env || {}, ...status }));
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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sync/push") {
        const body = await readBody(req);
        const local = JSON.parse(body).local || "master";
        const remote = JSON.parse(body).remote || local;
        const result = await gitSync(config.workspaceDir, "push", local, remote);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/commit") {
        const body = await readBody(req);
        const msg = (JSON.parse(body).message || "manual commit from admin UI").trim();
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
          res.writeHead(200, { "content-type": "application/json" });
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
        const patterns = await listPatterns(config.workspaceDir);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ current: getSelectedPattern(), patterns }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/pattern") {
        const body = await readBody(req);
        let name: unknown;
        try { name = JSON.parse(body).name; } catch { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid JSON body"}'); return; }
        if (typeof name !== "string" || !name) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"name is required"}'); return; }
        const patterns = await listPatterns(config.workspaceDir);
        if (!patterns.some((p) => p.name === name)) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `pattern not found: ${name}` }));
          return;
        }
        setSelectedPattern(name);
        try { await writeEnv(config.envPath, { TREE_PATTERN: name }); } catch { /* persist best-effort */ }
        agent?.clear(WEB_KEY);
        webMemoryValues.clear();
        webMemoryPaths.clear();
        turns.length = 0;
        saveTurns();
        broadcast({ type: "cleared" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pattern: name }));
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
