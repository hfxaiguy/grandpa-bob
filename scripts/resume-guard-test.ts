/**
 * Resume recovery — the browser host's stale-checkpoint guard.
 *
 * A pawned session resumes by rebuilding the tree stack named in its
 * checkpoint. Two failure shapes must be treated as a dead pause point
 * (`isDroppableContinuationError`), so the turn grows a fresh tree and still
 * answers the message instead of surfacing `agent run failed: cannot resume:
 * tree '…' is not registered` in the chat:
 *
 *   1. `cannot resume: tree 'caller_list' is not registered` — the checkpoint
 *      stores the tree's INTERNAL name (grandma-kat `name(...)`), which may
 *      use an underscore where the app folder uses a dash. This is the live
 *      Telegram failure that motivated the guard.
 *   2. `checkpoint '…' not found` — the run log was cleared or pruned.
 *
 * Anything else is a genuine failure and must propagate.
 *
 * It also pins `resolveTreeEntryByName`: the underscore spelling resolves the
 * dash-named app folder (and vice versa), while an unknown name stays null.
 *
 * No network, no browser. Run: npm run test:resume-guard
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveTreeEntryByName } from "../web/src/tree-files.ts";
import { isDroppableContinuationError } from "../web/src/agent/resume-guard.ts";

// ── 1. the predicate ────────────────────────────────────────────────────

assert.equal(
  isDroppableContinuationError(
    "cannot resume: tree 'caller_list' is not registered (call .name() to register)",
  ),
  true,
  "the internal-name/checkpoint mismatch is recoverable",
);
assert.equal(
  isDroppableContinuationError("cannot resume: tree '' is not registered (call .name() to register)"),
  true,
  "the empty-name variant is recoverable",
);
assert.equal(
  isDroppableContinuationError("checkpoint 'cp_123' not found"),
  true,
  "a pruned checkpoint is recoverable",
);
assert.equal(
  isDroppableContinuationError("Missing required slot: Needs(input)"),
  false,
  "a genuine tree failure propagates",
);
assert.equal(
  isDroppableContinuationError("fetch failed: ECONNREFUSED"),
  false,
  "a transport failure propagates",
);

// ── 2. dash/underscore tree resolution ───────────────────────────────────

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-resume-guard-"));
await fs.mkdir(path.join(ws, "app", "caller-list"), { recursive: true });
await fs.writeFile(
  path.join(ws, "app", "caller-list", "tree.prod.mjs"),
  '// ## caller-list: app/caller-list/tree.prod.mjs\nexport default 1;\n',
);
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.writeFile(path.join(ws, "patterns", "some_pattern.prod.mjs"), "export default 2;\n");

const direct = await resolveTreeEntryByName(ws, "caller-list");
assert.equal(direct?.file, path.join("app", "caller-list", "tree.prod.mjs"), "the folder name resolves");

const internal = await resolveTreeEntryByName(ws, "caller_list");
assert.equal(
  internal?.file,
  path.join("app", "caller-list", "tree.prod.mjs"),
  "the checkpoint's internal underscore name resolves the dashed app",
);

const pattern = await resolveTreeEntryByName(ws, "some-pattern");
assert.equal(
  pattern?.file,
  path.join("patterns", "some_pattern.prod.mjs"),
  "the dash spelling resolves an underscore pattern file",
);

assert.equal(await resolveTreeEntryByName(ws, "not-there"), null, "an unknown tree stays null");
assert.equal(await resolveTreeEntryByName(ws, "a..b"), null, "an ill-formed name is rejected");

await fs.rm(ws, { recursive: true, force: true });

console.log("resume-guard: ok");
