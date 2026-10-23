// Workspace tree discovery, shared by the admin UI (tree selector) and the
// agent (tree tools). A runnable tree is exactly one production file:
// `patterns/<name>.prod.mjs` or `app/<name>/tree.prod.mjs`. The file's leading
// comment block is its spec; an app's `## Guide` lives in its README.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parsePatternFileName } from "./tree-files.js";

export const PATTERNS_DIR_NAME = "patterns";

/** One runnable logical tree. */
export interface TreeSource {
  file: string;
  name: string;
  description: string;
  group: string;
  /** Agent-facing guidance from the `## Guide` section, when present. */
  guide?: string;
}

export async function listPatterns(workspaceDir: string): Promise<TreeSource[]> {
  const patternsDir = path.join(workspaceDir, PATTERNS_DIR_NAME);
  try {
    const out: TreeSource[] = [];
    for (const file of await readdir(patternsDir)) {
      const name = parsePatternFileName(file);
      if (!name) continue;
      try {
        const content = await readFile(path.join(patternsDir, file), "utf8");
        const m = content.match(/^\/\/\s*(\S+\.mjs)\s*[—–-]\s*(.+)/m);
        out.push({
          file,
          name,
          description: m ? m[2] : "(no description)",
          group: "patterns",
          // A pattern may keep optional caller guidance beside it.
          guide: await guideFrom([path.join(patternsDir, `${name}.md`)]),
        });
      } catch {
        out.push({ file, name, description: "(read error)", group: "patterns", guide: "" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * App trees: every `app/<dir>/tree.prod.mjs` is runnable as a top-level tree.
 * The directory name is the selector value (loadPattern resolves it).
 */
export async function listAppTrees(workspaceDir: string): Promise<TreeSource[]> {
  const appDir = path.join(workspaceDir, "app");
  try {
    const entries = await readdir(appDir, { withFileTypes: true });
    const out: TreeSource[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(appDir, entry.name);
      try {
        await readFile(path.join(dir, "tree.prod.mjs"), "utf8");
      } catch {
        continue; // apps without a tree are tools-only
      }
      out.push({
        file: `app/${entry.name}/tree.prod.mjs`,
        name: entry.name,
        description: await appTreeDescription(dir),
        guide: await guideFrom([path.join(dir, "README.md")]),
        group: "app",
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * First prose paragraph of the app's README. Its lines are joined, so a summary
 * that wraps is not truncated; authors keep the summary on its own line, then a
 * blank line, then the detail.
 */
async function appTreeDescription(appDir: string): Promise<string> {
  try {
    const content = await readFile(path.join(appDir, "README.md"), "utf8");
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
    // no README
  }
  return "(app tree)";
}

/**
 * The `## Guide` section of the first file that has one, trimmed, else "".
 * This is the agent-facing "how to use me" text, injected as TOOL GUIDANCE.
 */
async function guideFrom(files: string[]): Promise<string> {
  for (const file of files) {
    try {
      const lines = (await readFile(file, "utf8")).split("\n");
      const out: string[] = [];
      let inside = false;
      for (const line of lines) {
        const heading = line.match(/^##\s+(.*)$/);
        if (heading) {
          inside = heading[1].trim().toLowerCase() === "guide";
          continue;
        }
        if (inside) out.push(line);
      }
      const text = out.join("\n").trim();
      if (text) return text;
    } catch {
      // try the next file
    }
  }
  return "";
}

/** Every tree the selector can run: patterns first, then app trees. */
export async function listTreeSources(workspaceDir: string): Promise<TreeSource[]> {
  return [...(await listPatterns(workspaceDir)), ...(await listAppTrees(workspaceDir))];
}
