import { resolveInWorkspace, toRel } from "../util/paths.js";
import { flushDirtyDumps } from "../db-sync.js";
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

  /**
   * Read a file, optionally one character range of it. `offset` is a
   * 0-based character offset; `limit` is capped at MAX_READ_CHARS so one
   * call can never flood the transcript. When more text remains, the result
   * ends with a note naming the next offset — callers that need the whole
   * file walk it chunk by chunk instead of guessing that 100k was the end.
   */
  async readFile(
    rel: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<string> {
    const { fs } = this.platform;
    const abs = this.resolve(rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) throw new Error(`not found: ${rel}`);
    if (st.isDirectory()) return this.listFiles(rel, false);
    const content = await fs.readFile(abs, "utf8");
    const total = content.length;
    const rawOffset = Number(opts.offset ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    if (offset > 0 && offset >= total) {
      throw new Error(`offset ${offset} is past the end of ${rel} (${total} chars)`);
    }
    const rawLimit = Number(opts.limit ?? MAX_READ_CHARS);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(MAX_READ_CHARS, Math.max(1, Math.floor(rawLimit)))
      : MAX_READ_CHARS;
    const end = Math.min(total, offset + limit);
    if (offset === 0 && end === total) return content || "(empty file)";
    const slice = content.slice(offset, end);
    const range = end < total
      ? `\n… (read chars ${offset}..${end} of ${total}; next offset ${end})`
      : `\n… (read chars ${offset}..${end} of ${total}; end of file)`;
    return slice + range;
  }

  /**
   * Read a workspace file as raw UTF-8 text for JSON parsing. Unlike
   * `readFile` it never truncates — a truncated JSON document cannot parse —
   * so the caller (read_json) enforces its own size cap on the content.
   */
  async readJsonText(rel: string): Promise<string> {
    const { fs } = this.platform;
    const abs = this.resolve(rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) throw new Error(`not found: ${rel}`);
    if (st.isDirectory()) throw new Error(`not a file: ${rel} (use list_files)`);
    return fs.readFile(abs, "utf8");
  }

  async writeFile(rel: string, content: string): Promise<string> {
    const { fs, git, path } = this.platform;
    const abs = this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    const relPath = toRel(this.workspace, abs);
    const dumps = await flushDirtyDumps(this.platform).catch(() => []);
    const hash = await git.autoCommit([relPath, ...dumps], `agent(write_file): ${relPath}`);
    return `wrote ${content.length} chars to ${relPath} (commit: ${hash})`;
  }

  /**
   * Copy one file byte-for-byte. `write_file` cannot do this: its content is a
   * JavaScript string, so binary data (SQLite databases, images, archives)
   * would be mangled by a UTF-8 round-trip. Destinations are refused when they
   * already exist unless `overwrite` is true, so a mistaken path cannot clobber
   * a good file (the old copy is still recoverable from git in most cases).
   */
  async copyFile(from: string, to: string, overwrite = false): Promise<string> {
    const { fs, git, path } = this.platform;
    const src = this.resolve(from);
    const dst = this.resolve(to);
    if (src === dst) throw new Error("source and destination are the same path");
    const srcStat = await fs.stat(src).catch(() => null);
    if (!srcStat) throw new Error(`not found: ${from}`);
    if (!srcStat.isFile()) throw new Error(`not a file: ${from} (copy_file copies files)`);
    const dstStat = await fs.stat(dst).catch(() => null);
    if (dstStat?.isDirectory()) throw new Error(`destination is a directory: ${to}`);
    if (dstStat && !overwrite) {
      throw new Error(`destination exists: ${to} (pass overwrite: true to replace it)`);
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    if (fs.copyFile) {
      await fs.copyFile(src, dst);
    } else {
      // Older/ad-hoc adapters: fall back to a binary read + write, never utf8.
      const binary = fs as unknown as { readFileBytes?: (p: string) => Promise<Uint8Array> };
      if (!binary.readFileBytes) throw new Error("this target cannot copy files byte-for-byte");
      await fs.writeFile(dst, await binary.readFileBytes(src));
    }
    const relPath = toRel(this.workspace, dst);
    const dumps = await flushDirtyDumps(this.platform).catch(() => []);
    const hash = await git.autoCommit([relPath, ...dumps], `agent(copy_file): ${relPath}`);
    return `copied ${from} -> ${relPath} (commit: ${hash})`;
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
    const dumps = await flushDirtyDumps(this.platform).catch(() => []);
    const hash = await git.autoCommit([relPath, ...dumps], `agent(edit_file): ${relPath}`);
    return `edited ${relPath} (${count} replacement${count > 1 ? "s" : ""}, commit: ${hash})`;
  }

  async deleteFile(rel: string): Promise<string> {
    const { fs, git } = this.platform;
    const abs = this.resolve(rel);
    await fs.rm(abs); // errors if missing or a non-empty directory
    const relPath = toRel(this.workspace, abs);
    const dumps = await flushDirtyDumps(this.platform).catch(() => []);
    const hash = await git.autoCommit([relPath, ...dumps], `agent(delete_file): ${relPath}`);
    return `deleted ${relPath} (commit: ${hash})`;
  }
}
