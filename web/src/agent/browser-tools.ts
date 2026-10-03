/**
 * grandma-kat tools over the browser Platform, mirroring grandpa-bob's tool
 * names/behavior: file tools, sql tools, and the virtual coreutils shell.
 */
import { FileTools } from "../../../src/tools/files";
import { SqliteTools } from "../../../src/tools/sqlite";
import { runCommand } from "../../../src/platform/coreutils";
import type { Platform } from "../../../src/platform/types";

type Args = Record<string, unknown>;
export interface KatTool {
  description: string;
  parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  execute: (args: Args) => Promise<unknown>;
}

export interface BrowserToolOptions {
  /** Git remote to fetch/push (from settings/`?remote=`). */
  remote?: string;
}

export function browserTools(platform: Platform, opts: BrowserToolOptions = {}): Record<string, KatTool> {
  const files = new FileTools(platform);
  const sqlite = new SqliteTools(platform);
  const root = platform.workspaceRoot;

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
      execute: async (a) =>
        sqlite.query(String(a.query ?? ""), a.path === undefined ? undefined : String(a.path)),
    },
    sql_write: {
      description: "Run a read-write SQL statement against a workspace .db file.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query"],
      },
      execute: async (a) =>
        sqlite.write(String(a.query ?? ""), a.path === undefined ? undefined : String(a.path)),
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
        const paths = Array.isArray(a.paths) && a.paths.length ? (a.paths as unknown[]).map(String) : ["."];
        return { commit: await platform.git.autoCommit(paths, String(a.message ?? "agent commit")) };
      },
    },
    git_fetch: {
      description: "Fetch updates from the configured git remote.",
      parameters: { type: "object", properties: {} },
      execute: async () =>
        platform.git.fetch ? platform.git.fetch(opts.remote ?? "") : { error: "git fetch unavailable" },
    },
    git_push: {
      description: "Commit is not implied: push the workspace branch to the remote (default branch 'main').",
      parameters: { type: "object", properties: { branch: { type: "string" } } },
      execute: async (a) =>
        platform.git.push
          ? platform.git.push(opts.remote ?? "", String(a.branch ?? "main"))
          : { error: "git push unavailable" },
    },
  };
}
