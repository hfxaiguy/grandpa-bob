import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma from "grandma-kat";
import type { ToolRegistry } from "./tools/index.js";
import type { ModelRegistry } from "./models.js";
import { loadPattern } from "./pattern-loader.js";

export interface AgentDeps {
  /** Named LLM registry (e.g. { cheap, strong }) from models.json or env. */
  models: ModelRegistry;
  /**
   * Workspace directory. The grandma-kat SQLite log lives at
   * `<workspace>/logs/grandma-kat.db` — it contains user data
   * (prompts, responses, tool calls) so it stays next to the user's
   * files.
   */
  workspace: string;
  tools: ToolRegistry;
  /**
   * Custom logger for grandma-kat events. When set, used instead of
   * the default SQLite logger. Useful for the debug REPL which injects
   * a CompositeLogger(SqliteLogger, EventLogger).
   */
  logger?: unknown;
  /** Log level for grandma-kat. Default: "info". */
  logLevel?: "none" | "info" | "debug";
  /**
   * Which patterns/*.mjs tree to run, by name (filename without .mjs).
   * A getter is used so it stays mutable at runtime (the admin UI can
   * switch the active pattern without a process restart).
   */
  patternName?: () => string;
}

export type AgentRunResult =
  | {
      /** "waiting" = tree paused at .human(), continuation stored. */
      status: "waiting";
      /** Continuation token (checkpoint ID). Store for next run. */
      continuation: string;
    }
  | {
      /** "done" = tree completed (not every pattern loops at .human()). */
      status: "done";
      /** The tree's final result value, if any. */
      result?: unknown;
    };

export interface AgentRunOptions {
  /**
   * Receive every grandma-kat event logged during this run (llm_call,
   * tool_call, tool_result, flow, emit, human, ...). Used by the web UI
   * to show the tree executing live. Requires a custom logger object in
   * AgentDeps (a string db path can't be intercepted).
   */
  onEvent?: (event: unknown) => void;
}

/**
 * Ping the LLM endpoint to check reachability. Returns true on any 2xx,
 * false on transport error or non-2xx. Used at startup so a missing
 * Ollama/llama-server is surfaced as a warning instead of a cryptic
 * first-message failure.
 *
 * For OpenAI-compat endpoints, pings `/models`. For native Ollama
 * (`protocol: "ollama"`), pings `/api/tags`.
 */
export async function checkLlmEntry(
  baseURL: string,
  apiKey: string,
  protocol?: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const path = protocol === "ollama" ? "/api/tags" : "/models";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseURL.replace(/\/$/, "")}${path}`, {
      signal: ctrl.signal,
      headers: apiKey && apiKey !== "no-key" ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export class Agent {
  private logDb: string;
  private continuations = new Map<string, string>();
  private sessionsPath: string;
  private sessionPatterns = new Map<string, string>(); // key → pattern definition hash

  constructor(private deps: AgentDeps) {
    this.logDb = path.resolve(deps.workspace, "logs/grandma-kat.db");
    this.sessionsPath = path.resolve(deps.workspace, "logs", "sessions.json");
    this.loadSessions();
  }

  /**
   * Restore conversation continuations from `<workspace>/logs/sessions.json`
   * so chat sessions survive bot restarts. Missing or corrupt files are
   * ignored (first run starts clean).
   */
  private loadSessions(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsPath, "utf8")) as Record<
        string,
        { continuation?: unknown; pattern?: unknown } | null
      >;
      if (!raw || typeof raw !== "object") return;
      for (const [key, val] of Object.entries(raw)) {
        if (typeof val?.continuation === "string") {
          this.continuations.set(key, val.continuation);
          if (typeof val.pattern === "string") this.sessionPatterns.set(key, val.pattern);
        }
      }
    } catch {
      // no persisted sessions yet
    }
  }

  /** Atomically persist the continuation map (write tmp, rename). */
  private saveSessions(): void {
    const out: Record<string, { continuation: string; pattern: string | null }> = {};
    for (const [key, continuation] of this.continuations) {
      out[key] = { continuation, pattern: this.sessionPatterns.get(key) ?? null };
    }
    try {
      fs.mkdirSync(path.dirname(this.sessionsPath), { recursive: true });
      const tmp = this.sessionsPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, this.sessionsPath);
    } catch (e) {
      console.warn("[agent] failed to save sessions:", e instanceof Error ? e.message : e);
    }
  }

  /**
   * Structural hash of a tree definition — mirrors grandma-kat's internal
   * `definitionId` (not exported from the package). Functions become stable
   * name placeholders so the hash tracks structure, not closures.
   */
  static definitionHash(tree: unknown): string {
    const def = (tree as { def?: unknown } | null)?.def ?? tree;
    const json = JSON.stringify(def, (_k, v) =>
      typeof v === "function" ? "[fn:" + ((v as Function).name || "anon") + "]" : v,
    );
    return crypto.createHash("sha256").update(json).digest("hex").slice(0, 8);
  }

  /**
   * Run one turn of a continuous conversation. The tree pauses at
   * `.human()` between messages; the continuation token persists the
   * full tree state (memory, history, scope chain) in the SQLite log.
   *
   * @param key         Conversation key (e.g. "chatId:threadId").
   * @param humanInput  The user's message or another JSON-serializable human input.
   * @param onEmit      Callback for non-blocking output (`.emit()` calls).
   * @param opts        Optional: `onEvent` streams grandma-kat tree events.
   * @returns           `{ status: "waiting", continuation }` — store the
   *                    continuation for the next run.
   */
  async run(
    key: string,
    humanInput: unknown,
    onEmit?: (value: unknown) => void | Promise<void>,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    let cont = this.continuations.get(key);
    let droppedContinuation = false;
    const katTools = this.deps.tools.toKatTools();
    const pattern = await loadPattern(this.deps.workspace, this.deps.patternName?.() ?? "trunk");
    const defId = Agent.definitionHash(pattern);

    // A checkpoint was grown under a specific tree shape; if the active
    // pattern changed (or the pattern file was edited), the stored pause
    // point no longer maps to any `.human()` slot — start fresh.
    if (cont && this.sessionPatterns.get(key) !== defId) {
      this.continuations.delete(key);
      this.sessionPatterns.delete(key);
      this.saveSessions();
      cont = undefined;
      droppedContinuation = true;
    }

    const allTools = katTools;

    const runtime: Record<string, unknown> = {
      models: this.deps.models,
      tools: allTools,
      logger: this.wrapLogger(opts?.onEvent),
      onEmit,
      // Only set logLevel when using the default (string path) logger.
      // When a custom logger is provided, it already handles console output.
      ...(this.deps.logger ? {} : { logLevel: this.deps.logLevel ?? "info" }),
    };

    // Trees that declare `input` (app trees: contacts, caller-list) consume
    // the message directly on a fresh run — they do work before their first
    // `.human()`, so there is no grow pass to skip and nothing to deliver
    // into a pause. Trees like trunk open with `.human("main_input")` and
    // pause before the message is delivered.
    const patternDef = (pattern as { def?: { needs?: string[] }; needs?: string[] } | null)?.def
      ?? (pattern as { needs?: string[] } | null);
    const needsInput = (patternDef?.needs ?? []).includes("input");

    const freshRun = () =>
      grandma.knit(pattern, {
        ...runtime,
        // First run: inject system prompt and start the tree.
        // A tree that opens with `.human()` pauses immediately — no LLM call
        // yet. An input-driven tree starts with `input` seeded from the
        // message and runs until its own first pause/completion.
        memory: {
          messages: [],
          workspace: this.deps.workspace,
          main_input: humanInput,
          ...(needsInput ? { input: humanInput } : {}),
        },
      });

    let outcome: { status?: string; continuation?: string; result?: unknown };

    if (cont) {
      // Resume from checkpoint. The reply is passed raw — grandma-kat's
      // resume() routes it into whatever .human() slot the checkpoint says
      // is paused (e.g. the knowledge branch's verify_search), so the
      // caller never names the slot. See injectHumanInput in
      // grandma-kat/src/knit.mjs.
      try {
        outcome = await grandma.knit(pattern, {
          ...runtime,
          _continuation: cont,
          humanInput,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Missing checkpoint (e.g. the log DB was cleared under us): drop
        // the dead continuation and grow a fresh tree instead of failing.
        if (!/checkpoint/i.test(msg)) throw err;
        console.warn(`[agent] stale checkpoint for '${key}' (${msg}) — starting fresh tree`);
        this.continuations.delete(key);
        this.sessionPatterns.delete(key);
        this.saveSessions();
        droppedContinuation = true;
        outcome = await freshRun();
      }
    } else {
      outcome = await freshRun();
    }

    // A continuation that died under us (pattern edited, checkpoint gone)
    // still owes the caller this turn. Now that the fresh tree is paused at
    // its first `.human()`, deliver the message the way a normal turn does —
    // otherwise the seeded input is never consumed and the turn ends with
    // just the tree's startup output. Input-driven trees already consumed
    // the message in freshRun above.
    if (droppedContinuation && !needsInput && outcome.status === "waiting" && outcome.continuation) {
      outcome = await grandma.knit(pattern, {
        ...runtime,
        _continuation: outcome.continuation,
        humanInput,
      });
    }

    if (outcome.status === "waiting" && outcome.continuation) {
      this.continuations.set(key, outcome.continuation);
      this.sessionPatterns.set(key, defId);
      this.saveSessions();
      return { status: "waiting", continuation: outcome.continuation };
    }

    // The tree ran to completion. Not every pattern loops at .human()
    // (e.g. one-shot trees like person-scan), so this is a normal outcome:
    // drop any stale continuation so the next message starts a fresh tree.
    this.continuations.delete(key);
    this.sessionPatterns.delete(key);
    this.saveSessions();
    return { status: "done", result: outcome.result };
  }

  /**
   * Wrap the configured logger so each logged event also reaches
   * `onEvent` (per-run telemetry for the web UI). Checkpoint operations
   * are delegated to the base logger untouched; the shared logger is
   * never closed by the wrapper. Without `onEvent` (or with a plain
   * db-path string logger) the original logger is returned as-is.
   */
  private wrapLogger(onEvent?: (event: unknown) => void): unknown {
    const base = this.deps.logger as
      | { log?: (e: unknown) => number | void; [k: string]: unknown }
      | undefined;
    if (!onEvent || !base || typeof base.log !== "function") {
      return this.deps.logger ?? this.logDb;
    }
    return {
      log(event: unknown): number | void {
        try {
          onEvent(event);
        } catch {
          // telemetry must never break a run
        }
        return base.log!(event);
      },
      close() {},
      saveCheckpoint: (...a: unknown[]) => (base.saveCheckpoint as Function | undefined)?.(...a),
      getCheckpoint: (...a: unknown[]) => (base.getCheckpoint as Function | undefined)?.(...a),
      deleteCheckpoint: (...a: unknown[]) => (base.deleteCheckpoint as Function | undefined)?.(...a),
      getEvents: (...a: unknown[]) => (base.getEvents as Function | undefined)?.(...a),
    };
  }

  /**
   * Check whether a continuation exists for a conversation key.
   */
  hasContinuation(key: string): boolean {
    return this.continuations.has(key);
  }

  /**
   * True when a fresh run of the active tree consumes the message directly
   * (the tree declares `input`). Callers must skip their
   * grow-at-the-first-`.human()` pass for these trees: app trees
   * (contacts, caller-list) start with work, not with a pause, so a grow
   * pass would run them on an empty message and swallow the real one as
   * the first human's reply. Trunk-style trees return false.
   */
  async consumesInputDirectly(): Promise<boolean> {
    const pattern = (await loadPattern(
      this.deps.workspace,
      this.deps.patternName?.() ?? "trunk",
    )) as { def?: { needs?: string[] }; needs?: string[] } | null;
    return ((pattern?.def ?? pattern)?.needs ?? []).includes("input");
  }

  /**
   * Clear the continuation for a conversation. The next `run()` will
   * start a fresh tree (new system prompt, empty history). Per-topic:
   * the key is "chatId:message_thread_id". The checkpoint in SQLite is
   * orphaned but not deleted.
   */
  clear(key: string): void {
    this.continuations.delete(key);
    this.sessionPatterns.delete(key);
    this.saveSessions();
  }
}
