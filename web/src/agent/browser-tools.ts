/**
 * grandma-kat tools over the browser Platform, mirroring grandpa-bob's tool
 * names/behavior: file tools, sql tools, and the virtual coreutils shell.
 */
import { FileTools } from "../../../src/tools/files";
import { SqliteTools } from "../../../src/tools/sqlite";
import { ownedDbApp, ownedDbError } from "../../../src/tools/app-dbs";
import { CsvTools, CSV_QUERY_DEFINITION } from "../../../src/tools/csv";
import { ExaSearchTools, EXA_SEARCH_DEFINITION } from "../../../src/tools/websearch";
import { READ_JSON_DEFINITION, readJsonValue } from "../../../src/tools/json";
import { runCommand } from "../../../src/platform/coreutils";
import { writeDatabaseDumps } from "../../../src/db-sync";
import { createSqliteWasm } from "../platform/sqlite-wasm";
import { withLogDb } from "./log-store";
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
  /**
   * Exa Search API key (`EXO_API_KEY`). Missing key is fine: the tool is still
   * offered and answers with the same "not configured" error as the Node
   * target, so the two registries stay identical.
   */
  exaApiKey?: string;
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
  // Pure fetch + AbortController (no Node builtins) — the same class the Node
  // target uses. api.exa.ai answers CORS preflights for POST + authorization,
  // so the browser calls it directly.
  const exa = new ExaSearchTools(opts.exaApiKey ?? "");
  const root = platform.workspaceRoot;

  // read_runs over the browser's own run log. Query through log-store's
  // cached, serial-queued handle instead of opening a fresh connection per
  // call: the log streams through the opfs-sahpool VFS, which keeps one pooled
  // connection per file, and the whole-file fallback would load the entire log
  // into wasm memory on every open. The queue also lets the buffered event
  // flushes land before the read.
  const runLog = runLogToolFromQuery(async (sql, params = []) => {
    return withLogDb(platform, async (db) => {
      const stmt = await db.prepare(sql);
      return await stmt.all(...params);
    });
  });

  return {
    list_files: {
      description: "List files and directories in the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      },
      // Text results are returned bare (the raw string), matching the Node
      // target's dispatch (src/tools/index.ts). A `{ content }` wrapper ends up
      // double-encoded in the model transcript and in ref:// payloads, forcing
      // every caller to hand over `ref://…/content` instead of the value.
      execute: async (a) => await files.listFiles(String(a.path ?? "."), a.recursive !== false),
    },
    read_file: {
      description: "Read a file's full contents.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (a) => await files.readFile(String(a.path ?? "")),
    },
    write_file: {
      description: "Create or overwrite a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      execute: async (a) => await files.writeFile(String(a.path ?? ""), String(a.content ?? "")),
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
        await files.editFile(
          String(a.path ?? ""),
          String(a.old_string ?? ""),
          String(a.new_string ?? ""),
          a.replace_all === true,
        ),
    },
    delete_file: {
      description: "Delete a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (a) => await files.deleteFile(String(a.path ?? "")),
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
    exa_search: {
      description: EXA_SEARCH_DEFINITION.function.description,
      parameters: EXA_SEARCH_DEFINITION.function.parameters as {
        type: "object";
        properties?: Record<string, unknown>;
        required?: string[];
      },
      execute: async (a) =>
        exa.search({
          query: String(a.query ?? ""),
          type: a.type !== undefined ? String(a.type) : undefined,
          numResults: a.numResults !== undefined ? Number(a.numResults) : undefined,
          category: a.category !== undefined ? String(a.category) : undefined,
          includeDomains: Array.isArray(a.includeDomains)
            ? (a.includeDomains as unknown[]).map(String)
            : undefined,
          startPublishedDate:
            a.startPublishedDate !== undefined ? String(a.startPublishedDate) : undefined,
          endPublishedDate:
            a.endPublishedDate !== undefined ? String(a.endPublishedDate) : undefined,
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
        await runCommand(
          { fs: platform.fs, path: platform.path, workspaceRoot: root },
          String(a.command ?? ""),
          Array.isArray(a.args) ? (a.args as unknown[]).map(String) : [],
        ),
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
  "upsert_contact",
  "log_message",
  "get_contact",
  "make_phone_call",
  "caller-list",
  "git_remote",
];
