// src/tools/opencode.ts
//
// `opencode` tool: delegate a prompt to an opencode session (subprocess) and
// return everything opencode produced for this invocation. This lets the
// agent hand off a self-contained task to a dedicated coding agent and read
// back its result.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 10 * 60 * 1000; // opencode runs can be long
const MAX_OUTPUT = 200_000;

export interface OpencodeOptions {
  input: string;
  /** Specific session id to continue (opencode `-s`). */
  session?: string;
  /** Continue the most recent session (opencode `-c`). Ignored if `session` set. */
  continueLast?: boolean;
  /** Model in `provider/model` form (opencode `-m`). */
  model?: string;
  /** Agent name to use (opencode `--agent`). */
  agent?: string;
  /** Working directory for opencode (`--dir`). Defaults to the workspace. */
  dir?: string;
  /** opencode binary path. */
  bin?: string;
}

export interface OpencodeResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  error?: string;
}

/**
 * Extract legible text from a stream of newline-delimited JSON events as
 * emitted by `opencode run --format json`. Handles the common shapes:
 *   {"type":"text","data":{"text":"..."}}
 *   {"type":"message", "data": { "parts": [{"type":"text","text":"..."}] }}
 *   …and anything with a string `text`/`content` under `data`.
 */
function extractText(stdout: string): string {
  const chunks: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // ignore non-JSON line (banners/logs)
    }
    const data = ev.data;
    if (!data || typeof data !== "object") continue;

    if (typeof data.text === "string") chunks.push(data.text);
    if (typeof data.content === "string" && ev.type === "text") chunks.push(data.content);
    if (Array.isArray(data.parts)) {
      for (const p of data.parts) {
        if (p && typeof p === "object") {
          if (typeof p.text === "string") chunks.push(p.text);
          else if (p.type === "text" && typeof p.content === "string") chunks.push(p.content);
        }
      }
    }
  }
  return chunks.join("").trim();
}

function extractSessionId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    let ev: any;
    try {
      ev = JSON.parse(line.trim());
    } catch {
      continue;
    }
    const sid = ev?.sessionID ?? ev?.session_id ?? ev?.data?.sessionID ?? ev?.data?.session_id;
    if (typeof sid === "string" && sid) return sid;
  }
  return undefined;
}

export class OpencodeTools {
  constructor(private bin: string = "opencode") {}

  async run(opts: OpencodeOptions): Promise<OpencodeResult> {
    const input = (opts.input ?? "").trim();
    if (!input) return { ok: false, text: "", error: "opencode: input is required" };

    const args: string[] = ["run", "--format", "json"];
    if (opts.session) args.push("--session", opts.session);
    else if (opts.continueLast) args.push("--continue");
    if (opts.model) args.push("--model", opts.model);
    if (opts.agent) args.push("--agent", opts.agent);
    if (opts.dir) args.push("--dir", opts.dir);
    args.push(input);

    try {
      const { stdout, stderr } = await execFileAsync(this.bin, args, {
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      const text = extractText(stdout);
      const sessionId = extractSessionId(stdout);
      const result: OpencodeResult = {
        ok: true,
        text: text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n… (truncated)" : text,
      };
      if (sessionId) result.sessionId = sessionId;
      else if (stderr) result.error = "opencode produced no text (see stderr)";
      return result;
    } catch (err: any) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; message?: string };
      if (e.killed) return { ok: false, text: "", error: `opencode timed out after ${TIMEOUT_MS / 1000}s` };
      return {
        ok: false,
        text: "",
        error: `opencode failed: ${e.stderr || e.message || String(e.code) || "unknown error"}`.trim(),
      };
    }
  }
}
