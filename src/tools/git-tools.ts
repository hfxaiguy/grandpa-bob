// src/tools/git-tools.ts
//
// The Node target's git tools. The browser target defines git_status / git_log
// / git_commit / git_fetch / git_push over its virtual FS (web/src/agent/
// browser-tools.ts); the shared workspace trunk declares those names, so the
// Node registry must provide the same surface with the real git CLI.

import type OpenAI from "openai";
import { autoCommit, ensureRepo, git } from "./git.js";
import { createNodePlatform } from "../platform/node.js";
import { writeDatabaseDumps } from "../db-sync.js";

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
    const relPaths = Array.isArray(paths) && paths.length ? (paths as unknown[]).map(String) : null;
    // Committing the whole workspace also refreshes the app-DB text dumps.
    if (!relPaths) await writeDatabaseDumps(createNodePlatform(this.workspace)).catch(() => {});
    const result = await autoCommit(this.workspace, relPaths ?? ["."], String(message || "agent commit"));
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

  /** List remotes plus the current branch and its upstream. */
  async remotes(): Promise<{
    branch: string;
    upstream: string | null;
    remotes: { name: string; fetch?: string; push?: string }[];
  }> {
    await ensureRepo(this.workspace);
    const out = await git(this.workspace, ["remote", "-v"]);
    const map = new Map<string, { name: string; fetch?: string; push?: string }>();
    for (const line of out.split("\n").filter(Boolean)) {
      const [name = "", url = "", kind = ""] = line.split(/\s+/);
      const row = map.get(name) ?? { name };
      if (kind === "(fetch)") row.fetch = url;
      else if (kind === "(push)") row.push = url;
      map.set(name, row);
    }
    const branch = (await git(this.workspace, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    let upstream: string | null = null;
    try {
      upstream = (await git(this.workspace, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim();
    } catch {
      upstream = null;
    }
    return { branch, upstream, remotes: [...map.values()] };
  }

  /** Add, update, or remove a remote. Never guesses a URL. */
  async setRemote(name: string, url = "", remove = false): Promise<Record<string, unknown>> {
    await ensureRepo(this.workspace);
    if (!name) throw new Error("a remote name is required");
    const list = (await git(this.workspace, ["remote"])).split("\n").map((l) => l.trim()).filter(Boolean);
    if (remove) {
      if (!list.includes(name)) throw new Error(`no remote named '${name}'`);
      await git(this.workspace, ["remote", "remove", name]);
      return { removed: name };
    }
    if (!url) throw new Error("a remote URL is required — ask the user for it; never guess one");
    if (list.includes(name)) await git(this.workspace, ["remote", "set-url", name, url]);
    else await git(this.workspace, ["remote", "add", name, url]);
    return { name, url };
  }

  private async defaultRemote(): Promise<string> {
    const list = (await git(this.workspace, ["remote"])).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!list.length) {
      throw new Error(
        "no git remote is configured — call git_remote to list them, then add one with git_remote { name, url } (ask the user for the URL)",
      );
    }
    return list.includes("origin") ? "origin" : list[0];
  }

  /** Push the current branch (unless one is given) to a remote (default: origin/first). */
  async push(remote = "", branch = ""): Promise<Record<string, unknown>> {
    try {
      // A sync pushes the latest dumps, so commit them first.
      await this.commit("sync: database dumps");
      const br = branch || (await git(this.workspace, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const rem = remote || (await this.defaultRemote());
      const output = await git(this.workspace, ["push", rem, br]);
      return { ok: true, remote: rem, branch: br, output: output.trim() };
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
      name: "git_remote",
      description:
        "List the configured git remotes and the current branch/upstream, or add/update a remote (name + url) or remove one (name + remove:true). Never guess a URL — ask the user.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Remote name, e.g. origin (omit to just list)" },
          url: { type: "string", description: "Remote URL (with name, to add or update)" },
          remove: { type: "boolean", description: "With name, remove that remote" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_push",
      description: "Push the current branch (or the given branch) to a remote (default: origin, else the first remote). Commit is not implied.",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Branch to push (default: the current branch)" },
          remote: { type: "string", description: "Remote (default: origin, else the first remote)" },
        },
      },
    },
  },
];
