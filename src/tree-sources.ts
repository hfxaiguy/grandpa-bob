// Workspace tree discovery, shared by the admin UI (tree selector) and the
// agent (tree tools). A runnable tree is exactly one production file:
// `patterns/<name>.prod.mjs` or `app/<name>/tree.prod.mjs` — the latter at any
// depth (`app/a/app/b/app/c/tree.prod.mjs` is the app `a.b.c`). The file's
// leading comment block is its spec; an app's `## Guide` lives in its README.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { APP_DIR, LOGICAL_SEGMENT_RE, logicalForAppDir, parsePatternFileName } from "./tree-files.js";

export const PATTERNS_DIR_NAME = "patterns";

/** One runnable logical tree. */
export interface TreeSource {
  file: string;
  name: string;
  description: string;
  group: string;
  /** The enclosing app's logical name, when this tree parks inside one.
   *  Null/absent on top-level apps (the board shows them as their own tiles;
   *  nested ones park in their parent). */
  parent?: string | null;
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
 * App trees: every `app/<dir>/tree.prod.mjs` is runnable as a top-level tree,
 * and every app folder may keep an `app/` folder of its own, so discovery
 * descends fractally (`app/enrich-profile/app/widget/` is the app
 * `enrich-profile.widget`). The logical name is the selector value (loadPattern
 * resolves it); `parent` is the nearest ancestor that bears a tree itself — a
 * tree-less app folder still hosts its children, they just group under its
 * nearest runnable ancestor (or none, at the top).
 */
export async function listAppTrees(workspaceDir: string): Promise<TreeSource[]> {
  const out: TreeSource[] = [];
  const seen = new Set<string>();
  await scanAppFolders(path.join(workspaceDir, APP_DIR), APP_DIR, null, out, seen);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One container of app folders (`app/`, or the nested `app/` inside an app).
 * Names are deduplicated flat-first: a top-level folder with a literal dotted
 * name (`app/a.b/`) keeps the logical `a.b`, and a nested `app/a/app/b/`
 * spelling of the same name yields to it.
 */
async function scanAppFolders(
  containerAbs: string,
  containerRel: string,
  parent: string | null,
  out: TreeSource[],
  seen: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(containerAbs, { withFileTypes: true });
  } catch {
    return; // no such container — stop this branch
  }
  const topLevel = containerRel === APP_DIR;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dirAbs = path.join(containerAbs, entry.name);
    const dirRel = `${containerRel}/${entry.name}`;
    // Top-level: the folder name IS the logical name (dotted flat names stay
    // legal). Nested: dot-free segments only — a dotted folder cannot be
    // addressed as a nesting step, so its children are not discoverable.
    const logical = topLevel ? entry.name : logicalForAppDir(dirRel);
    if (!logical) continue;
    let hasTree = false;
    try {
      await readFile(path.join(dirAbs, "tree.prod.mjs"), "utf8");
      hasTree = true;
    } catch {
      // apps without a tree are tools-only, but may still host sub-apps
    }
    if (hasTree && !seen.has(logical)) {
      seen.add(logical);
      out.push({
        file: `${dirRel}/tree.prod.mjs`,
        name: logical,
        description: await appTreeDescription(dirAbs),
        guide: await guideFrom([path.join(dirAbs, "README.md")]),
        group: "app",
        parent: parent ?? null,
      });
    }
    // The segment must be a legal nesting step for the descent to make sense.
    if (LOGICAL_SEGMENT_RE.test(entry.name)) {
      await scanAppFolders(
        path.join(dirAbs, APP_DIR),
        `${dirRel}/${APP_DIR}`,
        hasTree ? logical : parent,
        out,
        seen,
      );
    }
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
