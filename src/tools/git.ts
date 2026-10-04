import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
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

/** Stage every change (including deletions) and commit. */
export async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  const status = await git(dir, ["status", "--porcelain"]);
  if (!status.trim()) return "no-changes";
  await git(dir, ["commit", "-q", "-m", message]);
  return (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
}

export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/** The remote to sync with: origin, else sync, else the first configured. */
export async function defaultRemoteName(dir: string): Promise<string | null> {
  try {
    const names = (await git(dir, ["remote"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return null;
    return names.includes("origin") ? "origin" : names.includes("sync") ? "sync" : names[0];
  } catch {
    return null;
  }
}

export async function fetchFrom(dir: string, remote: string, branch?: string): Promise<string> {
  return git(dir, branch ? ["fetch", remote, branch] : ["fetch", remote]);
}

export async function pushTo(dir: string, remote: string, local: string, remoteBranch?: string): Promise<string> {
  return git(dir, ["push", remote, `${local}:${remoteBranch ?? local}`]);
}

export async function pullFrom(dir: string, remote: string, branch: string): Promise<string> {
  return git(dir, ["pull", "--no-edit", remote, branch]);
}

/** The advisory cross-device lock ref (see src/db-sync.ts). */
export const SYNC_LOCK_REF = "refs/bob/sync-lock";

/** A fresh, unique orphan commit to use as a lock value. */
function makeLockCommit(dir: string, owner: string): string {
  const tree = execFileSync("git", ["mktree"], { cwd: dir, input: "" }).toString().trim();
  const message = `bob-sync-lock ${owner} ${Date.now()}`;
  return execFileSync("git", ["commit-tree", tree, "-m", message], { cwd: dir }).toString().trim();
}

/**
 * Take the sync lock by pushing a unique commit to `refs/bob/sync-lock`.
 * Creating the ref (absent) succeeds; updating an existing ref with an
 * unrelated commit is a non-fast-forward and is rejected — so this is an
 * atomic create-if-absent. A lock older than `ttlMs` is broken and retried.
 * An unreachable remote throws (so callers fail fast instead of retrying).
 */
export async function lockRef(dir: string, remote: string, owner: string, ttlMs: number): Promise<boolean> {
  const commit = makeLockCommit(dir, owner);

  const attempt = async (): Promise<"ok" | "held" | "unreachable"> => {
    try {
      await git(dir, ["push", remote, `${commit}:${SYNC_LOCK_REF}`]);
      return "ok";
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const text = `${e.stderr ?? ""} ${e.stdout ?? ""} ${e.message ?? ""}`;
      return /non-fast-forward|\[rejected\]|failed to push|fetch first|remote contains work|stale info|already exists/i.test(text)
        ? "held"
        : "unreachable";
    }
  };

  const first = await attempt();
  if (first === "ok") return true;
  if (first === "unreachable") throw new Error(`cannot reach git remote '${remote}'`);

  // The ref exists. Break it if it is stale, otherwise it is genuinely held.
  let ls: string;
  try {
    ls = (await git(dir, ["ls-remote", remote, SYNC_LOCK_REF])).trim();
  } catch {
    throw new Error(`cannot reach git remote '${remote}'`);
  }
  const sha = ls.split(/\s+/)[0];
  if (!sha) return (await attempt()) === "ok";
  await git(dir, ["fetch", "--no-tags", remote, sha]);
  const ts = Number((await git(dir, ["show", "-s", "--format=%ct", sha])).trim()) * 1000;
  if (Number.isFinite(ts) && Date.now() - ts > ttlMs) {
    await git(dir, ["push", remote, `:${SYNC_LOCK_REF}`]).catch(() => {});
    return (await attempt()) === "ok";
  }
  return false;
}

export async function unlockRef(dir: string, remote: string, _owner: string): Promise<void> {
  await git(dir, ["push", remote, `:${SYNC_LOCK_REF}`]).catch(() => {});
}

