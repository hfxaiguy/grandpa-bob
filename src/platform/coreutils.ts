/**
 * Virtual coreutils — a browser `Shell` implemented over the virtual FS.
 *
 * The Node target runs allowlisted binaries via `execFile` (`ShellTools`). The
 * browser has no processes, so this adapter implements the allowlisted commands
 * in JavaScript against the injected `FileSystem`. It keeps the same sandbox
 * rule: path-like arguments must resolve inside the workspace.
 *
 * Commands with no meaningful browser equivalent (git, comms, df) return an
 * error; `rg` is a short alias of `grep`.
 */
import type { FileSystem, PathOps, Shell } from "./types.js";
import { resolveInWorkspace } from "../util/paths.js";

export interface CoreutilsDeps {
  fs: FileSystem;
  path: PathOps;
  workspaceRoot: string;
}

const SUPPORTED = [
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "pwd",
  "mkdir", "touch", "date", "file", "stat", "du", "diff", "which",
  "echo", "sort", "uniq",
];

const MAX_LINES = 10_000;

/** A `Shell` backed by the virtual coreutils over the given filesystem. */
export function createCoreutilsShell(deps: CoreutilsDeps): Shell {
  return {
    runCommand: (command, args) => runCommand(deps, command, args),
  };
}

export async function runCommand(
  deps: CoreutilsDeps,
  command: string,
  args: string[],
): Promise<string> {
  const { fs, path, workspaceRoot: root } = deps;
  const resolve = (p: string): string => resolveInWorkspace(root, p);
  const read = (p: string): Promise<string> => fs.readFile(resolve(p), "utf8");
  const flags = args.filter((a) => a.startsWith("-"));
  const operands = args.filter((a) => !a.startsWith("-"));

  switch (command) {
    case "pwd":
      return root;

    case "echo":
      return args.join(" ");

    case "date":
      return new Date().toISOString();

    case "which": {
      const known = SUPPORTED.includes(operands[0]);
      if (!known) throw new Error(`unknown command: ${operands[0] ?? ""}`);
      return operands[0];
    }

    case "ls": {
      const target = operands[0] ?? ".";
      const abs = resolve(target);
      const st = await fs.stat(abs).catch(() => null);
      if (!st) throw new Error(`ls: ${target}: no such file or directory`);
      if (st.isFile()) return path.basename(abs);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .join("\n");
    }

    case "cat": {
      if (!operands.length) throw new Error("cat: missing file operand");
      const parts: string[] = [];
      for (const file of operands) parts.push(await read(file));
      return parts.join("");
    }

    case "head":
    case "tail": {
      const rest = [...args];
      let n = 10;
      const ni = rest.indexOf("-n");
      if (ni >= 0) {
        const parsed = Number(rest[ni + 1]);
        if (Number.isFinite(parsed) && parsed > 0) n = parsed;
        rest.splice(ni, 2);
      }
      const file = rest.find((a) => !a.startsWith("-"));
      if (!file) throw new Error(`${command}: missing file operand`);
      const lines = (await read(file)).split("\n");
      const slice = command === "head" ? lines.slice(0, n) : lines.slice(-n);
      return slice.join("\n");
    }

    case "wc": {
      if (!operands.length) throw new Error("wc: missing file operand");
      const justLines = flags.includes("-l");
      const justWords = flags.includes("-w");
      const justChars = flags.includes("-c");
      const useDefault = !justLines && !justWords && !justChars;
      const out: string[] = [];
      for (const file of operands) {
        const text = await read(file);
        const counts = {
          lines: text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0,
          words: text.split(/\s+/).filter(Boolean).length,
          chars: text.length,
        };
        if (justLines) out.push(`${counts.lines} ${file}`);
        else if (justWords) out.push(`${counts.words} ${file}`);
        else if (justChars) out.push(`${counts.chars} ${file}`);
        else if (useDefault) out.push(`${counts.lines} ${counts.words} ${counts.chars} ${file}`);
      }
      return out.join("\n");
    }

    case "grep":
    case "rg": {
      const pattern = operands.shift();
      if (pattern === undefined) throw new Error("grep: missing pattern");
      const files = operands.length ? operands : ["."];
      const caseInsensitive = flags.includes("-i");
      const showNumbers = flags.includes("-n");
      const re = new RegExp(pattern, caseInsensitive ? "i" : "");
      const results: string[] = [];
      for (const file of files) {
        const abs = resolve(file);
        const st = await fs.stat(abs).catch(() => null);
        if (!st) {
          results.push(`grep: ${file}: no such file or directory`);
          continue;
        }
        const targets = st.isDirectory() ? await walk(fs, path, abs) : [abs];
        for (const target of targets) {
          const lines = (await fs.readFile(target, "utf8")).split("\n");
          const label = targets.length > 1 || st.isDirectory() ? `${path.relative(root, target)}:` : "";
          lines.forEach((line, i) => {
            if (re.test(line)) results.push(`${label}${showNumbers ? `${i + 1}:` : ""}${line}`);
          });
        }
      }
      return results.join("\n");
    }

    case "find": {
      const start = operands[0] && operands[0] !== "-name" ? operands[0] : ".";
      const nameIdx = args.indexOf("-name");
      const pattern = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
      const re = pattern ? globToRegExp(pattern) : null;
      const abs = resolve(start);
      const st = await fs.stat(abs).catch(() => null);
      if (!st) throw new Error(`find: ${start}: no such file or directory`);
      const all = await walk(fs, path, abs, { includeDirs: true });
      return all
        .filter((p) => !re || re.test(path.basename(p)))
        .map((p) => path.relative(root, p))
        .join("\n");
    }

    case "mkdir": {
      if (!operands.length) throw new Error("mkdir: missing operand");
      for (const dir of operands) await fs.mkdir(resolve(dir), { recursive: true });
      return "";
    }

    case "touch": {
      if (!operands.length) throw new Error("touch: missing file operand");
      for (const file of operands) {
        const abs = resolve(file);
        const st = await fs.stat(abs).catch(() => null);
        if (!st) {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, "");
        }
      }
      return "";
    }

    case "stat": {
      if (!operands.length) throw new Error("stat: missing operand");
      const out: string[] = [];
      for (const file of operands) {
        const abs = resolve(file);
        const st = await fs.stat(abs).catch(() => null);
        if (!st) throw new Error(`stat: ${file}: no such file or directory`);
        out.push(`  File: ${path.relative(root, abs) || "."}`, `  Type: ${st.isDirectory() ? "directory" : "file"}`);
      }
      return out.join("\n");
    }

    case "file": {
      if (!operands.length) throw new Error("file: missing operand");
      const out: string[] = [];
      for (const file of operands) {
        const st = await fs.stat(resolve(file)).catch(() => null);
        out.push(`${file}: ${st?.isDirectory() ? "directory" : "file"}`);
      }
      return out.join("\n");
    }

    case "du": {
      if (!operands.length) throw new Error("du: missing operand");
      const out: string[] = [];
      for (const file of operands) {
        const abs = resolve(file);
        const st = await fs.stat(abs).catch(() => null);
        if (!st) throw new Error(`du: ${file}: no such file or directory`);
        let bytes = 0;
        if (st.isDirectory()) {
          for (const p of await walk(fs, path, abs)) bytes += (await fs.readFile(p, "utf8")).length;
        } else {
          bytes = (await fs.readFile(abs, "utf8")).length;
        }
        out.push(`${bytes}\t${file}`);
      }
      return out.join("\n");
    }

    case "sort": {
      if (!operands.length) throw new Error("sort: missing file operand");
      const lines: string[] = [];
      for (const file of operands) lines.push(...(await read(file)).split("\n"));
      const reverse = flags.includes("-r");
      lines.sort((a, b) => a.localeCompare(b));
      if (reverse) lines.reverse();
      return lines.join("\n");
    }

    case "uniq": {
      if (!operands.length) throw new Error("uniq: missing file operand");
      const lines = (await read(operands[0])).split("\n");
      const out: string[] = [];
      for (const line of lines) if (out[out.length - 1] !== line) out.push(line);
      return out.join("\n");
    }

    case "diff": {
      if (operands.length < 2) throw new Error("diff: missing operand");
      const a = await read(operands[0]);
      const b = await read(operands[1]);
      return a === b ? "" : `Files ${operands[0]} and ${operands[1]} differ`;
    }

    default:
      throw new Error(`command not available in the browser: ${command}`);
  }
}

function numberFlag(flags: string[], name: string, fallback: number): number {
  const arg = flags.find((f) => f === name || f.startsWith(name));
  if (!arg) return fallback;
  const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
  const parsed = Number(inline);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function walk(
  fs: FileSystem,
  path: PathOps,
  dir: string,
  _opts: { includeDirs?: boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  if (out.length > MAX_LINES) return out;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(fs, path, full, _opts)));
    else out.push(full);
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
