/**
 * grandma-kat tools over the browser Platform, mirroring grandpa-bob's tool
 * names/behavior: file tools, sql tools, and the virtual coreutils shell.
 */
import { FileTools } from "../../../src/tools/files";
import { SqliteTools } from "../../../src/tools/sqlite";
import { ownedDbApp, ownedDbError } from "../../../src/tools/app-dbs";
import { CsvTools, CSV_QUERY_DEFINITION } from "../../../src/tools/csv";
import { READ_JSON_DEFINITION, readJsonValue } from "../../../src/tools/json";
import { runCommand } from "../../../src/platform/coreutils";
import { writeDatabaseDumps } from "../../../src/db-sync";
import { createSqliteWasm } from "../platform/sqlite-wasm";
import { runLogToolFromQuery } from "grandma-kat";
import type { Platform } from "../../../src/platform/types";
import type { AppStore } from "../../../src/app-store";

type Args = Record<string, unknown>;
/** The engine's per-call context, as far as a host tool needs it. */
export interface ToolCtx {
  /** True inside an app tree entered as a tool — the app owns its store. */
  boundary?: boolean;
  /** Resolve a `ref://<name>.<seq>` handle against this run's log. */
  readRef?: (ref: string) => unknown;
}
export interface KatTool {
  description: string;
  parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  execute: (args: Args, ctx?: ToolCtx) => Promise<unknown>;
}

export interface BrowserToolOptions {
  /** Git remote to fetch/push (from settings/`?remote=`). */
  remote?: string;
  /** Flush buffered run-log events before read_runs reads them. */
  flushLog?: () => Promise<void> | void;
  /**
   * The worker's app-database store. The SQL tools reuse its cached writable
   * handle so raw SQL and app code share one connection per file.
   */
  store?: Pick<AppStore, "open">;
}

export function browserTools(platform: Platform, opts: BrowserToolOptions = {}): Record<string, KatTool> {
  const files = new FileTools(platform);
  const sqlite = new SqliteTools(platform, undefined, opts.store);
  // CSV work always uses the tab's own wasm engine — also in desktop-bridge
  // mode, where platform.sqlite is the bridge's per-call handle and could not
  // hold the scratch table between statements.
  const csv = new CsvTools(platform, createSqliteWasm());
  const root = platform.workspaceRoot;

  // read_runs over the browser's own run log (OPFS-backed WASM SQLite).
  const runLog = runLogToolFromQuery(async (sql, params = []) => {
    const db = await platform.sqlite.open(platform.path.join(root, "logs/grandma-kat.db"), { readOnly: true });
    try {
      const stmt = await db.prepare(sql);
      return await stmt.all(...params);
    } finally {
      await db.close();
    }
  });

  return {
    list_files: {
      description: "List files and directories in the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      },
      execute: async (a) => ({ listing: await files.listFiles(String(a.path ?? "."), a.recursive !== false) }),
    },
    read_file: {
      description: "Read a file's full contents.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (a) => ({ content: await files.readFile(String(a.path ?? "")) }),
    },
    write_file: {
      description: "Create or overwrite a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      execute: async (a) => ({ result: await files.writeFile(String(a.path ?? ""), String(a.content ?? "")) }),
    },
    edit_file: {
      description: "Replace an exact string in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
      execute: async (a) =>
        ({
          result: await files.editFile(
            String(a.path ?? ""),
            String(a.old_string ?? ""),
            String(a.new_string ?? ""),
            a.replace_all === true,
          ),
        }),
    },
    delete_file: {
      description: "Delete a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (a) => ({ result: await files.deleteFile(String(a.path ?? "")) }),
    },
    sql_query: {
      description: "Run a read-only SQL query against a workspace .db file.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query"],
      },
      execute: async (a, ctx) => {
        // The top-level agent may not reach an app's store directly — it must
        // call the owning tree. Inside an app tree the app owns the store.
        const owned = ctx?.boundary ? null : ownedDbApp(a.path);
        if (owned) return ownedDbError(owned);
        return sqlite.query(String(a.query ?? ""), a.path === undefined ? undefined : String(a.path));
      },
    },
    sql_write: {
      description: "Run a read-write SQL statement against a workspace .db file.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query"],
      },
      execute: async (a, ctx) => {
        const owned = ctx?.boundary ? null : ownedDbApp(a.path);
        if (owned) return ownedDbError(owned);
        return sqlite.write(String(a.query ?? ""), a.path === undefined ? undefined : String(a.path));
      },
    },
    read_runs: {
      description: runLog.description,
      parameters: runLog.parameters,
      execute: async (a) => {
        await opts.flushLog?.();
        return runLog.execute(a);
      },
    },
    csv_query: {
      description: CSV_QUERY_DEFINITION.function.description ?? "",
      parameters: (CSV_QUERY_DEFINITION.function.parameters ?? {
        type: "object",
        properties: {},
      }) as { type: "object"; properties?: Record<string, unknown>; required?: string[] },
      execute: async (a) => csv.query(String(a.query ?? ""), String(a.path ?? "")),
    },
    read_json: {
      description: READ_JSON_DEFINITION.function.description,
      parameters: READ_JSON_DEFINITION.function.parameters as {
        type: "object";
        properties?: Record<string, unknown>;
        required?: string[];
      },
      // The browser registry hands the engine's ctx straight to execute, so a
      // ref resolves against this run's log exactly as on the Node target.
      execute: async (a, ctx) =>
        readJsonValue(a, {
          readFile: (rel) => files.readJsonText(rel),
          readRef: ctx?.readRef,
        }),
    },
    run_command: {
      description: "Run an allowlisted command over the virtual workspace filesystem.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
        required: ["command"],
      },
      execute: async (a) =>
        ({
          output: await runCommand(
            { fs: platform.fs, path: platform.path, workspaceRoot: root },
            String(a.command ?? ""),
            Array.isArray(a.args) ? (a.args as unknown[]).map(String) : [],
          ),
        }),
    },
    git_status: {
      description: "Show the workspace git branch and changed files.",
      parameters: { type: "object", properties: {} },
      execute: async () => (platform.git.status ? platform.git.status() : { error: "git status unavailable" }),
    },
    git_log: {
      description: "Show recent workspace git commits.",
      parameters: { type: "object", properties: { depth: { type: "integer" } } },
      execute: async (a) => ({
        commits: platform.git.log ? await platform.git.log(a.depth ? Number(a.depth) : 5) : [],
      }),
    },
    git_commit: {
      description: "Commit workspace files (paths) with a message.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
        required: ["message"],
      },
      execute: async (a) => {
        const paths = Array.isArray(a.paths) && a.paths.length ? (a.paths as unknown[]).map(String) : null;
        const message = String(a.message ?? "agent commit");
        if (!paths) {
          await writeDatabaseDumps(platform).catch(() => {});
          if (platform.git.commitAll) return { commit: await platform.git.commitAll(message) };
        }
        return { commit: await platform.git.autoCommit(paths ?? ["."], message) };
      },
    },
    git_fetch: {
      description: "Fetch updates from the configured git remote.",
      parameters: { type: "object", properties: {} },
      execute: async () =>
        platform.git.fetch ? platform.git.fetch(opts.remote ?? "") : { error: "git fetch unavailable" },
    },
    git_push: {
      description: "Commit database dumps, then push the workspace branch to the remote (default 'main').",
      parameters: { type: "object", properties: { branch: { type: "string" } } },
      execute: async (a) => {
        if (!platform.git.push) return { error: "git push unavailable" };
        await writeDatabaseDumps(platform).catch(() => {});
        await platform.git.commitAll?.("sync: database dumps").catch(() => {});
        return platform.git.push(opts.remote ?? "", String(a.branch ?? "main"));
      },
    },
    ...Object.fromEntries(STUB_TOOL_NAMES.map((n) => [n, notAvailable(n)])),
  };
}

/** A stand-in for tools the Node/desktop target has but the browser does not. */
function notAvailable(name: string): KatTool {
  return {
    description: `${name} is not available in the browser target.`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ error: `${name} is not available in the browser target` }),
  };
}

/** Names the workspace trunk declares but this target does not implement. */
export const STUB_TOOL_NAMES = [
  "exa_search",
  "upsert_contact",
  "log_message",
  "get_contact",
  "make_phone_call",
  "caller-list",
  "git_remote",
];
