// src/tree-context.ts
//
// The host context app trees use to read and save trees. Knit calls this from
// registers: list the workspace trees, load a tree's header spec + module, and
// write an edited tree. All the tree-file rules live in tree-files.ts; this is
// the thin, guarded surface. A tree is ONE file — saving writes its
// `.prod.mjs` in place; there is no draft copy and no separate spec file.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTreeEntry, treePathFor, type TreeKind } from "./tree-files.js";
import { listAppTrees, listPatterns } from "./tree-sources.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function writeAtomic(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, { mode: 0o644 });
  await rename(tmp, abs);
}

/**
 * The tree's notation spec: the leading `//` comment block, uncommented. When
 * the block carries a `## <name>` notation header, the spec starts there (the
 * prose above it — title, symbol legend — is documentation, not notation).
 */
export function headerSpecOf(moduleText: string): string {
  const lines: string[] = [];
  for (const line of moduleText.split("\n")) {
    if (line.startsWith("//")) lines.push(line.replace(/^\/\/ ?/, ""));
    else if (!line.trim() && lines.length === 0) continue;
    else break;
  }
  const at = lines.findIndex((line) => /^\s*##\s+\S/.test(line));
  return (at >= 0 ? lines.slice(at) : lines).join("\n").trim();
}

export interface TreeContext {
  list(): Promise<{ name: string; kind: TreeKind; description: string }[]>;
  load(args: { name: string; kind?: TreeKind }): Promise<{
    exists: boolean;
    /** The tree's header comment block — its notation spec. */
    spec: string;
    /** The full module text. */
    module: string;
    hash: string | null;
    file: string | null;
    kind: TreeKind | null;
  }>;
  save(args: {
    name: string;
    kind?: TreeKind;
    base_hash?: string | null;
    module: string;
    /** First README for a NEW app tree (never overwrites an existing one). */
    readme?: string;
  }): Promise<{ name: string; file: string; created: boolean }>;
}

export function makeTreeContext(workspaceDir: string): TreeContext {
  return {
    async list() {
      const sources = [...(await listPatterns(workspaceDir)), ...(await listAppTrees(workspaceDir))];
      return sources
        .map((s) => ({
          name: s.name,
          kind: (s.group === "app" ? "app" : "pattern") as TreeKind,
          description: s.description,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async load({ name, kind }) {
      const resolved = await resolveTreeEntry(workspaceDir, name);
      if (!resolved) {
        return { exists: false, spec: "", module: "", hash: null, file: null, kind: kind ?? null };
      }
      const module = await readFile(resolved.abs, "utf8");
      return {
        exists: true,
        spec: headerSpecOf(module),
        module,
        hash: sha256(module),
        file: resolved.file,
        kind: resolved.kind,
      };
    },

    async save({ name, kind = "app", base_hash, module, readme }) {
      const rel = treePathFor(name, kind);
      const abs = path.join(workspaceDir, rel);

      // Guard: refuse when the file on disk is not the one that was loaded.
      if (base_hash) {
        let current: string | null = null;
        try {
          current = await readFile(abs, "utf8");
        } catch {
          current = null;
        }
        if (current !== null && sha256(current) !== base_hash) {
          throw new Error(
            `the tree '${name}' changed while it was being edited — reload the tree and retry`,
          );
        }
      }

      let created = true;
      try {
        await readFile(abs, "utf8");
        created = false;
      } catch {
        created = true;
      }

      await writeAtomic(abs, String(module ?? ""));

      // A new app tree needs its README: the first paragraph is the tool
      // description and `## Guide` is the caller guidance. Never overwrite a
      // README the author already wrote.
      if (kind === "app" && readme && created) {
        const readmeAbs = path.join(workspaceDir, "app", name, "README.md");
        try {
          await readFile(readmeAbs, "utf8");
        } catch {
          await writeAtomic(readmeAbs, String(readme));
        }
      }
      return { name, file: rel, created };
    },
  };
}
