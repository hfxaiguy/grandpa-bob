import path from "node:path";
import crypto from "node:crypto";
// @ts-ignore — grandma-kat ships no .d.ts files.
import grandma, { registerTree } from "grandma-kat";
import type { ToolRegistry } from "./tools/index.js";
import type { ModelRegistry } from "./models.js";
import { loadPattern } from "./pattern-loader.js";
import { listTreeSources } from "./tree-sources.js";
import { raceWithStop, isAgentStopped, AgentStoppedError, throwIfStopped } from "./stop-error.js";
import { runWithStop } from "./stop.js";
import { WebLog } from "./web-log.js";
import type { SessionMeta, SessionStateStore } from "./web-log-types.js";

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
      /**
       * The paused tree stack's branch_path (tree names joined by "/"). The
       * agent uses it to pin which runtime-loaded subtrees this session
       * depends on, so promoting/editing one drops the pause before resume.
       */
      treePath?: string;
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
  /**
   * Abort this turn. In-flight model calls are cancelled, tool calls stop
   * being awaited, and the engine's next logged step throws, so the tree
   * cannot advance. The previous checkpoint remains the resume point.
   */
  signal?: AbortSignal;
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

/**
 * Wrap every tool's `execute` so a stop rejects it immediately. Tree tools
 * (`tree: name`) have no execute and are stopped by the logger/fetch checks.
 */
function withStopTools(
  tools: Record<string, unknown>,
  signal?: AbortSignal,
): Record<string, unknown> {
  if (!signal) return tools;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tools)) {
    const tool = value as { execute?: (...args: unknown[]) => unknown } | null;
    if (!tool || typeof tool !== "object" || typeof tool.execute !== "function") {
      out[name] = value;
      continue;
    }
    const execute = tool.execute.bind(tool);
    out[name] = {
      ...tool,
      execute: (...args: unknown[]) => {
        throwIfStopped(signal);
        return raceWithStop(Promise.resolve(execute(...args)), signal);
      },
    };
  }
  return out;
}

export class Agent {
  private logDb: string;
  /** Session state store — the log DB, one definition for both targets. */
  private sessionStore: SessionStateStore;
  private continuations = new Map<string, string>();
  private sessionPatterns = new Map<string, string>(); // key → pattern definition hash
  private sessionTimes = new Map<string, number>(); // key → last activity (wall clock)
  // key → { role: targetSlot } model-slot overrides. Normally the tree picks
  // its own slots (`Model("strong")`, `Model("cheap")`); a conversation can
  // retarget any of them independently to another named entry in the registry
  // (e.g. a big model for "strong", a small one for the "cheap" router). The
  // role is the slot NAME the tree references; the target is the registry
  // entry it resolves to. Persisted as a session-meta marker row (the log DB
  // is the only store; there is no sessions.json anymore).
  private sessionModels = new Map<string, Record<string, string>>();
  // key → the paused stack's branch_path, and a content hash of the subtrees
  // it names. The root pattern's skeleton hash (sessionPatterns) cannot see
  // edits to a tree attached by name (From("contacts"), an app tree tool), so
  // promoting or editing one would otherwise resume into changed code. The
  // signature is recomputed from the CURRENT files on every resume; a change
  // drops the session before it resumes. Persisted as a session-meta marker.
  private sessionTreePaths = new Map<string, string>();
  private sessionSubtreeHashes = new Map<string, string>();
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
    { pattern: unknown; defId: string; treeTools: Record<string, unknown> }
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
    // The log DB is the single session store, exactly as in the browser
    // target: continuations come from the engine's runs/checkpoints rows, and
    // the host-only bits from session-meta marker rows. No sessions.json.
    this.sessionStore = new WebLog(this.logDb, (key) => key);
    this.restoreSessions();
  }

  /** Apply the DB-derived conversation state to the live maps. */
  private restoreSessions(): void {
    let state: ReturnType<SessionStateStore["restoreSessions"]>;
    try {
      state = this.sessionStore.restoreSessions();
    } catch (e) {
      console.warn("[agent] could not restore sessions:", e instanceof Error ? e.message : e);
      return;
    }
    this.continuations = state.continuations;
    this.sessionPatterns = state.patterns;
    this.sessionTimes = state.times;
    this.sessionTreePaths = state.treePaths;
    this.sessionSubtreeHashes = state.subtreeHashes;
    this.sessionModels = state.models;
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
   * Persist the conversation bits the engine's trace cannot carry — resume
   * hash, model overrides, pinned ref, paused tree path/signature — as one
   * session-meta marker in the log DB. The latest marker per key wins;
   * `cleared` also tombstones everything older (an explicit clear).
   */
  private persistSessionMeta(key: string, opts: { cleared?: boolean } = {}): void {
    const models = this.sessionModels.get(key);
    const meta: SessionMeta = {
      key,
      ts: Date.now(),
      pattern: this.sessionPatterns.get(key) ?? null,
      models: models && Object.keys(models).length ? models : undefined,
      treePath: this.sessionTreePaths.get(key) ?? null,
      subtreeHash: this.sessionSubtreeHashes.get(key) ?? null,
      ...(opts.cleared ? { clearedAt: Date.now() } : {}),
    };
    try {
      this.sessionStore.writeSessionMeta(meta);
    } catch (e) {
      console.warn("[agent] failed to save session state:", e instanceof Error ? e.message : e);
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
   * built from a filesystem scan of app/ (the trunk's appTreeNames()), so
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
   * Content signature of the runtime-loaded subtrees a paused stack names.
   * `treePath` is the paused `branch_path`; its non-auto segments are the trees
   * attached by name (`From("contacts")`, an app tree tool) and are hashed from
   * their CURRENT definition on disk. A segment carrying "#" is a positional
   * auto-name inside its parent — covered by that parent's own hash — and is
   * skipped. Returns null when nothing named resolves (a pause with no attached
   * sub-tree), so the comparison simply doesn't fire.
   *
   * The root pattern is included too (its segment resolves); that is harmless
   * and keeps the signature self-contained.
   */
  private async subtreeSignature(treePath: string): Promise<string | null> {
    const names = [...new Set(treePath.split("/").filter((n) => n && !n.includes("#")))];
    const parts: string[] = [];
    for (const name of names) {
      try {
        const def = await this.loadTreeByName(name);
        if (def) parts.push(`${name}:${Agent.resumeHash(def)}`);
      } catch {
        // An internal helper with no file of its own (e.g. "trunk_turn") does
        // not resolve here; leave it out. A genuine resume failure is still
        // caught by the drop guard below.
      }
    }
    if (!parts.length) return null;
    return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
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
      .then(() =>
        runWithStop(opts?.signal, () => this.runExclusive(key, humanInput, onEmit, opts)),
      );
    // Void mirror for the queue: settles on success AND failure so a
    // crashed turn never blocks the next one.
    const gate = work.then(() => {}, () => {});
    this.runChains.set(key, gate);
    try {
      return await work;
    } catch (err) {
      if (opts?.signal?.aborted || isAgentStopped(err)) throw new AgentStoppedError();
      throw err;
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
    throwIfStopped(opts?.signal);
    let cont = this.continuations.get(key);
    let droppedContinuation = false;
    const katTools = this.deps.tools.toKatTools();
    let dropReason: string | null = null;

    // BOB owns app-tree discovery: refresh the env the trunk reads at import.
    // loadPattern re-imports fresh on every call (?t= cache bust), so the env
    // and the module always agree at load time.
    try {
      const sources = await listTreeSources(this.deps.workspace);
      const apps = sources.filter((s) => s.group === "app").map((s) => s.name);
      if (apps.length) process.env.BOB_APP_TREES = JSON.stringify(apps);
    } catch {
      // A scan failure leaves the previous env (or the trunk's own scan) in place.
    }

    // Pin-on-open: the root pattern AND the tree-tool registry are loaded once,
    // on the session's first turn, and frozen for its lifetime. A later edit or
    // promote of a `.prod` file therefore never changes a live session's shape
    // — a pause inside a sub-tree (a caller-list walk) resumes against the
    // exact bytes it started on. A restart empties this cache; the defId check
    // below then decides whether a restored continuation still maps to the
    // freshly loaded tree.
    let session = this.sessionCache.get(key);
    if (!session) {
      // Load the active tree once, on the session's first turn. A resumed
      // session keeps the bytes it opened on (pin-on-open), so editing the
      // file never disturbs a live conversation.
      const logical = this.deps.patternName?.() ?? "trunk";
      let pattern: unknown;

      try {
        pattern = await loadPattern(this.deps.workspace, logical);
      } catch (err) {
        // The tree went missing (deleted/renamed). Nothing can be resumed.
        throw err;
      }

      let defId = Agent.resumeHash(pattern);

      // A checkpoint was grown under a specific tree SHAPE; if the child
      // structure along the paused path changed (an edit that moves or
      // renumbers children), the stored pause point may no longer map to the
      // same `.human()` slot — start fresh on the current tree. Resume-irrelevant
      // churn (prompt text, tools, models, options — e.g. the trunk's app-tree
      // scan) does NOT change this hash, so it never drops a live session.
      // No stored hash (a pause from before session-meta markers existed) means
      // no comparison: resume once, and the next pause records the hash.
      const storedPattern = this.sessionPatterns.get(key);
      if (!droppedContinuation && cont && storedPattern && storedPattern !== defId) {
        dropReason = "the tree changed since it paused (it was edited or the pattern was switched)";
        pattern = await loadPattern(this.deps.workspace, this.deps.patternName?.() ?? "trunk");
        defId = Agent.resumeHash(pattern);
        cont = undefined;
        droppedContinuation = true;
      }

      // A session also depends on trees attached BY NAME — From("contacts"),
      // an app tree tool — that the root skeleton never sees. Hash those from
      // the paused stack's branch_path and compare against what it paused with:
      // editing one drops the pause here, cleanly, instead of resuming into
      // changed code (or dying on a stale sub-tree name).
      if (!droppedContinuation && cont) {
        const storedPath = this.sessionTreePaths.get(key);
        const storedSig = this.sessionSubtreeHashes.get(key);
        if (storedPath && storedSig) {
          const now = await this.subtreeSignature(storedPath);
          if (now && now !== storedSig) {
            dropReason = "a tree it depends on changed since it paused (it was edited)";
            pattern = await loadPattern(this.deps.workspace, this.deps.patternName?.() ?? "trunk");
            defId = Agent.resumeHash(pattern);
            cont = undefined;
            droppedContinuation = true;
          }
        }
      }

      session = { pattern, defId, treeTools: await this.discoverTreeTools() };
      this.sessionCache.set(key, session);
    }

    const { pattern, defId, treeTools } = session;

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
      this.sessionTreePaths.delete(key);
      this.sessionSubtreeHashes.delete(key);
      this.persistSessionMeta(key);
      await this.noticeDrop(onEmit, dropReason ?? "the saved position no longer matches");
    }

    // Function tools win name collisions; tree tools fill in the rest, so a
    // pattern can offer any workspace tree to the model by name. The stop
    // signal rejects a tool the user stopped instead of awaiting its side
    // effect to finish.
    const allTools = withStopTools({ ...treeTools, ...katTools }, opts?.signal);

    // The same knowledge, structured for trees: { [tool]: { description, guide } }.
    // Injected as `tool_catalog` so a pattern selects by name — never by
    // parsing the assembled `guide` text.
    const toolCatalog = Object.fromEntries(
      Object.entries(allTools).map(([name, tool]) => {
        const t = (tool ?? {}) as { description?: unknown; guide?: unknown };
        return [name, { description: String(t.description ?? ""), guide: String(t.guide ?? "") }];
      }),
    );

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
      logger: this.wrapLogger(opts?.onEvent, opts?.signal),
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

    const freshRun = () => {
      throwIfStopped(opts?.signal);
      return grandma.knit(pattern, {
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
          tool_catalog: toolCatalog,
          ...(needsInput ? { input: humanInput } : {}),
        },
      });
    };

    let outcome: { status?: string; continuation?: string; result?: unknown; treePath?: string };

    if (cont) {
      // Resume from checkpoint. The reply is passed raw — grandma-kat's
      // resume() routes it into whatever .human() slot the checkpoint says
      // is paused (e.g. the knowledge branch's verify_search), so the
      // caller never names the slot. See injectHumanInput in
      // grandma-kat/src/knit.mjs.
      try {
        throwIfStopped(opts?.signal);
        outcome = await grandma.knit(pattern, {
          ...runtime,
          _continuation: cont,
          humanInput,
          memory: { workspace: this.deps.workspace, guide, tool_catalog: toolCatalog },
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
        this.sessionTreePaths.delete(key);
        this.sessionSubtreeHashes.delete(key);
        this.persistSessionMeta(key);
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
      throwIfStopped(opts?.signal);
      outcome = await grandma.knit(pattern, {
        ...runtime,
        _continuation: outcome.continuation,
        humanInput,
        memory: { workspace: this.deps.workspace, guide },
      });
    }

    // A stop that lands after the engine pauses but before the host records
    // the new checkpoint must not be mistaken for a completed turn.
    throwIfStopped(opts?.signal);

    if (outcome.status === "waiting" && outcome.continuation) {
      this.continuations.set(key, outcome.continuation);
      this.sessionPatterns.set(key, defId);
      this.sessionTimes.set(key, Date.now());
      // Remember which runtime-loaded subtrees this pause sits in, so a later
      // promote/edit of one is detected before the next resume.
      const treePath = outcome.treePath;
      if (typeof treePath === "string") {
        this.sessionTreePaths.set(key, treePath);
        const sig = await this.subtreeSignature(treePath);
        if (sig) this.sessionSubtreeHashes.set(key, sig);
        else this.sessionSubtreeHashes.delete(key);
      }
      this.persistSessionMeta(key);
      return { status: "waiting", continuation: outcome.continuation };
    }

    // The tree ran to completion. Not every pattern loops at .human()
    // (e.g. one-shot trees like person-scan), so this is a normal outcome:
    // drop any stale continuation so the next message starts a fresh tree.
    this.continuations.delete(key);
    this.sessionPatterns.delete(key);
    this.sessionTimes.delete(key);
    this.sessionTreePaths.delete(key);
    this.sessionSubtreeHashes.delete(key);
    this.sessionCache.delete(key);
    this.persistSessionMeta(key);
    return { status: "done", result: outcome.result };
  }

  /**
   * Wrap the configured logger so each logged event also reaches
   * `onEvent` (per-run telemetry for the web UI) and so a stopped turn throws
   * before the engine can run its next step. Read methods — checkpoints,
   * events, and `readRow` (the engine's run-log reader behind `ref://`
   * handles) — and `startRun` (the conversation key on the run row) are
   * delegated to the base logger untouched; the shared logger is never
   * closed by the wrapper. Without `onEvent`/`signal` (or with a plain
   * db-path string logger) the original logger is returned as-is.
   */
  private wrapLogger(onEvent?: (event: unknown) => void, signal?: AbortSignal): unknown {
    const base = this.deps.logger as
      | { log?: (e: unknown) => number | void; [k: string]: unknown }
      | undefined;
    if ((!onEvent && !signal) || !base || typeof base.log !== "function") {
      return this.deps.logger ?? this.logDb;
    }
    return {
      log(event: unknown): number | void {
        throwIfStopped(signal);
        try {
          onEvent?.(event);
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
   * Every runnable workspace tree (patterns/<name>.prod.mjs, app/<name>/tree.prod.mjs)
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
    // A checkpoint stores the tree's logical name. App directories may use a
    // dash where the tree's internal name uses an underscore (and vice versa),
    // so try both spellings.
    const candidates = [name];
    if (name.includes("_")) candidates.push(name.replace(/_/g, "-"));
    if (name.includes("-")) candidates.push(name.replace(/-/g, "_"));
    for (const candidate of candidates) {
      try {
        return await loadPattern(this.deps.workspace, candidate);
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
    this.sessionTreePaths.delete(key);
    this.sessionSubtreeHashes.delete(key);
    this.sessionModels.delete(key);
    this.pendingFallbacks.delete(key);
    this.sessionCache.delete(key);
    // The checkpoint row is orphaned, not deleted — the clearedAt tombstone is
    // what keeps a restart from resurrecting it (or any older state).
    this.persistSessionMeta(key, { cleared: true });
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
   * Persisted as a session-meta marker in the log DB.
   */
  setSessionModel(key: string, role: string, target: string): boolean {
    if (!this.deps.models[target]) return false;
    const rec = this.sessionModels.get(key) ?? {};
    rec[role] = target;
    this.sessionModels.set(key, rec);
    this.persistSessionMeta(key);
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
    this.persistSessionMeta(key);
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

}
