// src/tree-context.ts
//
// The host context app trees use to read and publish versioned trees. Knit
// calls this from registers: list the workspace trees, load a draft/snapshot's
// spec, and publish an edited draft as the next immutable snapshot. All the
// versioning rules live in tree-versions.ts; this is the thin, guarded surface.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveTreeEntry,
  scanTreeVersions,
  snapshotTree,
  specPathForTree,
  type TreeKind,
} from "./tree-versions.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function writeAtomic(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, { mode: 0o644 });
  await rename(tmp, abs);
}

/** First prose paragraph of a spec file, or "". */
async function descriptionOf(specAbs: string | null): Promise<string> {
  if (!specAbs) return "";
  try {
    const text = await readFile(specAbs, "utf8");
    const para: string[] = [];
    for (const raw of text.split("\n")) {
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
    return para.join(" ").replace(/\*\*/g, "").slice(0, 400);
  } catch {
    return "";
  }
}

export interface TreeContext {
  list(): Promise<
    { name: string; kind: TreeKind; description: string; versions: string[]; hasProd: boolean; draft: boolean }[]
  >;
  load(args: { name: string; kind?: TreeKind; ref?: string | null }): Promise<{
    exists: boolean;
    spec: string;
    hash: string | null;
    versions: string[];
    file: string | null;
    version: string | null;
    kind: TreeKind | null;
  }>;
  publish(args: {
    name: string;
    kind?: TreeKind;
    ref?: string | null;
    baseHash?: string | null;
    base_hash?: string | null;
    spec: string;
    module: string;
  }): Promise<{ name: string; version: string; created: boolean; files: string[] }>;
}

export function makeTreeContext(workspaceDir: string): TreeContext {
  const draftRelFor = (name: string, kind: TreeKind) =>
    kind === "app" ? path.join("app", name, "tree.mjs") : path.join("patterns", `${name}.mjs`);

  return {
    async list() {
      const catalog = await scanTreeVersions(workspaceDir);
      const out = [];
      for (const entry of catalog) {
        const resolved = await resolveTreeEntry(workspaceDir, entry.logical, "draft");
        out.push({
          name: entry.logical,
          kind: entry.kind,
          description: await descriptionOf(resolved?.specAbs ?? null),
          versions: entry.versions,
          hasProd: entry.hasProd,
          draft: entry.draft,
        });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    async load({ name, kind, ref }) {
      const resolved = await resolveTreeEntry(workspaceDir, name, ref ?? "draft");
      const catalog = (await scanTreeVersions(workspaceDir)).find((e) => e.logical === name);
      if (!resolved) {
        return { exists: false, spec: "", hash: null, versions: catalog?.versions ?? [], file: null, version: null, kind: kind ?? null };
      }
      const spec = resolved.specAbs ? await readFile(resolved.specAbs, "utf8") : "";
      return {
        exists: Boolean(resolved.specAbs || resolved.abs),
        spec,
        hash: spec ? sha256(spec) : null,
        versions: catalog?.versions ?? [],
        file: resolved.file,
        version: resolved.version,
        kind: resolved.kind,
      };
    },

    async publish({ name, kind = "app", baseHash, base_hash, spec, module }) {
      const draftRel = draftRelFor(name, kind);
      const specRel = specPathForTree(draftRel);
      const specAbs = path.join(workspaceDir, specRel);

      // Guard: refuse when the spec on disk is not the one that was loaded.
      const want = baseHash ?? base_hash ?? null;
      if (want) {
        let current: string | null = null;
        try { current = await readFile(specAbs, "utf8"); } catch { current = null; }
        if (current !== null && sha256(current) !== want) {
          throw new Error(
            `the spec for '${name}' changed while it was being edited — reload the tree and retry`,
          );
        }
      }

      await writeAtomic(path.join(workspaceDir, draftRel), String(module ?? ""));
      await writeAtomic(specAbs, String(spec ?? ""));

      const snap = await snapshotTree(workspaceDir, name);
      return {
        name,
        version: snap.version,
        created: snap.created,
        files: [draftRel, specRel, snap.file, snap.spec].filter((f): f is string => Boolean(f)),
      };
    },
  };
}
