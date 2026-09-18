import path from "node:path";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma from "grandma-kat";
// @ts-ignore — communications ships no .d.ts files.
import { tools as commsTools } from "communications/src/tools.mjs";
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

  constructor(private deps: AgentDeps) {
    this.logDb = path.resolve(deps.workspace, "logs/grandma-kat.db");
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
    const cont = this.continuations.get(key);
    const katTools = this.deps.tools.toKatTools();
    const pattern = await loadPattern(this.deps.workspace, this.deps.patternName?.() ?? "agent");

    // Merge built-in tools with comms tools.
    const commsToolMap = Object.fromEntries(commsTools.map((t: { name: string }) => [t.name, t]));
    // Workspace app tools take precedence over legacy communications tools
    // when an app intentionally exposes the same name (for example,
    // contacts' richer log_message implementation).
    const allTools = { ...commsToolMap, ...katTools };

    const runtime: Record<string, unknown> = {
      models: this.deps.models,
      tools: allTools,
      logger: this.wrapLogger(opts?.onEvent),
      onEmit,
      // Only set logLevel when using the default (string path) logger.
      // When a custom logger is provided, it already handles console output.
      ...(this.deps.logger ? {} : { logLevel: this.deps.logLevel ?? "info" }),
    };

    let outcome: { status?: string; continuation?: string; result?: unknown };

    if (cont) {
      // Resume from checkpoint. The reply is passed raw — grandma-kat's
      // resume() routes it into whatever .human() slot the checkpoint says
      // is paused (e.g. the knowledge branch's verify_search), so the
      // caller never names the slot. See injectHumanInput in
      // grandma-kat/src/knit.mjs.
      outcome = await grandma.knit(pattern, {
        ...runtime,
        _continuation: cont,
        humanInput,
      });
    } else {
      // First run: inject system prompt and start the tree.
      // The tree pauses immediately at .human() — no LLM call yet.
      outcome = await grandma.knit(pattern, {
        ...runtime,
        memory: {
          messages: [],
          workspace: this.deps.workspace,
          main_input: humanInput,
        },
      });
    }

    if (outcome.status === "waiting" && outcome.continuation) {
      this.continuations.set(key, outcome.continuation);
      return { status: "waiting", continuation: outcome.continuation };
    }

    // The tree ran to completion. Not every pattern loops at .human()
    // (e.g. one-shot trees like person-scan), so this is a normal outcome:
    // drop any stale continuation so the next message starts a fresh tree.
    this.continuations.delete(key);
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
   * Clear the continuation for a conversation. The next `run()` will
   * start a fresh tree (new system prompt, empty history). Per-topic:
   * the key is "chatId:message_thread_id". The checkpoint in SQLite is
   * orphaned but not deleted.
   */
  clear(key: string): void {
    this.continuations.delete(key);
  }
}
