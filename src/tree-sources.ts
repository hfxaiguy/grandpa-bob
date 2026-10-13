// Workspace tree discovery, shared by the admin UI (tree selector) and the
// agent (tree tools). A runnable tree is `patterns/<name>.draft.mjs` or
// `app/<name>/tree.draft.mjs` (the bare `<name>.mjs` / `tree.mjs` still counts
// as a draft for back-compat).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isVersionFileName, parsePatternFileName, scanTreeVersions } from "./tree-versions.js";

export const PATTERNS_DIR_NAME = "patterns";

export async function listPatterns(workspaceDir: string) {
  const patternsDir = path.join(workspaceDir, PATTERNS_DIR_NAME);
  try {
    const files = await readdir(patternsDir);
    const out: { file: string; name: string; description: string; guide: string }[] = [];
    for (const f of files) {
      if (!f.endsWith(".mjs")) continue;
      if (f.endsWith(".test.mjs")) continue; // smoke tests, not runnable patterns
      if (isVersionFileName(f)) continue; // versions are not trees of their own
      try {
        const content = await readFile(path.join(patternsDir, f), "utf8");
        const m = content.match(/^\/\/\s*(\S+\.mjs)\s*[—–-]\s*(.+)/m);
        // The logical name comes from the filename — `.draft`/`.prod`/`.vN`
        // are reserved suffixes — never from the first-line comment.
        const name = parsePatternFileName(f)?.logical ?? f.replace(/\.mjs$/, "");
        const desc = m ? m[2] : "(no description)";
        // One spec per tree: patterns/<name>.spec.md carries the `## Guide`
        // (the agent-facing "how to use me" text), same as an app tree.
        out.push({
          file: f,
          name,
          description: desc,
          guide: await guideFrom([
            path.join(patternsDir, `${name}.spec.md`),
            path.join(patternsDir, `${name}.md`),
          ]),
        });
      } catch {
        out.push({ file: f, name: f, description: "(read error)", guide: "" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * App trees: every `app/<dir>/tree.draft.mjs` is runnable as a top-level tree,
 * the same way a `patterns/<name>.draft.mjs` is. The directory name is the
 * selector value (loadPattern resolves it).
 */
export async function listAppTrees(workspaceDir: string) {
  const appDir = path.join(workspaceDir, "app");
  try {
    const entries = await readdir(appDir, { withFileTypes: true });
    const out: { file: string; name: string; description: string; guide: string; group: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(appDir, entry.name);
      // The draft is tree.draft.mjs; tree.mjs is the back-compat spelling.
      let draftFile: string | null = null;
      for (const cand of ["tree.draft.mjs", "tree.mjs"]) {
        try {
          await readFile(path.join(dir, cand), "utf8");
          draftFile = cand;
          break;
        } catch {
          // try the next spelling
        }
      }
      if (!draftFile) continue; // apps without a tree are tools-only
      out.push({
        file: `app/${entry.name}/${draftFile}`,
        name: entry.name,
        description: await appTreeDescription(dir),
        guide: await guideFrom([path.join(dir, "tree.spec.md"), path.join(dir, "tree.md")]),
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
  for (const file of ["tree.spec.md", "tree.md", "README.md"]) {
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

/**
 * The `## Guide` section of the first spec file that has one, trimmed, else "".
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

/** One runnable logical tree, with the versions currently on disk. */
export interface TreeSource {
  file: string;
  name: string;
  description: string;
  group: string;
  /** Agent-facing guidance from the spec's `## Guide` section, when present. */
  guide?: string;
  /** Version ids present, ascending (`["v1", "v2"]`). */
  versions: string[];
  /** Version ids whose paired `.spec.md` exists, ascending. */
  specVersions: string[];
  /** Version id of the prod snapshot, `"prod"` for a bare `.prod`, or null. */
  prod: string | null;
  /** True when an editable `patterns/<name>.draft.mjs` / `app/<name>/tree.draft.mjs` exists. */
  draft: boolean;
  /** True when the draft has a paired `.spec.md`. */
  draftSpec: boolean;
}

/**
 * Everything the tree selector can run: patterns first, then app trees. Each
 * logical tree is listed once — snapshots (`<name>.vN[.prod].mjs`) never show
 * up as trees of their own.
 */
export async function listTreeSources(workspaceDir: string): Promise<TreeSource[]> {
  type Base = Omit<TreeSource, "versions" | "specVersions" | "prod" | "draft" | "draftSpec">;
  const patterns: Base[] = (await listPatterns(workspaceDir)).map((p) => ({ ...p, group: "patterns" }));
  const catalog = new Map((await scanTreeVersions(workspaceDir)).map((c) => [c.logical, c]));
  return [...patterns, ...(await listAppTrees(workspaceDir))].map((source) => {
    const info = catalog.get(source.name);
    return {
      ...source,
      versions: info?.versions ?? [],
      specVersions: info?.specVersions ?? [],
      prod: info?.hasProd ? (info.prodVersion ?? "prod") : null,
      draft: info?.draft ?? true,
      draftSpec: info?.draftSpec ?? false,
    };
  });
}
