/**
 * Inline app-call cards: the fold that turns a turn's attributed events into
 * the smaller app tiles a caller's chat shows.
 *
 * The same turn must read correctly for every conversation:
 *  - trunk → contacts is one card on trunk, carrying contacts' bubbles;
 *  - contacts → contacts.graph is one card inside the contacts card, never a
 *    second card on trunk;
 *  - a silent app still gets a card (its status is the message);
 *  - a suspended app is "waiting", a failed exit is "error";
 *  - old turns without replay events still group by `emitApps` + hierarchy.
 *
 * Run: `npm run test:app-calls`.
 */
import assert from "node:assert/strict";
import { appCallKey, appCallsFor, callAnchor, firstEmitIndex } from "../ui/src/app-calls.ts";
import type { SanitizedEvent, Turn } from "../ui/src/types.ts";

const apps = [
  { name: "trunk", description: "" },
  { name: "contacts", description: "" },
  { name: "email", description: "" },
  { name: "contacts.graph", description: "", parent: "contacts" },
];

const ev = (
  kind: string,
  content: Record<string, unknown> | null,
  app: string,
  seq: number,
): SanitizedEvent => ({
  kind,
  branch_path: "",
  iteration: 0,
  scope_id: null,
  content,
  ts: seq,
  seq,
  app,
});

const turn = (events: SanitizedEvent[], over: Partial<Turn> = {}): Turn => ({
  turnId: "t1",
  input: "do it",
  inputApp: "trunk",
  startedAt: 1,
  endedAt: null,
  status: "done",
  error: null,
  output: null,
  emits: [],
  emitApps: [],
  levels: [],
  events,
  ...over,
});

// ── trunk calls contacts: one inline card, its own bubble ────────────────
{
  const t = turn(
    [
      ev("tree_enter", { tool: "contacts" }, "contacts", 1),
      ev("emit", { child: "reply", value: { text: "Ada <ada@example.com>" } }, "contacts", 2),
      ev("tree_exit", { tool: "contacts" }, "contacts", 3),
    ],
    { emits: ["Ada <ada@example.com>"], emitApps: ["contacts"] },
  );
  const calls = appCallsFor(t, "trunk", apps);
  assert.equal(calls.length, 1, "one app call");
  assert.equal(calls[0].app, "contacts");
  assert.deepEqual(calls[0].emits, [0], "the app's bubble belongs to the card");
  assert.equal(calls[0].status, "done");
  assert.equal(calls[0].children.length, 0);
  assert.equal(firstEmitIndex(calls[0]), 0);
  assert.equal(callAnchor(calls[0]), 0, "a single call stays at its first bubble");
  assert.deepEqual(appCallsFor(t, "contacts", apps), [], "the caller keeps no card for itself");
}

// ── re-entering an app moves its card to the newest call point ───────────
{
  const t = turn(
    [
      ev("emit", { child: "reply", value: { text: "intro" } }, "trunk", 1),
      ev("tree_enter", { tool: "contacts" }, "contacts", 2),
      ev("emit", { child: "reply", value: { text: "first" } }, "contacts", 3),
      ev("tree_exit", { tool: "contacts" }, "contacts", 4),
      ev("emit", { child: "reply", value: { text: "middle" } }, "trunk", 5),
      ev("tree_enter", { tool: "contacts" }, "contacts", 6),
      ev("emit", { child: "reply", value: { text: "second" } }, "contacts", 7),
      ev("tree_exit", { tool: "contacts" }, "contacts", 8),
    ],
    {
      emits: ["intro", "first", "middle", "second"],
      emitApps: ["trunk", "contacts", "trunk", "contacts"],
    },
  );
  const calls = appCallsFor(t, "trunk", apps);
  assert.deepEqual(calls.map((c) => c.app), ["contacts"], "one card for both calls");
  assert.deepEqual(calls[0].emits, [1, 3], "the card carries both invocations' bubbles");
  assert.equal(firstEmitIndex(calls[0]), 1);
  assert.equal(callAnchor(calls[0]), 3, "the card moves to the second entry, after 'middle'");
}

// ── an empty emit produces no bubble and does not shift the entry point ──
{
  const t = turn(
    [
      ev("emit", { child: "reply", value: { text: "intro" } }, "trunk", 1),
      ev("emit", { child: "reply", value: { text: "" } }, "trunk", 2),
      ev("tree_enter", { tool: "contacts" }, "contacts", 3),
      ev("emit", { child: "reply", value: { text: "first" } }, "contacts", 4),
      ev("tree_exit", { tool: "contacts" }, "contacts", 5),
      ev("emit", { child: "reply", value: { text: "middle" } }, "trunk", 6),
      ev("tree_enter", { tool: "contacts" }, "contacts", 7),
      ev("emit", { child: "reply", value: { text: "second" } }, "contacts", 8),
      ev("tree_exit", { tool: "contacts" }, "contacts", 9),
    ],
    {
      emits: ["intro", "first", "middle", "second"],
      emitApps: ["trunk", "contacts", "trunk", "contacts"],
    },
  );
  const calls = appCallsFor(t, "trunk", apps);
  assert.deepEqual(calls[0].emits, [1, 3]);
  assert.equal(callAnchor(calls[0]), 3, "an empty emit is not a bubble in the transcript");
}

// ── a silent re-entry still moves the card to where it was re-entered ────
{
  const t = turn(
    [
      ev("emit", { child: "reply", value: { text: "intro" } }, "trunk", 1),
      ev("tree_enter", { tool: "contacts" }, "contacts", 2),
      ev("emit", { child: "reply", value: { text: "first" } }, "contacts", 3),
      ev("tree_exit", { tool: "contacts" }, "contacts", 4),
      ev("emit", { child: "reply", value: { text: "middle" } }, "trunk", 5),
      ev("tree_enter", { tool: "contacts" }, "contacts", 6),
      ev("tree_exit", { tool: "contacts" }, "contacts", 7),
    ],
    {
      emits: ["intro", "first", "middle"],
      emitApps: ["trunk", "contacts", "trunk"],
    },
  );
  const calls = appCallsFor(t, "trunk", apps);
  assert.equal(callAnchor(calls[0]), 3, "a re-entry with no bubbles trails its caller's last row");
}

// ── a capped event tail still maps an entry onto the durable emit list ───
{
  const t = turn(
    [
      ev("tree_enter", { tool: "contacts" }, "contacts", 11),
      ev("emit", { child: "reply", value: { text: "first" } }, "contacts", 12),
      ev("tree_exit", { tool: "contacts" }, "contacts", 13),
      ev("emit", { child: "reply", value: { text: "middle" } }, "trunk", 14),
      ev("tree_enter", { tool: "contacts" }, "contacts", 15),
      ev("emit", { child: "reply", value: { text: "second" } }, "contacts", 16),
      ev("tree_exit", { tool: "contacts" }, "contacts", 17),
    ],
    {
      emits: ["before", "also before", "first", "middle", "second"],
      emitApps: ["trunk", "trunk", "contacts", "trunk", "contacts"],
    },
  );
  const calls = appCallsFor(t, "trunk", apps);
  assert.deepEqual(calls[0].emits, [2, 4]);
  assert.equal(
    callAnchor(calls[0]),
    4,
    "the tail's emits are indexed from the end of the full emit list",
  );
}

// ── a tail that starts after the first entry still recognises the re-entry ─
{
  const t = turn(
    [
      ev("emit", { child: "reply", value: { text: "first" } }, "contacts", 11),
      ev("emit", { child: "reply", value: { text: "middle" } }, "trunk", 12),
      ev("tree_enter", { tool: "contacts" }, "contacts", 13),
      ev("emit", { child: "reply", value: { text: "second" } }, "contacts", 14),
      ev("tree_exit", { tool: "contacts" }, "contacts", 15),
    ],
    {
      emits: ["before", "also before", "first", "middle", "second"],
      emitApps: ["trunk", "trunk", "contacts", "trunk", "contacts"],
    },
  );
  const calls = appCallsFor(t, "trunk", apps);
  assert.deepEqual(calls[0].emits, [2, 4]);
  assert.equal(
    callAnchor(calls[0]),
    4,
    "a bubble before the visible entry proves the card is a re-entry",
  );
}

// ── contacts calls contacts.graph: nested inside the contacts card ───────
{
  const t = turn(
    [
      ev("tree_enter", { tool: "contacts" }, "contacts", 1),
      ev("emit", { child: "reply", value: { text: "one contact" } }, "contacts", 2),
      ev("tree_enter", { tool: "contacts.graph" }, "contacts.graph", 3),
      ev("emit", { child: "graph", value: { text: "graph drawn" } }, "contacts.graph", 4),
      ev("tree_exit", { tool: "contacts.graph" }, "contacts.graph", 5),
      ev("tree_exit", { tool: "contacts" }, "contacts", 6),
    ],
    {
      emits: ["one contact", "graph drawn"],
      emitApps: ["contacts", "contacts.graph"],
    },
  );
  const onTrunk = appCallsFor(t, "trunk", apps);
  assert.deepEqual(onTrunk.map((c) => c.app), ["contacts"], "the grandchild never boards trunk");
  assert.deepEqual(onTrunk[0].emits, [0], "trunk's card only carries contacts' own bubble");
  assert.deepEqual(onTrunk[0].children.map((c) => c.app), ["contacts.graph"], "the graph hangs under contacts");
  assert.deepEqual(onTrunk[0].children[0].emits, [1]);
  assert.equal(onTrunk[0].children[0].status, "done");

  const onContacts = appCallsFor(t, "contacts", apps);
  assert.deepEqual(onContacts.map((c) => c.app), ["contacts.graph"], "contacts sees its direct child");
  assert.deepEqual(onContacts[0].emits, [1]);
}

// ── a silent app still gets a card, and a failure keeps its error ────────
{
  const silent = turn([
    ev("tree_enter", { tool: "contacts" }, "contacts", 1),
    ev("tree_exit", { tool: "contacts" }, "contacts", 2),
  ]);
  const calls = appCallsFor(silent, "trunk", apps);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].emits, []);
  assert.equal(calls[0].status, "done");

  const failed = turn([
    ev("tree_enter", { tool: "email" }, "email", 1),
    ev("tree_exit", { tool: "email", error: true }, "email", 2),
  ]);
  assert.equal(appCallsFor(failed, "trunk", apps)[0].status, "error");

  const running = turn([ev("tree_enter", { tool: "email" }, "email", 1)], { status: "running" });
  assert.equal(appCallsFor(running, "trunk", apps)[0].status, "running");
}

// ── a suspended app waits; a resumed app re-entry is not a self-card ─────
{
  const paused = turn(
    [ev("tree_enter", { tool: "contacts" }, "contacts", 1), ev("tree_suspend", { tool: "contacts" }, "contacts", 2)],
    { status: "running", awaiting: "contacts" },
  );
  assert.equal(appCallsFor(paused, "trunk", apps)[0].status, "waiting");

  const resumed = turn(
    [
      ev("tree_enter", { tool: "contacts" }, "contacts", 1),
      ev("tree_enter", { tool: "contacts.graph" }, "contacts.graph", 2),
      ev("emit", { child: "graph", value: { text: "drawn" } }, "contacts.graph", 3),
      ev("tree_exit", { tool: "contacts.graph" }, "contacts.graph", 4),
      ev("tree_exit", { tool: "contacts" }, "contacts", 5),
    ],
    {
      inputApp: "contacts",
      emits: ["drawn"],
      emitApps: ["contacts.graph"],
    },
  );
  const calls = appCallsFor(resumed, "contacts", apps);
  assert.deepEqual(calls.map((c) => c.app), ["contacts.graph"], "the resumed app does not call itself");
  assert.deepEqual(calls[0].emits, [0]);
}

// ── no replay events (old turns): group by emit tag + hierarchy ──────────
{
  const old = turn([], {
    emits: ["one", "two"],
    emitApps: ["contacts", "email"],
  });
  const calls = appCallsFor(old, "trunk", apps);
  assert.deepEqual(calls.map((c) => c.app).sort(), ["contacts", "email"], "top-level apps become cards");
  assert.deepEqual(calls.find((c) => c.app === "contacts")?.emits, [0]);
  assert.deepEqual(calls.find((c) => c.app === "email")?.emits, [1]);
  assert.deepEqual(appCallsFor(old, "contacts", apps), [], "another top-level app is not contacts' child");
}

// ── cards are stable until something changes ─────────────────────────────
{
  const t = turn([
    ev("tree_enter", { tool: "contacts" }, "contacts", 1),
    ev("tree_exit", { tool: "contacts" }, "contacts", 2),
  ]);
  const a = appCallsFor(t, "trunk", apps)[0];
  const b = appCallsFor(t, "trunk", apps)[0];
  assert.equal(appCallKey(a), appCallKey(b), "same call, same cache identity");
  assert.notEqual(appCallKey(a), appCallKey({ ...b, status: "running" }), "status changes the identity");
  assert.notEqual(appCallKey(a), appCallKey({ ...b, emits: [3] }), "bubbles change the identity");
}

console.log("app-calls: inline caller cards, nested sub-calls, statuses, and old-turn fallback ok");
