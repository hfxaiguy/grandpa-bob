/**
 * Chat queue: messages typed while a turn is running start one at a time.
 *
 * The browser backend owns the queue, not the composer, so both the web UI and
 * the Telegram bridge share one ordering rule: a session never runs two turns
 * at once and a queued message never overtakes the turn that was already
 * running. This drives `createLocalBackend` with a fake agent whose runs resolve
 * by hand — no browser, no network, no model.
 *
 *   1. the first message starts immediately (`queued: false`);
 *   2. messages sent mid-turn queue in submission order (`queued: true`,
 *      position 1, 2) and `/api/turns` exposes the queue;
 *   3. cancelling a queued message removes it and broadcasts the change;
 *   4. finishing the running turn starts the remaining queue one item at a
 *      time, in order, with exactly one run in flight;
 *   5. Stop clears the queue as well as stopping the running turn.
 *
 * Run: npm run test:chat-queue
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentClient } from "../web/src/agent/agent-client.ts";
import { createLocalBackend } from "../web/src/server/local-backend.ts";
import { createNodePlatform } from "../src/platform/node.ts";
import { AgentStoppedError } from "../web/src/stop-error.ts";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-chat-queue-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const platform = createNodePlatform(ws);

interface PendingRun {
  id: number;
  task: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const runs: PendingRun[] = [];
const tasks: string[] = [];
const markers: Array<Record<string, unknown>> = [];
let lastAwaiting: string | null = null;
let nextRunId = 1;

/** Resolve `after` ms later, so pending microtasks (the queue drain) run. */
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, fn: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

const agent = {
  run(opts: { task?: string }) {
    const id = nextRunId++;
    const task = String(opts.task ?? "");
    tasks.push(task);
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    }) as Promise<unknown> & { runId: number };
    promise.runId = id;
    runs.push({ id, task, resolve, reject });
    return promise;
  },
  async log<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    switch (op) {
      case "listSessions":
        return [] as T;
      case "lastAwaiting":
        return lastAwaiting as T;
      case "turns":
        return [...markers] as T;
      case "memoryWrites":
        return [] as T;
      case "turnEnd": {
        const marker = payload.marker as Record<string, unknown>;
        markers.push(marker);
        lastAwaiting = typeof marker.awaiting === "string" ? marker.awaiting : null;
        return null as T;
      }
      case "labelOf":
        return "" as T;
      case "hasSession":
        return true as T;
      case "turnCount":
        return 0 as T;
      case "hasLabelPin":
        return false as T;
      default:
        return null as T;
    }
  },
  stop(id?: number) {
    const at = runs.findIndex((run) => run.id === id);
    if (at < 0) return;
    const [run] = runs.splice(at, 1);
    run.reject(new AgentStoppedError());
  },
} as unknown as AgentClient;

const backend = createLocalBackend({
  agent,
  platform,
  env: {},
  remote: "",
  initialPattern: "trunk",
});

const events: Array<Record<string, unknown>> = [];
backend.subscribe((msg) => events.push(msg));

const post = (pathname: string, body: unknown) =>
  backend.request("POST", pathname, new URLSearchParams(), JSON.stringify(body));
const turns = () => backend.request("GET", "/api/turns", new URLSearchParams(), null);

const finish = (task: string): void => {
  const at = runs.findIndex((run) => run.task === task);
  assert.ok(at >= 0, `a run for "${task}" is in flight`);
  const [run] = runs.splice(at, 1);
  run.resolve({ result: `reply to ${task}`, emits: [{ text: `reply to ${task}` }], events: [], mode: "fresh" });
};

// ── 1. an idle session starts its first message immediately ──────────────
const first = await post("/api/chat", { text: "one" });
assert.equal(first.status, 200);
assert.equal((first.body as { queued?: boolean }).queued, false, "the first message starts at once");
const firstId = (first.body as { turnId: string }).turnId;

await waitFor("the first run", () => runs.find((run) => run.task === "one"));
assert.equal(runs.length, 1, "exactly one run is in flight");

// ── 2. mid-turn messages queue in order and are visible ──────────────────
const second = await post("/api/chat", { text: "two" });
const third = await post("/api/chat", { text: "three" });
assert.equal((second.body as { queued?: boolean }).queued, true, "the second message queues");
assert.equal((second.body as { position?: number }).position, 1);
assert.equal((third.body as { position?: number }).position, 2);
assert.deepEqual(tasks, ["one"], "queueing did not start a second run");

const listed = await turns();
assert.deepEqual(
  ((listed.body as { queued?: Array<{ text: string }> }).queued ?? []).map((q) => q.text),
  ["two", "three"],
  "the turns endpoint exposes the pending messages",
);
const secondId = (second.body as { turnId: string }).turnId;

// ── 3. a queued message can be cancelled ─────────────────────────────────
const cancelled = await post("/api/chat/queue/cancel", { turnId: secondId });
assert.equal(cancelled.status, 200);
const afterCancel = await turns();
assert.deepEqual(
  ((afterCancel.body as { queued?: Array<{ text: string }> }).queued ?? []).map((q) => q.text),
  ["three"],
  "cancelling removes only that message",
);
assert.ok(
  events.some((e) => e.type === "turn_queue_cancelled" && e.turnId === secondId),
  "the cancellation is broadcast",
);

// A message that already started cannot be cancelled (the UI then drops it on
// the turn_start frame instead).
const tooLate = await post("/api/chat/queue/cancel", { turnId: firstId });
assert.equal(tooLate.status, 404, "the running turn is not in the queue");

// ── 4. the queue drains in order, one run at a time ──────────────────────
finish("one");
const next = await waitFor("the queued run", () => runs.find((run) => run.task === "three"));
assert.equal(runs.length, 1, "the queued turn starts alone");
assert.deepEqual(tasks, ["one", "three"], "the cancelled message never ran");
assert.ok(
  events.some((e) => e.type === "turn_dequeued" && e.turnId === (third.body as { turnId: string }).turnId),
  "starting a queued turn is broadcast",
);

finish("three");
await waitFor("both turn markers", () => markers.length === 2);
const drained = await turns();
assert.deepEqual((drained.body as { queued?: unknown[] }).queued, [], "the queue is empty after draining");
assert.deepEqual(
  markers.map((m) => m.output),
  ["reply to one", "reply to three"],
  "the drained turn kept submission order",
);

// ── 5. stop clears what is waiting behind the running turn ───────────────
await post("/api/chat", { text: "four" });
await waitFor("the fourth run", () => runs.find((run) => run.task === "four"));
await post("/api/chat", { text: "five" });
await post("/api/chat", { text: "six" });
const stopped = await post("/api/chat/stop", {});
assert.equal(stopped.status, 200);
assert.equal((stopped.body as { cleared?: number }).cleared, 2, "both waiting messages were cleared");
const afterStop = await turns();
assert.deepEqual((afterStop.body as { queued?: unknown[] }).queued, [], "stop leaves no queued messages");
assert.ok(
  events.some((e) => e.type === "turn_queue_cleared"),
  "clearing the queue is broadcast",
);
await waitFor("the stopped run to settle", () => markers.length === 3);
assert.equal(markers[2].status, "stopped", "the current turn stopped");

console.log("chat queue: ok — immediate start, ordered drain, cancel, stop clears");
await fs.rm(ws, { recursive: true, force: true });
// The local backend keeps a visibility-aware bridge poll alive (unref'ed after
// its first tick); exit explicitly like the other backend-level tests.
process.exit(0);
