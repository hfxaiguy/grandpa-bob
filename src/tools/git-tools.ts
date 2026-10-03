// src/tools/git-tools.ts
//
// The Node target's git tools. The browser target defines git_status / git_log
// / git_commit / git_fetch / git_push over its virtual FS (web/src/agent/
// browser-tools.ts); the shared workspace trunk declares those names, so the
// Node registry must provide the same surface with the real git CLI.

import type OpenAI from "openai";
import { autoCommit, ensureRepo, git } from "./git.js";

export interface GitStatus {
  branch: string;
  changes: string[];
  count: number;
}

export class GitTools {
  constructor(private workspace: string) {}

  /** Branch + changed files (porcelain). */
  async status(): Promise<GitStatus> {
    await ensureRepo(this.workspace);
    const branch = (await git(this.workspace, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const porcelain = await git(this.workspace, ["status", "--porcelain"]);
    const changes = porcelain.split("\n").map((line) => line.trim()).filter(Boolean);
    return { branch, changes, count: changes.length };
  }

  /** Recent commits, newest first. */
  async log(depth = 5): Promise<{ commits: { hash: string; author: string; date: string; subject: string }[] }> {
    const n = Math.max(1, Math.min(100, Number(depth) || 5));
    try {
      const out = await git(this.workspace, [
        "log", `-n${n}`, "--pretty=format:%h\t%an\t%ad\t%s", "--date=short",
      ]);
      const commits = out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash = "", author = "", date = "", subject = ""] = line.split("\t");
          return { hash, author, date, subject };
        });
      return { commits };
    } catch {
      return { commits: [] };
    }
  }

  /** Stage + commit workspace-relative paths (default all). */
  async commit(message: string, paths?: unknown): Promise<{ commit: string }> {
    await ensureRepo(this.workspace);
    const relPaths = Array.isArray(paths) && paths.length ? (paths as unknown[]).map(String) : ["."];
    const result = await autoCommit(this.workspace, relPaths, String(message || "agent commit"));
    return { commit: result };
  }

  async fetch(remote = ""): Promise<Record<string, unknown>> {
    try {
      const output = await git(this.workspace, remote ? ["fetch", remote] : ["fetch", "--all"]);
      return { ok: true, output: output.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async push(remote = "", branch = "main"): Promise<Record<string, unknown>> {
    try {
      const output = await git(this.workspace, ["push", remote || "origin", branch || "main"]);
      return { ok: true, output: output.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** OpenAI tool schemas for the git tools. */
export const GIT_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show the workspace git branch and changed files.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent workspace git commits.",
      parameters: { type: "object", properties: { depth: { type: "integer", description: "How many commits (default 5)" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Commit workspace files (paths) with a message.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message" },
          paths: { type: "array", items: { type: "string" }, description: "Workspace-relative paths (default all)" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_fetch",
      description: "Fetch updates from the configured git remote.",
      parameters: { type: "object", properties: { remote: { type: "string", description: "Remote (default all)" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_push",
      description: "Push the workspace branch to the remote (default origin/main). Commit is not implied.",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Branch to push (default main)" },
          remote: { type: "string", description: "Remote (default origin)" },
        },
      },
    },
  },
];
