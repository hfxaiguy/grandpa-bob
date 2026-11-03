/**
 * Event-line identity for the tiled UI.
 *
 * The event logs render `describeEvent` output with Solid's `<For>`, which
 * diffs by reference. Returning a fresh object per call made every incoming
 * SSE event remount every row — which closed an opened `<details>` row (and
 * discarded its fetched full payload) mid-run. Lines must be stable for the
 * same event object, and `streamLines` must keep earlier rows' references when
 * a new event arrives.
 *
 * Run: `npm run test:ui-describe`.
 */
import assert from "node:assert/strict";
import { describeEvent, streamLines } from "../ui/src/describe.ts";
import { memoryNotesForTurn } from "../ui/src/memory-notes.ts";
import type { SanitizedEvent, Turn } from "../ui/src/types.ts";

const ev = (
  kind: string,
  content: Record<string, unknown> | null,
  seq: number,
  app = "trunk",
): SanitizedEvent => ({
  kind,
  branch_path: "",
  iteration: 0,
  scope_id: null,
  content,
  ts: 1,
  seq,
  app,
});

// A delivered human event shows what the user said, not the slot name — that
// is what makes the first row under a turn divider meaningful.
const said = describeEvent(ev("human", { child: "main_input", delivered: true, value: "call mom" }, 9));
assert.equal(said.text, "call mom");
const paused = describeEvent(ev("human", { child: "main_input", context: "waiting" }, 10));
assert.equal(paused.text, "main_input");

// Same event object → the exact same line object, every call.
const toolEv = ev("tool_call", { tool: "contacts_query", args: "{}" }, 7, "contacts");
const first = describeEvent(toolEv);
assert.equal(describeEvent(toolEv), first);
assert.equal(describeEvent(toolEv), first);

// A distinct object with the same payload is its own line — identity is the
// key, so a refetch (new objects) deliberately remounts rather than aliasing.
const twin = ev("tool_call", { tool: "contacts_query", args: "{}" }, 7, "contacts");
assert.notEqual(describeEvent(twin), first);
assert.deepEqual(describeEvent(twin), first);

// Content stays correct through the cache.
assert.match(first.text, /contacts_query/);
assert.equal(first.app, "contacts");
const emit = describeEvent(ev("emit", { value: { text: "hello" } }, 8));
assert.equal(emit.emit, true);
assert.equal(emit.text, "hello");

// A new event during a run must not disturb earlier rows' identities — that
// is what keeps an opened row open.
const e1 = ev("llm_start", { child: "prompt", model: "m" }, 1);
const e2 = ev("tool_call", { tool: "t", args: "{}" }, 2);
const turn: Turn = {
  turnId: "t1",
  input: "",
  startedAt: 1,
  endedAt: null,
  status: "running",
  error: null,
  output: null,
  events: [e1, e2],
};
const before = streamLines([turn]);
// The stream opens with a turn divider, then the turn's events.
assert.equal(before.length, 3);
assert.equal(before[0].kind, "turn");
assert.equal(before[0].text, "turn 1");
const e3 = ev("tool_result", { result: "ok" }, 3);
turn.events.push(e3);
const after = streamLines([turn]);
assert.equal(after.length, 4);
for (let i = 0; i < before.length; i++) {
  assert.equal(after[i], before[i], `row ${i} kept its identity across the new event`);
}
assert.equal(after[2], describeEvent(e2));
assert.equal(after[3], describeEvent(e3));

// Turn numbering follows the loaded window.
const t2: Turn = { ...turn, turnId: "t2", events: [] };
const numbered = streamLines([turn, t2]);
assert.equal(numbered[0].text, "turn 1");
assert.equal(numbered.find((l) => l.kind === "turn" && l.text === "turn 2")?.text, "turn 2");

// Memory updates become chat lines anchored between the right bubbles; plain
// memory declarations are replayed every turn and stay out of the chat.
const memTurn: Turn = {
  turnId: "mem",
  input: "",
  startedAt: 1,
  endedAt: null,
  status: "running",
  error: null,
  output: null,
  emits: ["one", "two"],
  emitApps: ["trunk", "trunk"],
  events: [
    ev("emit", { value: { text: "one" } }, 10),
    ev("record", { op: "memory", child: "seed", value: "ignored" }, 11),
    ev("record", { op: "memoryUpdate", child: "mood", value: "happy" }, 12),
    ev("emit", { value: { text: "two" } }, 13),
    ev("record", { op: "memoryUpdate", child: "mood", value: "calm" }, 14, "contacts"),
  ],
};
assert.deepEqual(
  memoryNotesForTurn(memTurn, "trunk").map((n) => [n.anchor, n.note.child, n.note.value]),
  [[1, "mood", "happy"]],
  "a trunk update lands before the bubble that followed it",
);
assert.deepEqual(
  memoryNotesForTurn(memTurn, "contacts").map((n) => [n.anchor, n.note.child, n.note.value]),
  [[2, "mood", "calm"]],
  "updates stay on the app that wrote them",
);
// A capped event tail is re-based onto the turn's full emits list.
const tailTurn: Turn = { ...memTurn, emits: ["a", "b", "c", "d"], events: [memTurn.events[3], memTurn.events[4]] };
assert.deepEqual(
  memoryNotesForTurn(tailTurn, "contacts").map((n) => n.anchor),
  [4],
  "the first retained emit still counts from the turn's full list",
);

console.log("ui describe: event lines are stable across arrivals ✔");
