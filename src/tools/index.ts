import type OpenAI from "openai";
// @ts-ignore — grandma-kat ships no .d.ts files.
import { inspectMemoryTool } from "grandma-kat";
import { FileTools } from "./files.js";
import { ShellTools } from "./shell.js";
import { ExaSearchTools, EXA_SEARCH_DEFINITION } from "./websearch.js";
import { SqliteTools } from "./sqlite.js";
import { ownedDbApp, ownedDbError } from "./app-dbs.js";
import type { AppStore } from "../app-store.js";
import { OpencodeTools } from "./opencode.js";
import { CsvTools, CSV_QUERY_DEFINITION } from "./csv.js";
import { READ_JSON_DEFINITION, readJsonValue } from "./json.js";
import { GitTools, GIT_DEFINITIONS } from "./git-tools.js";
import { createNodePlatform } from "../platform/node.js";
import type { AppTool } from "../app-tools.js";
import { assembleGuides, HOST_GUIDES } from "../tool-guides.js";

type Json = Record<string, unknown>;

/**
 * Context the engine (grandma-kat's runCall) passes to a registry tool's
 * `execute`. `boundary` is true when the call is inside an app tree entered as
 * a tool — the engine's `insideToolBoundary`.
 */
export interface ToolCallContext {
  view?: unknown;
  context?: unknown;
  boundary?: boolean;
  /** The nearest enclosing named tree (the engine's `ctx.tree`). */
  tree?: string | null;
  /** Resolve a `ref://<name>.<seq>` handle against this run's log. */
  readRef?: (ref: string) => unknown;
  /** The slots visible from the call site, with their write seqs. */
  scopeInfo?: () => unknown;
}

function toOpenAiDefinition(tool: AppTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  };
}

// KAT's own memory inspector (grandma-kat/src/inspect.mjs). It is NOT an app
// tool: its execute needs the ENGINE's per-call context — `view`, `readRef`,
// `scopeInfo` — which the app-tool path replaces with the app's secrets
// context. So it is registered as a built-in definition and dispatched below
// with the engine ctx forwarded.
const INSPECT_MEMORY = inspectMemoryTool();
const INSPECT_MEMORY_DEFINITION: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: INSPECT_MEMORY.name,
    description: INSPECT_MEMORY.description,
    parameters: INSPECT_MEMORY.parameters,
  },
};

export class ToolRegistry {
  private files: FileTools;
  private shell: ShellTools;
  private exa: ExaSearchTools;
  private sqlite: SqliteTools;
  private opencode: OpencodeTools;
  private csv: CsvTools;
  private gitTools: GitTools;
  private appTools: Map<string, AppTool>;

  /**
   * @param workspace        Workspace root (sandbox for file + sql path args).
   * @param allowedCommands  run_command allowlist.
   * @param exaApiKey        Exa Search API key (optional — tool errors if unset).
   * @param sqliteLockedPath Optional absolute path to a single SQLite database
   *                         the sql_query tool is locked to. When set, the agent
   *                         can only query that file (the `path` arg is ignored).
   * @param appStore         The host's app-database store (see app-store.ts).
   *                         When given, sql_write reuses its cached writable
   *                         handle so SQL tools and app code share ONE
   *                         connection per file instead of racing two.
   */
  constructor(
    workspace: string,
    allowedCommands: string[],
    exaApiKey: string = "",
    sqliteLockedPath?: string,
    appTools: AppTool[] = [],
    appStore?: Pick<AppStore, "open">,
  ) {
    const platform = createNodePlatform(workspace, allowedCommands);
    this.files = new FileTools(platform);
    this.shell = new ShellTools(workspace, allowedCommands);
    this.exa = new ExaSearchTools(exaApiKey);
    this.sqlite = new SqliteTools(platform, sqliteLockedPath, appStore);
    this.opencode = new OpencodeTools();
    this.csv = new CsvTools(platform);
    this.gitTools = new GitTools(workspace);
    this.appTools = new Map(appTools.map((tool) => [tool.name, tool]));
    this.definitions.push(...appTools.map(toOpenAiDefinition));
    this.definitions.push(...GIT_DEFINITIONS);
    this.definitions.push(CSV_QUERY_DEFINITION);
    this.definitions.push(READ_JSON_DEFINITION);
    this.definitions.push(INSPECT_MEMORY_DEFINITION);
  }

  readonly definitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories in the workspace. Directories end with '/'.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative directory path, default '.'" },
            recursive: { type: "boolean", description: "Recurse into subdirectories (default true)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file's full contents (truncated if huge). Directories are listed instead.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative file path" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create or fully overwrite a file (creates parent dirs). The change is git-committed automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path" },
            content: { type: "string", description: "Full new file content" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Replace an exact string in a file. Fails if old_string is not found or occurs multiple times (unless replace_all). The change is git-committed automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string", description: "Exact text to replace (must match literally)" },
            new_string: { type: "string" },
            replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_file",
        description: "Delete a file (or empty directory). The change is git-committed automatically.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run an allowlisted command in the workspace (no shell, so no pipes/redirection). " +
          "git is allowed except destructive/remote subcommands. File changes are NOT auto-committed by this tool — prefer the file tools.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Base command name, e.g. 'git'" },
            args: { type: "array", items: { type: "string" }, description: "Arguments, e.g. ['status', '--short']" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "sql_query",
        description:
          "Run a READ-ONLY SQL query against a SQLite database and get structured rows (columns + rows + rowCount). " +
          "Only SELECT / WITH / EXPLAIN / PRAGMA are accepted; writes are refused. Omit 'path' when the tool is locked " +
          "to a specific database file. Use for inspecting structured data, notes tables, contact lists, or any .db " +
          "file in the workspace. For writes, use sql_write instead.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "A single read-only SQL statement" },
            path: { type: "string", description: "Relative .db file path in the workspace (ignored when locked to a specific database)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "sql_write",
        description:
          "Run a read-write SQL statement (INSERT / UPDATE / DELETE / CREATE TABLE / ...) against a SQLite database " +
          "and report how many rows changed. Use this ONLY when you actually need to modify data — for reading use " +
          "sql_query. Omit 'path' when the tool is locked to a specific database file.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "A single SQL statement to execute" },
            path: { type: "string", description: "Relative .db file path in the workspace (ignored when locked to a specific database)" },
          },
          required: ["query"],
        },
      },
    },
    EXA_SEARCH_DEFINITION,
    {
      type: "function",
      function: {
        name: "opencode",
        description:
          "Delegate a prompt to an opencode coding-agent session and return its output (workspace files, shell commands, code edits) as text. " +
          "Continue a specific session with 'session' (an opencode session id) or the latest session with 'continueLast'. " +
          "The returned text is everything opencode produced since the last time this session was queried.",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "The task/prompt to send to opencode" },
            session: { type: "string", description: "opencode session id to continue (mutually exclusive with continueLast)" },
            continueLast: { type: "boolean", description: "Continue the most recent opencode session" },
            model: { type: "string", description: "Model in 'provider/model' form (optional)" },
            agent: { type: "string", description: "opencode agent name to use (optional)" },
            dir: { type: "string", description: "Working directory for opencode (optional, defaults to workspace)" },
          },
          required: ["input"],
        },
      },
    },
  ];

  /** Execute a tool call; returns a string (errors included) or a plain
   *  JSON object (structured output) so the agent can recover and patterns
   *  can read structured data directly. */
  async dispatch(name: string, argsJson: string, ctx?: ToolCallContext): Promise<string | Json> {
    let args: Json;
    try {
      args = JSON.parse(argsJson || "{}") as Json;
    } catch {
      return `error: invalid JSON arguments for ${name}`;
    }
    try {
      // KAT's memory inspector needs the engine's ctx (view/readRef/scopeInfo),
      // so it bypasses the app-tool path (which passes the app's own context).
      if (name === "inspect_memory") {
        return INSPECT_MEMORY.execute(args, ctx) as string | Json;
      }
      const appTool = this.appTools.get(name);
      if (appTool) {
        const result = await appTool.execute(args, appTool.appContext);
        if (typeof result === "string") return result;
        if (result && typeof result === "object") return result as Json;
        return String(result ?? "");
      }
      switch (name) {
        case "list_files":
          return await this.files.listFiles(
            (args.path as string) ?? ".",
            (args.recursive as boolean) ?? true,
          );
        case "read_file":
          return await this.files.readFile(String(args.path ?? ""));
        case "write_file":
          return await this.files.writeFile(String(args.path ?? ""), String(args.content ?? ""));
        case "edit_file":
          return await this.files.editFile(
            String(args.path ?? ""),
            String(args.old_string ?? ""),
            String(args.new_string ?? ""),
            (args.replace_all as boolean) ?? false,
          );
        case "delete_file":
          return await this.files.deleteFile(String(args.path ?? ""));
        case "run_command":
          return await this.shell.runCommand(
            String(args.command ?? ""),
            Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [],
          );
        case "sql_query": {
          const owned = ctx?.boundary ? null : ownedDbApp(args.path);
          if (owned) return ownedDbError(owned);
          return await this.sqlite.query(
            String(args.query ?? ""),
            args.path !== undefined ? String(args.path) : undefined,
          );
        }
        case "sql_write": {
          const owned = ctx?.boundary ? null : ownedDbApp(args.path);
          if (owned) return ownedDbError(owned);
          return await this.sqlite.write(
            String(args.query ?? ""),
            args.path !== undefined ? String(args.path) : undefined,
          );
        }
        case "csv_query":
          return await this.csv.query(String(args.query ?? ""), String(args.path ?? ""));
        case "read_json": {
          // The `ref` source resolves through the engine's per-call ctx, like
          // inspect_memory — the handle belongs to THIS run's log.
          const result = await readJsonValue(args, {
            readFile: (rel) => this.files.readJsonText(rel),
            readRef: ctx?.readRef,
          });
          return { ...result };
        }
        case "exa_search":
          return await this.exa.search({
            query: String(args.query ?? ""),
            type: args.type !== undefined ? String(args.type) : undefined,
            numResults: args.numResults !== undefined ? Number(args.numResults) : undefined,
            category: args.category !== undefined ? String(args.category) : undefined,
            includeDomains: Array.isArray(args.includeDomains)
              ? (args.includeDomains as unknown[]).map(String)
              : undefined,
            startPublishedDate:
              args.startPublishedDate !== undefined ? String(args.startPublishedDate) : undefined,
            endPublishedDate: args.endPublishedDate !== undefined ? String(args.endPublishedDate) : undefined,
          });
        case "opencode": {
          const result = await this.opencode.run({
            input: String(args.input ?? ""),
            session: args.session !== undefined ? String(args.session) : undefined,
            continueLast: (args.continueLast as boolean) ?? false,
            model: args.model !== undefined ? String(args.model) : undefined,
            agent: args.agent !== undefined ? String(args.agent) : undefined,
            dir: args.dir !== undefined ? String(args.dir) : undefined,
          });
          if (!result.ok) return `error: ${result.error}`;
          return {
            ok: true,
            sessionId: result.sessionId,
            text: result.text,
          };
        }
        case "git_status":
          return { ...(await this.gitTools.status()) };
        case "git_log":
          return { ...(await this.gitTools.log(args.depth !== undefined ? Number(args.depth) : 5)) };
        case "git_commit":
          return { ...(await this.gitTools.commit(String(args.message ?? "agent commit"), args.paths)) };
        case "git_fetch":
          return await this.gitTools.fetch(args.remote !== undefined ? String(args.remote) : "");
        case "git_remote":
          if (!args.name) return { ...(await this.gitTools.remotes()) };
          return {
            ...(await this.gitTools.setRemote(
              String(args.name),
              args.url !== undefined ? String(args.url) : "",
              args.remove === true,
            )),
          };
        case "git_push":
          return await this.gitTools.push(
            args.remote !== undefined ? String(args.remote) : "",
            args.branch !== undefined ? String(args.branch) : "",
          );
        default:
          return `error: unknown tool ${name}`;
      }
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Prompt guidance for the tools in scope, assembled here (next to the tool
   * definitions) from host guides, app-tool guides, and tree guides supplied
   * by the caller. The result is injected as the trunk's `guide` memory slot.
   */
  toolGuide(opts: { treeGuides?: { name: string; guide: string }[]; inScope?: Iterable<string> } = {}): string {
    const treeGuides = new Map(
      (opts.treeGuides ?? []).filter((g) => g.guide && g.guide.trim()).map((g) => [g.name, g.guide]),
    );
    const names = new Set<string>(opts.inScope ?? []);
    for (const d of this.definitions) {
      if (d.type !== "function") continue;
      if (d.function.name) names.add(d.function.name);
    }
    for (const n of treeGuides.keys()) names.add(n);
    const appGuides = new Map<string, string>();
    for (const tool of this.appTools.values()) {
      if (tool.guide) appGuides.set(tool.name, tool.guide);
    }
    return assembleGuides({ hostGuides: HOST_GUIDES, appGuides, treeGuides, inScope: names });
  }

  /**
   * Build a grandma-kat tool registry from the OpenAI schemas above.
   * `execute(args)` calls `dispatch(name, JSON.stringify(args))` so error
   * handling is identical to the OpenAI tool-call path. Results may be a
   * string or a plain JSON object; "error"-shaped results (strings starting
   * with "error" or objects with an "error" key) are detected by the runner
   * and surface in m.raw.prev[0].toolResults with isError=true.
   */
  toKatTools(): Record<
    string,
    {
      description: string;
      parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
      execute: (args: Json) => Promise<string | Json>;
    }
  > {
    const out: Record<
      string,
      {
        description: string;
        parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
        execute: (args: Json) => Promise<string | Json>;
      }
    > = {};
    for (const d of this.definitions) {
      if (d.type !== "function") continue;
      const fn = d.function;
      const name = fn.name;
      out[name] = {
        description: fn.description ?? "",
        parameters: (fn.parameters ?? { type: "object" }) as {
          type: "object";
          properties?: Record<string, unknown>;
          required?: string[];
        },
        execute: async (args: Json, ctx?: ToolCallContext) => this.dispatch(name, JSON.stringify(args ?? {}), ctx),
      };
    }
    return out;
  }
}
