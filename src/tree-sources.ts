// Workspace tree discovery, shared by the admin UI (tree selector) and the
// agent (tree tools). A runnable tree is either `patterns/<name>.mjs` or
// `app/<name>/tree.mjs`.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const PATTERNS_DIR_NAME = "patterns";

export async function listPatterns(workspaceDir: string) {
  const patternsDir = path.join(workspaceDir, PATTERNS_DIR_NAME);
  try {
    const files = await readdir(patternsDir);
    const out: { file: string; name: string; description: string }[] = [];
    for (const f of files) {
      if (!f.endsWith(".mjs")) continue;
      if (f.endsWith(".test.mjs")) continue; // smoke tests, not runnable patterns
      try {
        const content = await readFile(path.join(patternsDir, f), "utf8");
        const m = content.match(/^\/\/\s*(\S+\.mjs)\s*[—–-]\s*(.+)/m);
        const name = m ? m[1].replace(/\.mjs$/, "") : f.replace(/\.mjs$/, "");
        const desc = m ? m[2] : "(no description)";
        out.push({ file: f, name, description: desc });
      } catch {
        out.push({ file: f, name: f, description: "(read error)" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * App trees: every `app/<dir>/tree.mjs` is runnable as a top-level tree, the
 * same way a `patterns/<name>.mjs` is. The directory name is the selector
 * value (loadPattern resolves it).
 */
export async function listAppTrees(workspaceDir: string) {
  const appDir = path.join(workspaceDir, "app");
  try {
    const entries = await readdir(appDir, { withFileTypes: true });
    const out: { file: string; name: string; description: string; group: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(appDir, entry.name);
      try {
        await readFile(path.join(dir, "tree.mjs"), "utf8");
      } catch {
        continue; // apps without a tree are tools-only
      }
      out.push({
        file: `app/${entry.name}/tree.mjs`,
        name: entry.name,
        description: await appTreeDescription(dir),
        group: "app",
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * First prose paragraph of the app's tree.md, falling back to its README. Its
 * lines are joined, so a summary that wraps is not truncated; authors keep the
 * summary on its own line, then a blank line, then the detail.
 */
async function appTreeDescription(appDir: string): Promise<string> {
  for (const file of ["tree.md", "README.md"]) {
    try {
      const content = await readFile(path.join(appDir, file), "utf8");
      const para: string[] = [];
      for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (para.length === 0) {
          if (!line || line.startsWith("#") || line.startsWith("```")) continue;
          para.push(line);
        } else if (!line) {
          break;
        } else {
          para.push(line);
        }
      }
      const text = para.join(" ").replace(/\*\*/g, "");
      if (text) return text;
    } catch {
      // try the next file
    }
  }
  return "(app tree)";
}

/** Everything the tree selector can run: patterns first, then app trees. */
export async function listTreeSources(workspaceDir: string) {
  const patterns = (await listPatterns(workspaceDir)).map((p) => ({ ...p, group: "patterns" }));
  return [...patterns, ...(await listAppTrees(workspaceDir))];
}
