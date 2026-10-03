import { resolveInWorkspace, toRel } from "../util/paths.js";
import type { Platform } from "../platform/types.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "tmp"]);
const MAX_READ_CHARS = 100_000;
const MAX_LIST_ENTRIES = 400;

/**
 * Sandboxed workspace file tools. Runs over the injected `Platform`, so the
 * same class serves the Node target (`createNodePlatform`) and the browser
 * target (OPFS) without importing any Node builtin.
 */
export class FileTools {
  constructor(private platform: Platform) {}

  private get workspace(): string {
    return this.platform.workspaceRoot;
  }

  private resolve(rel: string): string {
    return resolveInWorkspace(this.workspace, rel);
  }

  async listFiles(rel = ".", recursive = true, depth = 4): Promise<string> {
    const { fs, path } = this.platform;
    const abs = this.resolve(rel);
    const out: string[] = [];
    const walk = async (dir: string, d: number): Promise<void> => {
      if (out.length >= MAX_LIST_ENTRIES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_LIST_ENTRIES) return;
        const full = path.join(dir, e.name);
        const r = toRel(this.workspace, full);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          out.push(r + "/");
          if (recursive && d < depth) await walk(full, d + 1);
        } else {
          out.push(r);
        }
      }
    };
    const st = await fs.stat(abs).catch(() => null);
    if (!st) throw new Error(`not found: ${rel}`);
    if (st.isFile()) return toRel(this.workspace, abs);
    await walk(abs, 0);
    const suffix = out.length >= MAX_LIST_ENTRIES ? "\n… (truncated)" : "";
    return out.length ? out.join("\n") + suffix : "(empty directory)";
  }

  async readFile(rel: string): Promise<string> {
    const { fs } = this.platform;
    const abs = this.resolve(rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) throw new Error(`not found: ${rel}`);
    if (st.isDirectory()) return this.listFiles(rel, false);
    const content = await fs.readFile(abs, "utf8");
    if (content.length > MAX_READ_CHARS) {
      return content.slice(0, MAX_READ_CHARS) + `\n… (truncated, file is ${content.length} chars)`;
    }
    return content || "(empty file)";
  }

  async writeFile(rel: string, content: string): Promise<string> {
    const { fs, git, path } = this.platform;
    const abs = this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    const relPath = toRel(this.workspace, abs);
    const hash = await git.autoCommit([relPath], `agent(write_file): ${relPath}`);
    return `wrote ${content.length} chars to ${relPath} (commit: ${hash})`;
  }

  async editFile(rel: string, oldString: string, newString: string, replaceAll = false): Promise<string> {
    if (oldString === newString) throw new Error("old_string and new_string are identical");
    const { fs, git } = this.platform;
    const abs = this.resolve(rel);
    const content = await fs.readFile(abs, "utf8").catch(() => {
      throw new Error(`not found: ${rel}`);
    });
    const count = content.split(oldString).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${rel}`);
    if (count > 1 && !replaceAll) {
      throw new Error(`old_string occurs ${count} times in ${rel}; make it more unique or set replace_all=true`);
    }
    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    await fs.writeFile(abs, updated);
    const relPath = toRel(this.workspace, abs);
    const hash = await git.autoCommit([relPath], `agent(edit_file): ${relPath}`);
    return `edited ${relPath} (${count} replacement${count > 1 ? "s" : ""}, commit: ${hash})`;
  }

  async deleteFile(rel: string): Promise<string> {
    const { fs, git } = this.platform;
    const abs = this.resolve(rel);
    await fs.rm(abs); // errors if missing or a non-empty directory
    const relPath = toRel(this.workspace, abs);
    const hash = await git.autoCommit([relPath], `agent(delete_file): ${relPath}`);
    return `deleted ${relPath} (commit: ${hash})`;
  }
}
