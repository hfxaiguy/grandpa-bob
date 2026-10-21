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
const e3 = ev("tool_result", { result: "ok" }, 3);
turn.events.push(e3);
const after = streamLines([turn]);
assert.equal(after.length, 3);
for (let i = 0; i < before.length; i++) {
  assert.equal(after[i], before[i], `row ${i} kept its identity across the new event`);
}
assert.equal(after[2], describeEvent(e3));

console.log("ui describe: event lines are stable across arrivals ✔");
