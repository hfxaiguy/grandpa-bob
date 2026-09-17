import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Make sure `dir` is a git repo with a usable (repo-local) committer identity. */
export async function ensureRepo(dir: string): Promise<void> {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    await git(dir, ["init"]);
  }
  try {
    // succeeds if an identity exists (global or local)
    await git(dir, ["config", "user.name"]);
    await git(dir, ["config", "user.email"]);
  } catch {
    await git(dir, ["config", "user.name", "grandpa-bob-bot"]);
    await git(dir, ["config", "user.email", "grandpa-bob-bot@localhost"]);
  }
}

/**
 * Append entries to `<dir>/.gitignore`, creating the file if absent.
 * Preserves any existing content. Idempotent: a line that's already there
 * is not duplicated. Used so the bot's own runtime artifacts (e.g. the
 * grandma-kat SQLite log under `logs/`) don't pollute the workspace's
 * `git status`.
 */
export async function ensureWorkspaceGitignore(dir: string, entries: string[]): Promise<void> {
  const gitignorePath = path.join(dir, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // file doesn't exist yet
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()).filter(Boolean));
  const toAdd = entries.filter((e) => !have.has(e));
  if (toAdd.length === 0) return;
  const next = existing.endsWith("\n") || existing === "" ? existing : existing + "\n";
  await fs.writeFile(gitignorePath, next + toAdd.join("\n") + "\n", "utf8");
}

/**
 * Stage and commit the given workspace-relative paths.
 * Returns the short commit hash, "no-changes", or "failed" (never throws —
 * a broken repo must not break file tools).
 */
export async function autoCommit(dir: string, relPaths: string[], message: string): Promise<string> {
  try {
    await git(dir, ["add", "-A", "--", ...relPaths]);
    const status = await git(dir, ["status", "--porcelain", "--", ...relPaths]);
    if (!status.trim()) return "no-changes";
    await git(dir, ["commit", "-q", "-m", message, "--", ...relPaths]);
    const hash = (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
    return hash;
  } catch (err) {
    console.error("[git] auto-commit failed:", err);
    return "failed";
  }
}
