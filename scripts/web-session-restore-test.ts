/**
 * A reloaded browser worker restores its paused session instead of re-seeding it.
 *
 * The browser logger is the engine's sync contract over the async log DB:
 * call rows and checkpoints are shadowed (grandma-kat's `createSessionLogStore`
 * + `web/src/agent/log-store.ts`). This test drives a real Human-pausing tree
 * through `createWorkspaceLogger`, then treats a fresh logger over the same
 * platform as a restarted worker:
 *
 *   1. A paused turn writes a `checkpoints` row AFTER its call rows.
 *   2. `resumableCheckpoint` finds the pause for the chat key; a fresh logger's
 *      `restore()` hydrates it, and `resume()` continues the SAME run with the
 *      delivered reply in the log.
 *   3. The consumed checkpoint is gone (memory, DB), and the new pause is
 *      shadowed; a third restore completes the tree and leaves no checkpoint.
 *   4. A session delete marker after the pause is not resurrected.
 *   5. A torn flush (pause row missing) refuses the restore instead of
 *      resuming into a partial log.
 *
 * Node platform, no network, no browser. Run: npm run test:web-restore
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Tree, name, Human, Prompt, Return, knit, resume } from "grandma-kat";
import { createNodePlatform } from "../src/platform/node.ts";
import { createWorkspaceLogger } from "../web/src/agent/logger.ts";
import {
  loadCheckpointRow,
  logDbPath,
  readRow,
  resumableCheckpoint,
  writeDelete,
  writeTurnEnd,
} from "../web/src/agent/log-store.ts";
import type { Platform } from "../web/src/platform/types.ts";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-web-restore-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const platform = createNodePlatform(ws);

const models = {
  default: { model: "mock", handler: async () => ({ content: "ok" }) },
};

const tree = () =>
  Tree(
    name("restore"),
    Human("first"),
    Prompt("reply", (m: Record<string, unknown>) => `say ${String(m.first)}`),
    Human("second"),
    Return((m: { branch: Record<string, unknown> }) => m.branch.reply),
  );

const chat = "web:restore-test";

async function restoreLogger(): Promise<ReturnType<typeof createWorkspaceLogger>> {
  const logger = createWorkspaceLogger(platform);
  await logger.ready;
  return logger;
}

async function countCheckpoints(platform: Platform): Promise<number> {
  const db = await platform.sqlite.open(logDbPath(platform), { readOnly: false });
  try {
    const row = (await (await db.prepare("SELECT COUNT(*) n FROM checkpoints")).get()) as {
      n: number;
    };
    return Number(row.n);
  } finally {
    await db.close();
  }
}

async function deleteCallRow(platform: Platform, seq: number): Promise<void> {
  const db = await platform.sqlite.open(logDbPath(platform), { readOnly: false });
  try {
    await (await db.prepare("DELETE FROM calls WHERE seq = ?")).run(seq);
  } finally {
    await db.close();
  }
}

// ── 1. a paused turn shadows its checkpoint ──────────────────────────────
const loggerA = await restoreLogger();
const first = await knit(tree(), { models, logger: loggerA, sessionId: chat });
assert.equal(first.status, "waiting", "the tree paused at the first human");
const checkpointId = first.continuation!;
const runId = checkpointId.split(":")[0];
await loggerA.flush();

const row = await loadCheckpointRow(platform, checkpointId);
assert.ok(row, "the checkpoint reached the log DB");
const pauseRow = await readRow(platform, Number(row!.seq));
assert.equal(pauseRow?.kind, "human", "the checkpoint points at its pause row");
assert.equal(await countCheckpoints(platform), 1);

// The host writes the turn marker after the run returns (the real backend
// does), so the session-to-run policy can find the pause.
await writeTurnEnd(platform, {
  key: chat,
  turnId: "turn-a",
  runId,
  input: "hello?",
  status: "done",
  awaiting: "first",
  startedAt: Date.now() - 1000,
  endedAt: Date.now(),
  ts: Date.now(),
});

// ── 2. a restarted logger restores and resumes the same run ──────────────
const found = await resumableCheckpoint(platform, chat);
assert.ok(found, "the session's pause is resumable");
assert.equal(found!.checkpoint.id, checkpointId);

const loggerB = await restoreLogger();
const restored = await loggerB.restore(found!.checkpoint.id);
assert.equal(restored.ok, true, `restore failed: ${restored.ok ? "" : restored.reason}`);

const second = await resume(found!.checkpoint.id, {
  models,
  logger: loggerB,
  humanInput: "hello",
});
assert.equal(second.status, "waiting", "the resumed tree paused at the second human");
assert.ok(
  String(second.continuation).startsWith(`${runId}:`),
  "the resumed turn kept the original run id",
);
await loggerB.flush();

const delivered = loggerB
  .getEvents(runId)
  .find((e) => e.kind === "human" && (e.content as { delivered?: boolean })?.delivered === true);
assert.equal(
  (delivered?.content as { value?: string })?.value,
  "hello",
  "the reply is in the resumed run's log",
);
assert.equal(await loadCheckpointRow(platform, checkpointId), null, "the consumed checkpoint is gone");
assert.equal(await countCheckpoints(platform), 1, "exactly the new pause remains");

// ── 3. another restart completes the tree ────────────────────────────────
const nextId = second.continuation!;
const loggerC = await restoreLogger();
assert.equal((await loggerC.restore(nextId)).ok, true, "the new pause restores");
const done = await resume(nextId, { models, logger: loggerC, humanInput: "bye" });
assert.notEqual(done.status, "waiting", "the tree completed");
await loggerC.flush();
assert.equal(await countCheckpoints(platform), 0, "a completed run leaves no checkpoint");

// ── 4. delete tombstones the pause ───────────────────────────────────────
const deleteChat = "web:deleted-test";
const loggerD = await restoreLogger();
const pausedD = await knit(tree(), { models, logger: loggerD, sessionId: deleteChat });
assert.equal(pausedD.status, "waiting");
await loggerD.flush();
await writeTurnEnd(platform, {
  key: deleteChat,
  turnId: "turn-d",
  runId: pausedD.continuation!.split(":")[0],
  input: "hi",
  status: "done",
  awaiting: "first",
  startedAt: Date.now() - 1000,
  endedAt: Date.now() - 500,
  ts: Date.now() - 500,
});
assert.ok(await resumableCheckpoint(platform, deleteChat), "the pause is resumable");
await writeDelete(platform, deleteChat);
assert.equal(
  await resumableCheckpoint(platform, deleteChat),
  null,
  "a deleted session's pause is not resurrected",
);

// ── 5. a torn flush refuses to restore ───────────────────────────────────
const tornChat = "web:torn-test";
const loggerE = await restoreLogger();
const pausedE = await knit(tree(), { models, logger: loggerE, sessionId: tornChat });
assert.equal(pausedE.status, "waiting");
await loggerE.flush();
const tornCp = (await loadCheckpointRow(platform, pausedE.continuation!))!;
await deleteCallRow(platform, Number(tornCp.seq));

const loggerF = await restoreLogger();
const torn = await loggerF.restore(tornCp.id);
assert.equal(torn.ok, false, "a pause row missing from the log cannot restore");
assert.match((torn as { reason: string }).reason, /pause row .* missing/);

console.log("web-session-restore: ok");
