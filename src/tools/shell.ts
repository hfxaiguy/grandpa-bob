import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 50_000;
const TIMEOUT_MS = 30_000;

/** git subcommands the agent may not run (destructive / remote-affecting). */
const GIT_DENY = new Set([
  "push", "reset", "clean", "rebase", "remote", "config",
  "checkout", "switch", "restore", "update-index", "filter-branch", "gc",
]);

/** Tokens that name a filesystem location rather than a plain word/flag. */
function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value === ".." || value.includes("/");
}

/**
 * Reject path-like arguments that resolve outside the workspace. Commands
 * run with cwd=workspace, but execFile never sandboxes ARGUMENTS — without
 * this, `cat ~/.grandpa-bob/.env` or `cat /etc/passwd` reads whatever the
 * allowlisted binary can reach. Conservative by design: a string starting
 * with "/" is treated as a path even if the command would read it as a
 * pattern. Symlink escapes are out of reach here because none of the
 * allowlisted commands can create symlinks.
 */
function assertInsideWorkspace(workspace: string, args: string[]): void {
  for (const arg of args) {
    const eq = arg.indexOf("=");
    const value = eq >= 0 ? arg.slice(eq + 1) : arg;
    if (!looksLikePath(value)) continue;
    const expanded = value.startsWith("~")
      ? path.join(os.homedir(), value.replace(/^~[/\\]?/, ""))
      : value;
    const resolved = path.resolve(workspace, expanded);
    const rel = path.relative(workspace, resolved);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw new Error(
        `argument escapes the workspace: ${arg} (resolves to ${resolved}). ` +
          `Only paths inside the workspace are allowed.`,
      );
    }
  }
}

/**
 * Resolve `node_modules/.bin` relative to the project root (two levels
 * up from this file: src/tools/shell.ts → project root).  Prepended to
 * PATH so any npm-installed binary is available by name.
 */
function npmBinPath(): string {
  // fileURLToPath(import.meta.url) isn't available in CJS; walk up from cwd.
  return path.resolve(process.cwd(), "node_modules", ".bin");
}

export class ShellTools {
  private env: NodeJS.ProcessEnv;

  constructor(
    private workspace: string,
    private allowedCommands: string[],
  ) {
    const bin = npmBinPath();
    this.env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  }

  async runCommand(command: string, args: string[] = []): Promise<string> {
    const base = path.basename(command);
    if (base !== command || !this.allowedCommands.includes(base)) {
      throw new Error(
        `command not allowed: ${command}. Allowlist: ${this.allowedCommands.join(", ")} ` +
          `(extend via ALLOWED_COMMANDS in .env)`,
      );
    }
    if (base === "git" && args.length > 0 && GIT_DENY.has(args[0])) {
      throw new Error(`git subcommand not allowed: ${args[0]} (denied: ${[...GIT_DENY].join(", ")})`);
    }
    assertInsideWorkspace(this.workspace, args);
    try {
      const { stdout, stderr } = await execFileAsync(base, args, {
        cwd: this.workspace,
        env: this.env,
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      return this.format(base, args, stdout, stderr, 0);
    } catch (err: unknown) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      if (e.killed) throw new Error(`command timed out after ${TIMEOUT_MS / 1000}s: ${base}`);
      return this.format(base, args, e.stdout ?? "", e.stderr ?? "", e.code ?? "?");
    }
  }

  private format(base: string, args: string[], stdout: string, stderr: string, code: number | string): string {
    let out = `$ ${base} ${args.join(" ")} (exit ${code})\n`;
    if (stdout) out += stdout;
    if (stderr) out += (stdout ? "\n" : "") + `[stderr]\n${stderr}`;
    if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + "\n… (truncated)";
    return out.trim() || "(no output)";
  }
}
