import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma, { registerTree } from "grandma-kat";
import type { ToolRegistry } from "./tools/index.js";
import type { ModelRegistry } from "./models.js";
import { loadPattern } from "./pattern-loader.js";
import { listTreeSources } from "./tree-sources.js";
import { parseTreeBase, resolveTreeEntry } from "./tree-versions.js";

/**
 * Whether a resume error means the saved position is dead and the turn should
 * start a fresh tree, rather than being surfaced to the user.
 *
 * Two shapes are recoverable:
 *   - the checkpoint itself is gone (`checkpoint '…' not found`) — the log DB
 *     was cleared or the row pruned under us; and
 *   - the checkpoint exists but its paused tree stack cannot be rebuilt
 *     (`cannot resume: tree '…' is not registered`) — a stale sub-tree
 *     auto-name, or an app/pattern tree edited or re-versioned while the
 *     session was paused. The tree changed, not the request.
 *
 * Anything else is a genuine failure and must propagate.
 */
export function isDroppableContinuationError(message: string): boolean {
  return /checkpoint/i.test(message) || /cannot resume/i.test(message);
}

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
  /**
   * Active version ref for NEW sessions: "vN", "draft", or undefined for the
   * prod default. A getter so a UI/command can retarget new sessions without
   * dropping the sessions already pinned to their own version.
   */
  patternRef?: () => string | undefined;
  /**
   * Host context forwarded verbatim to grandma-kat as `runtime.context` (and
   * from there to tree register bodies). App trees use it to reach things the
   * host owns — the app-secrets store — without exposing an app tool.
   */
  context?: unknown;
  /**
   * Cap on the characters of a tool result shown to the model (grandma-kat
   * `runtime.maxToolResultChars`). Full results are always kept for tree logic
   * and the run log. 0 disables. Defaults to grandma-kat's own default (4000).
   */
  maxToolResultChars?: number;
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
  private sessionTimes = new Map<string, number>(); // key → last activity (wall clock)
  // key → pinned version ref ("contacts@v1", "contacts@draft"). A session
  // keeps the version it started on; switching the active version only
  // affects sessions created afterwards.
  private sessionRefs = new Map<string, string>();
  // key → { role: targetSlot } model-slot overrides. Normally the tree picks
  // its own slots (`Model("strong")`, `Model("cheap")`); a conversation can
  // retarget any of them independently to another named entry in the registry
  // (e.g. a big model for "strong", a small one for the "cheap" router). The
  // role is the slot NAME the tree references; the target is the registry
  // entry it resolves to. Persisted in sessions.json so choices survive a
  // restart.
  private sessionModels = new Map<string, Record<string, string>>();
  // key → the turn a quota wall killed, awaiting the user's fallback choice.
  // The failed model role and the original turn input are kept so the choice
  // can retarget the role and re-run exactly what failed. In-memory only: a
  // restart drops the prompt (the user just sends the message again).
  private pendingFallbacks = new Map<string, { role: string; input: unknown }>();
  // Pin-on-open cache: key → the root pattern + tree-tool registry loaded on
  // the session's first turn and frozen for its lifetime, so a later edit or
  // promote of a `.prod` file never changes a live session's shape (a pause
  // inside a sub-tree — a caller-list walk — resumes against the exact bytes
  // it started on). In-memory only: a restart empties it, and the defId check
  // in runExclusive then decides whether a restored continuation still maps.
  private sessionCache = new Map<
    string,
    { pattern: unknown; defId: string; pinnedRef: string; treeTools: Record<string, unknown> }
  >();
  // One run at a time per conversation key. Web and Telegram may both
  // drive the SAME key (the web "follow" feature), and two concurrent
  // resumes of one checkpoint would race on its load/save — the queue
  // makes a shared conversation safe regardless of transport.
  private runChains = new Map<string, Promise<void>>();
  // Tree-tool discovery runs every turn; warn once per name, not per turn.
  private treeToolWarned = new Set<string>();

  constructor(private deps: AgentDeps) {
    this.logDb = path.resolve(deps.workspace, "logs/grandma-kat.db");
    this.sessionsPath = path.resolve(deps.workspace, "logs", "sessions.json");
    this.loadSessions();
  }

  /**
   * All conversation keys with a live continuation — Telegram topics
   * ("chatId:threadId"), web sessions ("web:<id>"), anything. Used by the
   * web picker to offer cross-transport "follow".
   */
  sessionKeys(): string[] {
    return [...this.continuations.keys()];
  }

  /**
   * Conversation key → its current continuation checkpoint id
   * ("<runId>:<seq>"), i.e. which engine run backs each live session.
   * The web store uses this to match migrated history to the run whose
   * events are in the log.
   */
  sessionContinuationIds(): Map<string, string> {
    return new Map(this.continuations);
  }

  /**
   * Live sessions with their last-activity wall clock. The web UI uses
   * this to FOLLOW the most recently used Telegram conversation.
   */
  sessionMeta(): { key: string; updatedAt: number }[] {
    return [...this.continuations.keys()].map((key) => ({
      key,
      updatedAt: this.sessionTimes.get(key) ?? 0,
    }));
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
        {
          continuation?: unknown;
          pattern?: unknown;
          updatedAt?: unknown;
          ref?: unknown;
          /** Per-role overrides: { strong: "slot", cheap: "slot" }. */
          models?: unknown;
          /** Legacy single-override format (pre-per-role): the "strong" target. */
          model?: unknown;
        } | null
      >;
      if (!raw || typeof raw !== "object") return;
      for (const [key, val] of Object.entries(raw)) {
        // A model override can outlive a continuation (set before the first
        // message, or after a one-shot tree completed), so read it first.
        if (val?.models && typeof val.models === "object") {
          const rec: Record<string, string> = {};
          for (const [role, target] of Object.entries(val.models as Record<string, unknown>)) {
            if (typeof target === "string") rec[role] = target;
          }
          if (Object.keys(rec).length) this.sessionModels.set(key, rec);
        } else if (typeof val?.model === "string") {
          // Migrate the old single-"strong" format.
          this.sessionModels.set(key, { strong: val.model });
        }
        if (typeof val?.continuation === "string") {
          this.continuations.set(key, val.continuation);
          if (typeof val.pattern === "string") this.sessionPatterns.set(key, val.pattern);
          if (typeof val.updatedAt === "number") this.sessionTimes.set(key, val.updatedAt);
          if (typeof val.ref === "string") this.sessionRefs.set(key, val.ref);
        }
      }
    } catch {
      // no persisted sessions yet
    }
  }

  /** Atomically persist the continuation map (write tmp, rename). */
  private saveSessions(): void {
    const out: Record<
      string,
      {
        continuation: string | null;
        pattern: string | null;
        updatedAt?: number;
        ref: string | null;
        models: Record<string, string> | null;
      }
    > = {};
    // Persist a key when it has a continuation OR a model override (an override
    // can be set before the conversation's first message).
    const keys = new Set([...this.continuations.keys(), ...this.sessionModels.keys()]);
    for (const key of keys) {
      const models = this.sessionModels.get(key);
      out[key] = {
        continuation: this.continuations.get(key) ?? null,
        pattern: this.sessionPatterns.get(key) ?? null,
        updatedAt: this.sessionTimes.get(key),
        ref: this.sessionRefs.get(key) ?? null,
        models: models && Object.keys(models).length ? models : null,
      };
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
   * Structural skeleton hash, used ONLY to decide whether a saved
   * continuation still maps to the freshly built tree. grandma-kat resumes by
   * child INDEX along the paused path (and resolves trees by name), so only
   * the child structure matters — a prompt's text, tools, model, gates and
   * options can change freely without moving the pause point.
   *
   * Hashing the FULL definition made volatile, resume-irrelevant churn drop a
   * live conversation's whole saved position: the trunk's Tools() list is
   * built from a filesystem scan of app/ (trunk_step's appTreeNames()), so
   * creating or editing an app dir while a session was paused changed the
   * hash and nuked its context. The skeleton ignores all of that.
   */
  static resumeHash(tree: unknown): string {
    const def = (tree as { def?: unknown } | null)?.def ?? tree;
    const skeleton = (node: unknown): unknown => {
      if (!node || typeof node !== "object") return null;
      const n = node as { kind?: unknown; name?: unknown; children?: unknown; tree?: unknown };
      const out: Record<string, unknown> = { kind: n.kind ?? null, name: n.name ?? null };
      if (Array.isArray(n.children)) out.children = n.children.map(skeleton);
      // An inline sub-tree (a Branch body) is a separate resume level: its own
      // child indices matter. A named ref is just a string here (its shape is
      // resolved at run time, as before).
      if (n.tree && typeof n.tree === "object") out.tree = skeleton(n.tree);
      return out;
    };
    const json = JSON.stringify(skeleton(def));
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
    const prev = this.runChains.get(key);
    const work = (prev ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.runExclusive(key, humanInput, onEmit, opts));
    // Void mirror for the queue: settles on success AND failure so a
    // crashed turn never blocks the next one.
    const gate = work.then(() => {}, () => {});
    this.runChains.set(key, gate);
    try {
      return await work;
    } finally {
      if (this.runChains.get(key) === gate) this.runChains.delete(key);
    }
  }

  /**
   * Tell the conversation that a saved position was dropped and the turn is
   * starting fresh. Emitted through the run's onEmit so both transports show
   * it (Telegram sends it, the web UI appends it to the turn).
   */
  private async noticeDrop(
    onEmit: ((value: unknown) => void | Promise<void>) | undefined,
    reason: string,
  ): Promise<void> {
    if (!onEmit) return;
    try {
      await onEmit({
        text: `Heads up: I dropped the saved position for this conversation — ${reason} — so this message starts fresh.`,
      });
    } catch {
      // The transport is already handling its own send errors.
    }
  }

  /** The unqueued body of run(); call only through run() so keys stay serialized. */
  private async runExclusive(
    key: string,
    humanInput: unknown,
    onEmit?: (value: unknown) => void | Promise<void>,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    let cont = this.continuations.get(key);
    let droppedContinuation = false;
    const katTools = this.deps.tools.toKatTools();
    let dropReason: string | null = null;

    // Pin-on-open: the root pattern AND the tree-tool registry are loaded once,
    // on the session's first turn, and frozen for its lifetime. A later edit or
    // promote of a `.prod` file therefore never changes a live session's shape
    // — a pause inside a sub-tree (a caller-list walk) resumes against the
    // exact bytes it started on. A restart empties this cache; the defId check
    // below then decides whether a restored continuation still maps to the
    // freshly loaded tree.
    let session = this.sessionCache.get(key);
    if (!session) {
      // Resolve the session's pinned version. A fresh session adopts the
      // active ref; a resumed session keeps the ref it started on, so editing
      // or promoting another version never disturbs it.
      const logical = this.deps.patternName?.() ?? "trunk";
      const activeRef = await this.resolveActiveRef(logical);
      let pinnedRef = this.sessionRefs.get(key) ?? activeRef;
      let pattern: unknown;

      try {
        pattern = await loadPattern(this.deps.workspace, pinnedRef);
      } catch (err) {
        // The pinned version was removed (manual prune/rename). Drop the
        // session and restart on whatever is active now.
        if (!cont) throw err;
        dropReason = "its version was removed";
        pinnedRef = activeRef;
        pattern = await loadPattern(this.deps.workspace, pinnedRef);
        cont = undefined;
        droppedContinuation = true;
      }

      let defId = Agent.resumeHash(pattern);

      // A checkpoint was grown under a specific tree SHAPE; if the child
      // structure along the paused path changed (a draft edit that moves or
      // renumbers children), the stored pause point may no longer map to the
      // same `.human()` slot — start fresh on the active ref. Resume-irrelevant
      // churn (prompt text, tools, models, options — e.g. the trunk's app-tree
      // scan) does NOT change this hash, so it never drops a live session.
      if (!droppedContinuation && cont && this.sessionPatterns.get(key) !== defId) {
        dropReason = "the tree changed since it paused (it was edited or the pattern was switched)";
        pinnedRef = activeRef;
        pattern = await loadPattern(this.deps.workspace, pinnedRef);
        defId = Agent.resumeHash(pattern);
        cont = undefined;
        droppedContinuation = true;
      }

      session = { pattern, defId, pinnedRef, treeTools: await this.discoverTreeTools() };
      this.sessionCache.set(key, session);
    }

    const { pattern, defId, pinnedRef, treeTools } = session;

    // Guidance for the tools in scope (host + app + tree), assembled by the
    // registry so nothing about "how to use a tool" lives in the trunk.
    const treeGuides = Object.entries(treeTools).map(([name, tool]) => ({
      name,
      guide: String((tool as { guide?: unknown } | null)?.guide ?? ""),
    }));
    const guide = this.deps.tools.toolGuide({ treeGuides });

    if (droppedContinuation) {
      this.continuations.delete(key);
      this.sessionPatterns.delete(key);
      this.sessionTimes.delete(key);
      this.sessionRefs.delete(key);
      this.saveSessions();
      await this.noticeDrop(onEmit, dropReason ?? "the saved position no longer matches");
    }

    // Function tools win name collisions; tree tools fill in the rest, so a
    // pattern can offer any workspace tree to the model by name.
    const allTools = { ...treeTools, ...katTools };

    const runtime: Record<string, unknown> = {
      models: this.modelsFor(key),
      tools: allTools,
      // Dynamic tree loader: resolves a tree by name from patterns/ or
      // app/ when the engine needs one that was never built into this
      // process (tree tools, and resume after a restart).
      loadTree: (name: string) => this.loadTreeByName(name),
      // Session memory: a tree invoked as a TOOL keeps its slots across
      // invocations within one conversation, keyed (sessionId × tree name).
      // The conversation key is that id, so an app that yields to the trunk
      // (e.g. email's hand_off) can resume its own state on re-entry.
      sessionId: key,
      logger: this.wrapLogger(opts?.onEvent),
      onEmit,
      // Bound what the model sees for a tool result (grandma-kat caps and
      // rows-trims before the prompt's thread). Full results stay for tree
      // logic and the run log. Absent → grandma-kat's default (4000).
      ...(this.deps.maxToolResultChars !== undefined ? { maxToolResultChars: this.deps.maxToolResultChars } : {}),
      // Only set logLevel when using the default (string path) logger.
      // When a custom logger is provided, it already handles console output.
      ...(this.deps.logger ? {} : { logLevel: this.deps.logLevel ?? "info" }),
      ...(this.deps.context !== undefined ? { context: this.deps.context } : {}),
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
          guide,
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
          memory: { workspace: this.deps.workspace, guide },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A dead checkpoint (missing from the log DB) OR a resume that cannot
        // rebuild the paused tree stack (a stale sub-tree name, an app tree
        // edited/re-versioned under a live pause): drop the continuation and
        // grow a fresh tree instead of failing the turn. The tree changed,
        // not the request — the user's message still deserves an answer.
        if (!isDroppableContinuationError(msg)) throw err;
        console.warn(`[agent] stale checkpoint for '${key}' (${msg}) — starting fresh tree`);
        this.continuations.delete(key);
        this.sessionPatterns.delete(key);
        this.sessionTimes.delete(key);
        this.saveSessions();
        droppedContinuation = true;
        await this.noticeDrop(
          onEmit,
          /cannot resume/i.test(msg)
            ? "its saved position could not be restored (the tree changed or a sub-tree is gone)"
            : "its saved checkpoint is no longer in the log database",
        );
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
        memory: { workspace: this.deps.workspace, guide },
      });
    }

    if (outcome.status === "waiting" && outcome.continuation) {
      this.continuations.set(key, outcome.continuation);
      this.sessionPatterns.set(key, defId);
      this.sessionTimes.set(key, Date.now());
      this.sessionRefs.set(key, pinnedRef);
      this.saveSessions();
      return { status: "waiting", continuation: outcome.continuation };
    }

    // The tree ran to completion. Not every pattern loops at .human()
    // (e.g. one-shot trees like person-scan), so this is a normal outcome:
    // drop any stale continuation so the next message starts a fresh tree.
    this.continuations.delete(key);
    this.sessionPatterns.delete(key);
    this.sessionTimes.delete(key);
    this.sessionRefs.delete(key);
    this.sessionCache.delete(key);
    this.saveSessions();
    return { status: "done", result: outcome.result };
  }

  /**
   * Wrap the configured logger so each logged event also reaches
   * `onEvent` (per-run telemetry for the web UI). Read methods —
   * checkpoints, events, and `readRow` (the engine's run-log reader behind
   * `ref://` handles) — and `startRun` (the conversation key on the run
   * row) are delegated to the base logger untouched; the shared logger is
   * never closed by the wrapper. Without `onEvent` (or with a plain db-path
   * string logger) the original logger is returned as-is.
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
      // startRun records the conversation key on the run row. It MUST be
      // delegated: the engine calls it through this wrapper, and without it
      // the whole `runs` registry went unwritten for onEvent turns (web /
      // telegram) — the reason production's runs table was empty.
      startRun: (...a: unknown[]) => (base.startRun as Function | undefined)?.(...a),
      saveCheckpoint: (...a: unknown[]) => (base.saveCheckpoint as Function | undefined)?.(...a),
      getCheckpoint: (...a: unknown[]) => (base.getCheckpoint as Function | undefined)?.(...a),
      deleteCheckpoint: (...a: unknown[]) => (base.deleteCheckpoint as Function | undefined)?.(...a),
      getEvents: (...a: unknown[]) => (base.getEvents as Function | undefined)?.(...a),
      readRow: (...a: unknown[]) => (base.readRow as Function | undefined)?.(...a),
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
   * Every runnable workspace tree (patterns/<name>.draft.mjs, app/<name>/tree.draft.mjs)
   * as a callable tool entry. Prompts opt in with `.tools("<name>")` and the
   * model calls them like any other tool; the engine runs the tree in place
   * (pauses inside resume in position). Broken trees are skipped so one bad
   * file cannot break a turn.
   */
  private async discoverTreeTools(): Promise<Record<string, unknown>> {
    const sources = await listTreeSources(this.deps.workspace);
    const tools: Record<string, unknown> = {};
    for (const source of sources) {
      if (!/^[A-Za-z0-9._-]+$/.test(source.name)) continue;
      try {
        const built = await loadPattern(this.deps.workspace, source.name);
        const def = (built as { def?: { needs?: unknown; needsDescriptions?: unknown; needsOptional?: unknown } } | null)?.def ?? built;
        // Register discovered trees in grandma-kat's global registry so an app
        // tree can attach another by name with From("…") without importing it
        // (From resolves the registry at build time, not runtime.tools).
        try {
          registerTree(def as never);
        } catch {
          // a def without a name is not registrable; ignore
        }
        const needs = Array.isArray((def as { needs?: unknown } | null)?.needs)
          ? (def as { needs: string[] }).needs
          : [];
        const needDescriptions =
          ((def as { needsDescriptions?: Record<string, unknown> } | null)?.needsDescriptions) ?? {};
        const optionalNeeds = new Set(
          Array.isArray((def as { needsOptional?: unknown } | null)?.needsOptional)
            ? (def as { needsOptional: string[] }).needsOptional
            : [],
        );
        const required = needs.filter((need) => !optionalNeeds.has(need));
        if (tools[source.name]) {
          // Both a pattern and an app tree can share a name; listTreeSources
          // sorts apps last, so the app tree wins the tool slot.
          this.warnTreeToolOnce(
            `shadow:${source.name}`,
            `[agent] tree tool '${source.name}' shadowed by a later source (${source.file})`,
          );
        }
        tools[source.name] = {
          description:
            `${source.description} Call this to run the "${source.name}" tree; ` +
            "the tree's result is returned as the tool result.",
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              needs.map((need) => [
                need,
                {
                  description:
                    typeof needDescriptions[need] === "string" && needDescriptions[need]
                      ? needDescriptions[need]
                      : `Input seeded into the tree as '${need}'.`,
                },
              ]),
            ),
            ...(required.length ? { required } : {}),
          },
          tree: source.name,
          guide: source.guide ?? "",
        };
      } catch (error) {
        // Helper modules (e.g. patterns/shared.mjs) and broken trees land
        // here; warn once per name so the log stays readable.
        this.warnTreeToolOnce(
          `skip:${source.name}`,
          `[agent] tree tool '${source.name}' skipped: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return tools;
  }

  private warnTreeToolOnce(key: string, message: string): void {
    if (this.treeToolWarned.has(key)) return;
    this.treeToolWarned.add(key);
    console.warn(message);
  }

  /**
   * Resolve a tree by name for the engine's loadTree hook. Names arrive
   * either as the file/app name ("caller-list") or as the tree's internal
   * name ("caller_list", used by resume), so try the name and its
   * underscore/dash variants. Unknown names return null — the engine then
   * falls back to its build-time registry.
   */
  private async loadTreeByName(name: string): Promise<unknown> {
    // Names arrive in three shapes:
    //   - a bare logical name ("caller-list", "contacts")
    //   - the operator ref form ("trunk@v1", "trunk@draft")
    //   - a version-qualified INTERNAL name ("trunk.v1") — checkpoints store
    //     this as the resume tree name, and `.vN`/`.prod` are reserved.
    // Only the logical part gets the underscore/dash fallback.
    let logical: string;
    let ref: string;
    const at = name.indexOf("@");
    if (at >= 0) {
      logical = name.slice(0, at);
      ref = name.slice(at + 1);
    } else {
      const parsed = parseTreeBase(name);
      if (parsed && (parsed.version !== null || parsed.prod)) {
        logical = parsed.logical;
        ref = parsed.version ?? "prod";
      } else {
        logical = name;
        ref = "";
      }
    }
    const candidates = [logical];
    if (logical.includes("_")) candidates.push(logical.replace(/_/g, "-"));
    if (logical.includes("-")) candidates.push(logical.replace(/-/g, "_"));
    for (const candidate of candidates) {
      try {
        return await loadPattern(this.deps.workspace, ref ? `${candidate}@${ref}` : candidate);
      } catch {
        // try the next spelling
      }
    }
    return null;
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
    this.sessionTimes.delete(key);
    this.sessionRefs.delete(key);
    this.sessionModels.delete(key);
    this.pendingFallbacks.delete(key);
    this.sessionCache.delete(key);
    this.saveSessions();
  }

  /**
   * The version ref a live session is pinned to ("contacts@v1",
   * "contacts@draft"). Undefined for a session with no checkpoint. The UI
   * shows this as a pinned-version badge.
   */
  sessionRef(key: string): string | undefined {
    return this.sessionRefs.get(key);
  }

  /**
   * The registry as a tree should see it this turn: the shared registry, with
   * each overridden role (slot name the tree references) resolving to the
   * conversation's chosen target slot. Unknown/stale targets are ignored (the
   * base registry wins), so deleting a slot in the settings editor can never
   * break a live chat. Returns the shared object unchanged when there is no
   * applicable override, so the common case allocates nothing.
   */
  modelsFor(key: string): ModelRegistry {
    const base = this.deps.models;
    const overrides = this.sessionModels.get(key);
    if (!overrides) return base;
    let out: ModelRegistry | null = null;
    for (const [role, target] of Object.entries(overrides)) {
      if (target === role || !base[target]) continue;
      if (!out) out = { ...base };
      out[role] = base[target];
    }
    return out ?? base;
  }

  /** Registry slot names and safe display fields (never the api key). */
  modelSlots(): { name: string; model: string; baseURL: string; protocol?: string }[] {
    return Object.entries(this.deps.models).map(([name, m]) => ({
      name,
      model: m.model,
      baseURL: m.baseURL,
      ...(m.protocol ? { protocol: m.protocol } : {}),
    }));
  }

  /**
   * Retarget this conversation's `role` slot (e.g. "strong", "cheap") to
   * `target`. Returns false when the target is unknown (nothing changes).
   * Persists to sessions.json.
   */
  setSessionModel(key: string, role: string, target: string): boolean {
    if (!this.deps.models[target]) return false;
    const rec = this.sessionModels.get(key) ?? {};
    rec[role] = target;
    this.sessionModels.set(key, rec);
    this.saveSessions();
    return true;
  }

  /**
   * Drop one role override, or every override for this conversation when
   * `role` is omitted.
   */
  clearSessionModel(key: string, role?: string): void {
    const rec = this.sessionModels.get(key);
    if (!rec) return;
    if (role) {
      if (!(role in rec)) return;
      delete rec[role];
      if (!Object.keys(rec).length) this.sessionModels.delete(key);
    } else {
      this.sessionModels.delete(key);
    }
    this.saveSessions();
  }

  /**
   * The target slot a role overrides to. Without `role`, returns the "strong"
   * override (the primary conversation model) for backward compatibility.
   */
  sessionModel(key: string, role = "strong"): string | undefined {
    return this.sessionModels.get(key)?.[role];
  }

  /** Every role override for a conversation, as a plain object. */
  sessionModelMap(key: string): Record<string, string> {
    const rec = this.sessionModels.get(key);
    return rec ? { ...rec } : {};
  }

  /**
   * Remember the turn a quota wall killed, so the user's fallback choice can
   * re-run it. `role` is the model slot that failed (grandma-kat tags it on the
   * error); `input` is the original turn content, re-delivered verbatim.
   */
  setPendingFallback(key: string, role: string, input: unknown): void {
    this.pendingFallbacks.set(key, { role: role || "strong", input });
  }

  /** The pending fallback for a conversation, if any. */
  pendingFallback(key: string): { role: string; input: unknown } | undefined {
    return this.pendingFallbacks.get(key);
  }

  /** Drop a pending fallback (a normal turn supersedes the prompt). */
  clearPendingFallback(key: string): void {
    this.pendingFallbacks.delete(key);
  }

  /**
   * Apply the user's fallback choice: retarget the failed role to `slot`
   * (persisted, exactly like /model), then return the killed turn's input so
   * the caller can re-run it. Returns null when nothing is pending or the slot
   * is unknown — the pending record survives a bad slot so the user can retry.
   */
  confirmFallback(key: string, slot: string): { role: string; input: unknown } | null {
    const pending = this.pendingFallbacks.get(key);
    if (!pending) return null;
    if (!this.setSessionModel(key, pending.role, slot)) return null;
    this.pendingFallbacks.delete(key);
    return pending;
  }

  /**
   * Replace the live registry in place after models.json is edited. The object
   * is mutated (not swapped) so every holder — turns, the bot's /status, the
   * admin probes — sees the new entries without a restart.
   */
  updateModels(registry: ModelRegistry): void {
    const base = this.deps.models;
    for (const name of Object.keys(base)) delete base[name];
    Object.assign(base, registry);
  }

  /**
   * Version ids a live session still pins for `logical`. Pruning must never
   * delete these — a running conversation would lose its tree mid-flight.
   */
  pinnedVersions(logical: string): string[] {
    const out = new Set<string>();
    for (const ref of this.sessionRefs.values()) {
      const [refLogical, version] = ref.split("@");
      if (refLogical === logical && version && version !== "draft" && version !== "prod") {
        out.add(version);
      }
    }
    return [...out];
  }

  /**
   * Drop every session whose root tree is `logical` (a logical-tree switch
   * invalidates the pause state). Sessions pinned to other logical trees are
   * left alone. Version switches do NOT call this — only logical switches.
   */
  clearSessionsForLogical(logical: string): string[] {
    const cleared: string[] = [];
    for (const key of [...this.continuations.keys()]) {
      const ref = this.sessionRefs.get(key);
      const refLogical = ref ? ref.split("@")[0] : undefined;
      // A legacy session (no stored ref) belonged to whatever logical was
      // active before, so it is cleared with the switch.
      if (refLogical === undefined || refLogical === logical) {
        this.clear(key);
        cleared.push(key);
      }
    }
    return cleared;
  }

  /**
   * The ref new sessions should adopt: the configured ref resolved to a
   * concrete version ("vN") or "draft". Falls back to the raw ref when the
   * tree cannot be scanned (loadPattern will surface the real error).
   */
  private async resolveActiveRef(logical: string): Promise<string> {
    const ref = this.deps.patternRef?.();
    const resolved = await resolveTreeEntry(this.deps.workspace, logical, ref);
    const concrete = resolved
      ? resolved.draft
        ? "draft"
        : (resolved.version ?? "prod")
      : (ref ?? "prod");
    return `${logical}@${concrete}`;
  }
}
