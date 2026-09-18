import type OpenAI from "openai";
import { FileTools } from "./files.js";
import { ShellTools } from "./shell.js";
import { ExaSearchTools } from "./websearch.js";
import { SqliteTools } from "./sqlite.js";
import { OpencodeTools } from "./opencode.js";
import { DuckdbTools } from "./duckdb.js";

type Json = Record<string, unknown>;

export class ToolRegistry {
  private files: FileTools;
  private shell: ShellTools;
  private exa: ExaSearchTools;
  private sqlite: SqliteTools;
  private opencode: OpencodeTools;
  private duckdb: DuckdbTools;

  /**
   * @param workspace        Workspace root (sandbox for file + sql path args).
   * @param allowedCommands  run_command allowlist.
   * @param exaApiKey        Exa Search API key (optional — tool errors if unset).
   * @param sqliteLockedPath Optional absolute path to a single SQLite database
   *                         the sql_query tool is locked to. When set, the agent
   *                         can only query that file (the `path` arg is ignored).
   */
  constructor(
    workspace: string,
    allowedCommands: string[],
    exaApiKey: string = "",
    sqliteLockedPath?: string,
  ) {
    this.files = new FileTools(workspace);
    this.shell = new ShellTools(workspace, allowedCommands);
    this.exa = new ExaSearchTools(exaApiKey);
    this.sqlite = new SqliteTools({ workspace, lockedPath: sqliteLockedPath });
    this.opencode = new OpencodeTools();
    this.duckdb = new DuckdbTools(workspace);
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
    {
      type: "function",
      function: {
        name: "exa_search",
        description:
          "Search the web via the Exa Search API. Returns structured data: a JSON object with " +
          "'query', 'count', and 'results', where each result has title, url, publishedDate, " +
          "highlights (query-relevant excerpts) and text (page content up to 8000 chars). " +
          "Use for current events, facts, research, or anything requiring up-to-date web information.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query" },
            type: {
              type: "string",
              enum: ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"],
              description: "Search method (default 'auto'). 'fast'/'instant' for speed, 'deep' variants for multi-step research.",
            },
            numResults: { type: "integer", description: "Number of results (1-100, default 5)" },
            category: {
              type: "string",
              enum: ["company", "people", "publication", "news", "personal site", "financial report"],
              description: "Focus on a specific content type (default: any)",
            },
            includeDomains: {
              type: "array",
              items: { type: "string" },
              description: "Only return results from these domains (e.g. ['reuters.com'])",
            },
            startPublishedDate: { type: "string", description: "ISO 8601 date — only results published after this date" },
            endPublishedDate: { type: "string", description: "ISO 8601 date — only results published before this date" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "duckdb_query",
        description:
          "Run a read-only DuckDB SQL query against a CSV or TSV file in the workspace. " +
          "The file is exposed as the relation `csv`; use DESCRIBE SELECT * FROM csv to inspect columns. " +
          "Results include columns, rows, rowCount, and truncated. Only one SELECT/WITH/DESCRIBE/EXPLAIN/PRAGMA statement is allowed.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Read-only SQL using the `csv` relation" },
            path: { type: "string", description: "Relative .csv or .tsv path in the workspace" },
          },
          required: ["query", "path"],
        },
      },
    },
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
  async dispatch(name: string, argsJson: string): Promise<string | Json> {
    let args: Json;
    try {
      args = JSON.parse(argsJson || "{}") as Json;
    } catch {
      return `error: invalid JSON arguments for ${name}`;
    }
    try {
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
        case "sql_query":
          return this.sqlite.query(
            String(args.query ?? ""),
            args.path !== undefined ? String(args.path) : undefined,
          );
        case "sql_write":
          return this.sqlite.write(
            String(args.query ?? ""),
            args.path !== undefined ? String(args.path) : undefined,
          );
        case "duckdb_query":
          return await this.duckdb.query(String(args.query ?? ""), String(args.path ?? ""));
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
        default:
          return `error: unknown tool ${name}`;
      }
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
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
        execute: async (args: Json) => this.dispatch(name, JSON.stringify(args ?? {})),
      };
    }
    return out;
  }
}
