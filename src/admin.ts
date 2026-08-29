// src/admin.ts
//
// Web UI for grandma-bob. Starts an HTTP server on ADMIN_PORT (default
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
  const PROJECT_DIR = process.env.PROJECT_DIR || `${HOME}/grandma-bob`;
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

async function listPatterns(workspaceDir: string) {
  const patternsDir = path.join(workspaceDir, PATTERNS_DIR_NAME);
  try {
    const files = await readdir(patternsDir);
    const out: { file: string; name: string; description: string }[] = [];
    for (const f of files) {
      if (!f.endsWith(".mjs")) continue;
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
const MAX_TURNS_KEPT = 20;
const MAX_EVENT_STR = 400;

interface SanitizedEvent {
  kind: string;
  branch_path: string;
  iteration: number;
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

function sanitizeEvent(e: { kind?: string; branch_path?: string; iteration?: number; content?: Record<string, unknown> | null }): SanitizedEvent {
  const content: Record<string, unknown> = { ...(e.content ?? {}) };
  // llm_call embeds the entire prompt history — replace with a summary.
  if (Array.isArray(content.messages)) {
    const msgs = content.messages as { role?: string; content?: unknown }[];
    const last = msgs[msgs.length - 1];
    content.messages = {
      count: msgs.length,
      last: last
        ? { role: last.role, content: sanitizeValue(typeof last.content === "string" ? last.content : JSON.stringify(last.content)) }
        : null,
    };
  }
  return {
    kind: e.kind ?? "unknown",
    branch_path: e.branch_path ?? "",
    iteration: e.iteration ?? 0,
    content: sanitizeValue(content) as Record<string, unknown>,
    ts: Date.now(),
  };
}

function enqueueChat(agent: Agent, text: string): { turnId: string; queued: boolean } {
  const turnId = randomUUID();
  pendingTurns++;
  // "queued" = another turn is running OR ahead in the queue, so the UI
  // shows a pending bubble until this turn's turn_start arrives.
  const queued = activeTurns > 0 || pendingTurns > 1;
  webQueue = webQueue
    .then(() => runTurn(agent, turnId, text))
    .catch((err) => console.error("[web-chat]", err));
  return { turnId, queued };
}

async function runTurn(agent: Agent, turnId: string, text: string): Promise<void> {
  pendingTurns--;
  activeTurns++;
  const record: TurnRecord = {
    turnId,
    input: text,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    error: null,
    output: null,
    events: [],
  };
  turns.push(record);
  while (turns.length > MAX_TURNS_KEPT) turns.shift();
  broadcast({ type: "turn_start", turnId, input: text, ts: record.startedAt });

  const onEvent = (e: unknown) => {
    const s = sanitizeEvent(e as Parameters<typeof sanitizeEvent>[0]);
    record.events.push(s);
    broadcast({ type: "event", turnId, event: s });
  };

  try {
    // First message of the conversation: grow the tree (pauses at .human()).
    if (!agent.hasContinuation(WEB_KEY)) {
      await agent.run(WEB_KEY, "", () => {}, { onEvent });
    }
    await agent.run(
      WEB_KEY,
      text,
      (value) => {
        const t = typeof value === "string" ? value : JSON.stringify(value);
        if (t) record.output = record.output ? record.output + "\n\n" + t : t;
      },
      { onEvent },
    );
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
<title>grandma-bob settings</title>
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
  <h1>grandma-bob settings</h1>
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
  <p style="margin:4px 0"><small>grandma-kat Tree patterns (<code>.mjs</code>) in <code>workspace/patterns/</code>. The agent loads <code>agent.mjs</code> on each turn — edit it to change behavior without restarting. The agent can also modify its own patterns using file tools.</small></p>
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
<title>grandma-bob</title>
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
  .spinner { width: 12px; height: 12px; flex: none; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .step-list { margin: 0; padding: 4px 12px 10px; list-style: none; border-top: 1px solid var(--border); }
  .step { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .step details > summary { cursor: pointer; padding: 3px 0; display: flex; gap: 8px; align-items: baseline; list-style: none; }
  .step details > summary::-webkit-details-marker { display: none; }
  .badge { flex: none; min-width: 58px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; background: #334155; color: var(--fg); text-transform: uppercase; }
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
</style>
</head>
<body>
<header>
  <h1>grandma-bob</h1>
  <span class="sub">${sttLabel}</span>
  <nav><a href="/settings">settings</a></nav>
</header>
<main id="main"><div class="inner" id="conversation"></div></main>
<footer>
  <div class="input-row">
    <button id="mic-btn" title="hold a conversation by voice">&#127908;</button>
    <span id="mic-timer"></span>
    <button id="file-btn" title="transcribe an audio file (streams as it goes)">&#128206;</button>
    <input id="file-input" type="file" accept="audio/*,.ogg,.oga,.opus,.webm,.mp3,.m4a,.mp4,.wav,.flac" style="display:none">
    <textarea id="input" rows="1" placeholder="type a message&hellip;" enterkeyhint="send"></textarea>
    <button id="send-btn">Send</button>
  </div>
  <div class="foot-note">
    <span>Enter to send &middot; Shift+Enter for a new line</span>
    <span class="right"><button id="clear-btn" class="secondary" style="padding:2px 10px;font-size:12px">clear conversation</button></span>
  </div>
</footer>
<div id="toast" class="toast"></div>
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
      return { badge: "record", cls: "k-dim", text: (c.child ?? "?") + " = " + jshort(c.value, 80) };
    case "scope_init":
      return { badge: "scope", cls: "k-dim", text: "#" + c.scopeId + (c.parentScopeId != null ? " (parent #" + c.parentScopeId + ")" : "") };
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
  sum.append(spin, lab, cnt);
  const list = document.createElement("ol");
  list.className = "step-list";
  steps.append(sum, list);
  turn.appendChild(steps);

  if (pending) pending.replaceWith(turn);
  else conv.appendChild(turn);

  const block = { turn, list, spin, lab, cnt, count: 0 };
  blocks.set(turnId, block);
  maybeScroll(true);
  return block;
}

function addStep(turnId, ev) {
  const block = blocks.get(turnId);
  if (!block) return;
  const d = describeEvent(ev);
  const li = document.createElement("li");
  li.className = "step " + d.cls;
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = d.badge;
  const sp = document.createElement("span");
  sp.className = "spath";
  sp.textContent = ev.branch_path ? "[" + ev.branch_path + "]" : "";
  const txt = document.createElement("span");
  txt.className = "stext";
  txt.textContent = d.text;
  sum.append(badge, sp, txt);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(ev.content, null, 2);
  det.append(sum, pre);
  li.appendChild(det);
  block.list.appendChild(li);
  block.count++;
  block.cnt.textContent = block.count + (block.count === 1 ? " step" : " steps");
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
  if (file) transcribeFile(file);
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

// ---- live events over SSE ----
function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "turn_start") startTurn(msg.turnId, msg.input);
    else if (msg.type === "event") addStep(msg.turnId, msg.event);
    else if (msg.type === "turn_end") endTurn(msg.turnId, msg.status, msg.error, msg.output);
    else if (msg.type === "cleared") { conv.innerHTML = ""; blocks.clear(); showEmpty(); }
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

  // Keep SSE connections alive through proxies/idle timeouts.
  const heartbeat = setInterval(() => {
    for (const res of sseClients) {
      try { res.write(": ping\n\n"); } catch { /* ignore */ }
    }
  }, 25000);
  heartbeat.unref();

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
        const { turnId, queued } = enqueueChat(agent, text.trim());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, turnId, queued }));
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
        turns.length = 0;
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

  server.on("close", () => clearInterval(heartbeat));

  return server;
}
