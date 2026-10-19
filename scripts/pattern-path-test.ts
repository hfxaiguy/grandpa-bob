/**
 * The pattern picker sends logical names ("context_manager", "name@draft"),
 * while boot sends workspace paths ("patterns/trunk.mjs"). Both must end at the
 * version-aware file, or the module loader opens `<workspace>/context_manager`.
 *
 *   npm run test:pattern-path
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Platform } from "../src/platform/types";
import { createNodePlatform } from "../src/platform/node";
import { listTreeSources } from "../src/tree-sources";
import { resolvePatternPath } from "../web/src/agent/pattern-path";

async function main(): Promise<void> {
  const ws = await mkdtemp(path.join(os.tmpdir(), "bob-pattern-path-"));
  try {
    await mkdir(path.join(ws, "patterns"), { recursive: true });
    for (const file of [
      "context_manager.draft.mjs",
      "context_manager.prod.mjs",
      "trunk.prod.mjs",
      "legacy.mjs",
    ]) {
      await writeFile(path.join(ws, "patterns", file), "export default {};\n");
    }

    const platform = createNodePlatform(ws) as Platform;

    assert.equal(
      await resolvePatternPath(platform, "context_manager"),
      "patterns/context_manager.prod.mjs",
      "a logical name resolves to its prod snapshot",
    );
    assert.equal(
      await resolvePatternPath(platform, "context_manager@draft"),
      "patterns/context_manager.draft.mjs",
      "a pinned draft ref resolves to the working file",
    );
    assert.equal(
      await resolvePatternPath(platform, "patterns/trunk.mjs"),
      "patterns/trunk.mjs",
      "an explicit path passes through untouched",
    );
    assert.equal(
      await resolvePatternPath(platform, ""),
      "patterns/trunk.mjs",
      "an empty pattern falls back to trunk",
    );
    assert.equal(
      await resolvePatternPath(platform, "legacy"),
      "patterns/legacy.mjs",
      "a single-file pattern outside the version catalog still works",
    );
    await assert.rejects(
      () => resolvePatternPath(platform, "not_here"),
      /unknown pattern 'not_here'.*available: context_manager, legacy, trunk/,
      "a missing name lists the patterns that do exist",
    );

    // Discovery must list a tree that only exists as a prod snapshot (trunk in
    // the live workspace), while still listing each logical tree exactly once.
    const sources = await listTreeSources(ws);
    const names = sources.map((s) => s.name).sort();
    assert.deepEqual(names, ["context_manager", "legacy", "trunk"]);
    assert.equal(
      sources.find((s) => s.name === "trunk")?.file,
      "trunk.prod.mjs",
      "the prod snapshot is the listed file when there is no draft",
    );
    console.log(
      "pattern-path: logical names resolve to version-aware files; prod-only trees are discovered",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("pattern-path: FAILED");
  console.error(err);
  process.exitCode = 1;
});
