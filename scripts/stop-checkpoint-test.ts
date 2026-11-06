/**
 * Stop keeps the stopped turn's committed state in the session checkpoint.
 *
 * grandma-kat's resume rebuilds memory from the run log only up to the
 * checkpoint's pause row. A stopped run throws instead of pausing, so the
 * session's old continuation used to replay past everything the turn had
 * committed — including the user's message folded into `conversation`. The
 * next message then looked like the previous one had been dropped.
 *
 * `freezeStoppedCheckpoint` logs a synthetic pause at the stop point and makes
 * it the continuation. This test drives a real pausing tree:
 *
 *   1. A turn is stopped after its user message is folded and the model call
 *      started; the old pause checkpoint is superseded.
 *   2. A fresh logger (the reload case) restores the frozen checkpoint and
 *      resumes with the next message.
 *   3. The resumed run's `conversation` carries BOTH messages, plus the new
 *      reply — the stopped message is no longer dropped.
 *   4. A stop before the turn committed anything leaves the old pause alone.
 *
 * Node platform, no network, no browser. Run: npm run test:stop-checkpoint
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Tree,
  name,
  Human,
  Memory,
  Prompt,
  Until,
  goto,
  max,
  update,
  knit,
  resume,
} from "grandma-kat";
import { createNodePlatform } from "../src/platform/node.ts";
import { createWorkspaceLogger } from "../web/src/agent/logger.ts";
import { freezeStoppedCheckpoint } from "../web/src/agent/stopped-checkpoint.ts";
import { loadCheckpointRow, readRow, resumableCheckpoint, writeTurnEnd } from "../web/src/agent/log-store.ts";
import { AgentStoppedError } from "../web/src/stop-error.ts";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-stop-checkpoint-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const platform = createNodePlatform(ws);

/** The trunk's shape in miniature: pause, fold the message, ask, reply, loop. */
const tree = () =>
  Tree(
    name("stopped"),
    Memory("conversation", () => []),
    Human("start_input"),
    Memory(update(), "conversation", (m: Record<string, unknown>, cur: unknown) => [
      ...(Array.isArray(cur) ? cur : []),
      { role: "user", content: String(m.start_input) },
    ]),
    Prompt("reply", (m: Record<string, unknown>) => [
      { role: "system", content: "test" },
      ...(Array.isArray(m.conversation) ? m.conversation : []),
    ]),
    Memory(update(), "conversation", (m: Record<string, unknown>, cur: unknown) => [
      ...(Array.isArray(cur) ? cur : []),
      {
        role: "assistant",
        content: String((m.branch as Record<string, unknown> | undefined)?.reply ?? ""),
      },
    ]),
    Until(goto("start_input"), () => false, max(100)),
  );

let calls = 0;
const models = {
  default: {
    model: "mock",
    handler: async () => {
      calls += 1;
      if (calls === 1) throw new AgentStoppedError();
      return { content: `reply ${calls}` };
    },
  },
};

const chat = "web:stop-checkpoint";
const runLogger = async () => {
  const logger = createWorkspaceLogger(platform);
  await logger.ready;
  return logger;
};

// ── 1. stop after the turn committed its message ─────────────────────────
const loggerA = await runLogger();
const first = await knit(tree(), { models, logger: loggerA, sessionId: chat });
assert.equal(first.status, "waiting", "the tree pauses at start_input");
const oldId = first.continuation!;
const runId = oldId.split(":")[0];
await loggerA.flush();
await writeTurnEnd(platform, {
  key: chat,
  turnId: "turn-1",
  runId,
  input: "hello",
  fromSeq: 0,
  toSeq: null,
  status: "done",
  awaiting: "start_input",
  startedAt: Date.now() - 1000,
  endedAt: Date.now(),
  ts: Date.now(),
});

await assert.rejects(
  () => resume(oldId, { models, logger: loggerA, humanInput: "first message" }),
  AgentStoppedError,
  "the first model call is stopped",
);

const committed = loggerA
  .getEvents(runId)
  .filter((e) => e.kind === "record" && (e.content as { child?: string })?.child === "conversation");
assert.ok(committed.length >= 2, "the stopped turn logged its fold after the seed");
assert.deepEqual((committed.at(-1)?.content as { value?: unknown }).value, [
  { role: "user", content: "first message" },
]);

const frozenId = freezeStoppedCheckpoint(loggerA, oldId);
assert.ok(frozenId, "the stop point becomes the new continuation");
assert.equal(loggerA.getCheckpoint(oldId), null, "the superseded pause is gone from the live store");
await loggerA.flush();

const frozenSeq = Number(frozenId!.split(":")[1]);
const frozenRow = await readRow(platform, frozenSeq);
assert.equal(frozenRow?.kind, "human", "the frozen checkpoint points at a pause row");
assert.equal(
  (frozenRow?.content as { child?: string })?.child,
  "start_input",
  "the synthetic pause reuses the old human slot",
);
assert.equal((await loadCheckpointRow(platform, oldId)), null, "the old pause row is gone from the log DB");

// The backend writes the stopped turn's marker after the worker reports the
// stop; the frozen checkpoint is already on disk by then.
await writeTurnEnd(platform, {
  key: chat,
  turnId: "turn-2",
  runId,
  input: "first message",
  fromSeq: 0,
  toSeq: null,
  status: "stopped",
  awaiting: "start_input",
  startedAt: Date.now() - 500,
  endedAt: Date.now(),
  ts: Date.now(),
});

// ── 2. a fresh logger restores the frozen pause ──────────────────────────
const found = await resumableCheckpoint(platform, chat);
assert.equal(found?.checkpoint.id, frozenId, "the frozen pause is the chat's resumable checkpoint");

const loggerB = await runLogger();
const restored = await loggerB.restore(frozenId!);
assert.equal(restored.ok, true, `restore failed: ${restored.ok ? "" : restored.reason}`);

const second = await resume(frozenId!, { models, logger: loggerB, humanInput: "second message" });
assert.equal(second.status, "waiting", "the resumed tree paused again");
await loggerB.flush();

// ── 3. both messages survive in the folded conversation ──────────────────
const records = loggerB
  .getEvents(runId)
  .filter((e) => e.kind === "record" && (e.content as { child?: string })?.child === "conversation");
assert.deepEqual(
  (records.at(-1)?.content as { value?: unknown }).value,
  [
    { role: "user", content: "first message" },
    { role: "user", content: "second message" },
    { role: "assistant", content: "reply 2" },
  ],
  "the stopped message is still in the conversation after the next turn",
);
assert.equal(await loadCheckpointRow(platform, frozenId!), null, "the frozen pause was consumed by the resume");

// ── 4. a stop before anything was committed changes nothing ──────────────
const quietChat = "web:stop-checkpoint-quiet";
const quietLogger = await runLogger();
const quiet = await knit(tree(), { models, logger: quietLogger, sessionId: quietChat });
assert.equal(quiet.status, "waiting");
const quietId = quiet.continuation!;
assert.equal(freezeStoppedCheckpoint(quietLogger, quietId), null, "nothing after the pause, nothing to freeze");
assert.ok(quietLogger.getCheckpoint(quietId), "the original pause is left intact");
await quietLogger.flush();
assert.equal((await loadCheckpointRow(platform, quietId))?.id, quietId, "the DB checkpoint is untouched");

console.log("stop-checkpoint: all assertions passed");
