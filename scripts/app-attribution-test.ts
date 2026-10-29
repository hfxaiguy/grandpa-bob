/**
 * App attribution — demultiplexing one turn's stream into per-app tiles.
 *
 * A turn enters tree tools (apps); every event, emit, and memory write between
 * `tree_enter` and its matching exit belongs to that app, and a `tree_suspend`
 * marks the app that owns the human-input pause — including a RESUMED turn,
 * whose pre-re-entry rows belong to the app the previous turn paused in
 * (`seedPausedApp`).
 *
 * This is the pure unit half of the old Node admin harness: the module moved
 * to `web/src/app-attribution.ts` with the browser agent host, and the admin
 * HTTP harness died with the Node agent. Run: `npm run test:app-attribution`.
 */
import assert from "node:assert/strict";
import { newTurnApps, seedPausedApp, tagEventApp, retagEvents } from "../web/src/app-attribution.js";

// ── the app stack walk ──
const st = newTurnApps();
assert.equal(tagEventApp(st, { kind: "llm_call" }), "trunk", "top level is trunk");
assert.equal(tagEventApp(st, { kind: "tree_enter", content: { tool: "contacts" } }), "contacts");
assert.equal(
  tagEventApp(st, { kind: "tree_enter", content: { tool: "contacts_query" } }),
  "contacts",
  "a capability stays with its app",
);
assert.equal(tagEventApp(st, { kind: "record", content: { op: "memoryUpdate" } }), "contacts", "inside the capability");
assert.equal(
  tagEventApp(st, { kind: "tree_exit", content: { tool: "contacts_query" } }),
  "contacts",
  "the capability's exit is the app's event",
);
assert.equal(tagEventApp(st, { kind: "llm_call" }), "contacts", "back to the app after the capability exits");
assert.equal(tagEventApp(st, { kind: "tree_exit", content: { tool: "contacts" } }), "contacts");
assert.equal(tagEventApp(st, { kind: "llm_call" }), "trunk", "back to trunk");

const st2 = newTurnApps();
tagEventApp(st2, { kind: "tree_enter", content: { tool: "email" } });
tagEventApp(st2, { kind: "tree_enter", content: { tool: "draft_email" } });
assert.equal(
  tagEventApp(st2, { kind: "tree_suspend", content: { tool: "draft_email" } }),
  "email",
  "a pause inside a capability is the app's pause",
);
assert.equal(st2.suspended, "email", "suspend records the app, not the capability");

const evs: { kind?: string; content?: unknown; app?: string }[] = [
  { kind: "llm_call" },
  { kind: "emit" },
  { kind: "tree_enter", content: { tool: "contacts" } },
  { kind: "emit" },
  { kind: "tree_exit", content: { tool: "contacts" } },
];
const r = retagEvents(evs);
assert.deepEqual(evs.map((e) => e.app), ["trunk", "trunk", "contacts", "contacts", "contacts"], "retag walks the stored stream");
assert.deepEqual(r.emitApps, ["trunk", "contacts"], "emitApps recovered in order");

// Registry mode — a nested APP is its own boundary, while a tree tool inside
// it that is not an app stays with it.
const apps = ["enrich-profile", "contacts", "email"];
const st3 = newTurnApps(apps);
assert.equal(tagEventApp(st3, { kind: "tree_enter", content: { tool: "enrich-profile" } }), "enrich-profile");
assert.equal(tagEventApp(st3, { kind: "tree_enter", content: { tool: "contacts" } }), "contacts", "a nested app opens its own tile");
assert.equal(tagEventApp(st3, { kind: "record", content: { op: "memoryUpdate" } }), "contacts", "its events stay on its tile");
assert.equal(
  tagEventApp(st3, { kind: "tree_enter", content: { tool: "contacts_query" } }),
  "contacts",
  "a capability inside the nested app stays with it",
);
assert.equal(tagEventApp(st3, { kind: "tree_exit", content: { tool: "contacts" } }), "contacts");
assert.equal(tagEventApp(st3, { kind: "llm_call" }), "enrich-profile", "back to the calling app after the nested app exits");
assert.equal(tagEventApp(st3, { kind: "tree_exit", content: { tool: "enrich-profile" } }), "enrich-profile");
assert.equal(tagEventApp(st3, { kind: "llm_call" }), "trunk", "back to trunk");

// A pause inside a nested app belongs to the nested app (its own input box).
const st4 = newTurnApps(apps);
tagEventApp(st4, { kind: "tree_enter", content: { tool: "enrich-profile" } });
tagEventApp(st4, { kind: "tree_enter", content: { tool: "contacts" } });
assert.equal(
  tagEventApp(st4, { kind: "tree_suspend", content: { tool: "contacts" } }),
  "contacts",
  "a nested app owns its own human-input pause",
);

// A tree marked ownTile is a boundary even when the registry does not know it.
const st5 = newTurnApps();
tagEventApp(st5, { kind: "tree_enter", content: { tool: "email" } });
assert.equal(
  tagEventApp(st5, { kind: "tree_enter", content: { tool: "chatty", ownTile: true } }),
  "chatty",
  "an ownTile tree opens its own tile",
);
assert.equal(tagEventApp(st5, { kind: "tree_exit", content: { tool: "chatty", ownTile: true } }), "chatty");
assert.equal(tagEventApp(st5, { kind: "llm_call" }), "email", "back to the app after a marked tree exits");

// Legacy mode folds a nested app into the outermost tree.
const st6 = newTurnApps();
tagEventApp(st6, { kind: "tree_enter", content: { tool: "enrich-profile" } });
assert.equal(
  tagEventApp(st6, { kind: "tree_enter", content: { tool: "contacts" } }),
  "enrich-profile",
  "without the registry, a nested app stays with the first tree",
);

// retagEvents with the registry recovers the nested app's tile.
const evs2: { kind?: string; content?: unknown; app?: string }[] = [
  { kind: "tree_enter", content: { tool: "enrich-profile" } },
  { kind: "emit" },
  { kind: "tree_enter", content: { tool: "contacts" } },
  { kind: "emit" },
  { kind: "tree_exit", content: { tool: "contacts" } },
  { kind: "emit" },
  { kind: "tree_exit", content: { tool: "enrich-profile" } },
];
const r2 = retagEvents(evs2, undefined, apps);
assert.deepEqual(
  evs2.map((e) => e.app),
  ["enrich-profile", "enrich-profile", "contacts", "contacts", "contacts", "enrich-profile", "enrich-profile"],
  "retag puts the nested app's run on the nested app's tile",
);
assert.deepEqual(r2.emitApps, ["enrich-profile", "contacts", "enrich-profile"], "emitApps carries the nested app");

// ── resume seed: a paused walk's pre-re-entry rows ──
const st7 = newTurnApps(apps);
seedPausedApp(st7, "contacts");
assert.equal(
  tagEventApp(st7, { kind: "human", content: { delivered: true, value: "left vm" } }),
  "contacts",
  "the delivered human row belongs to the paused app",
);
assert.equal(tagEventApp(st7, { kind: "tree_enter", content: { tool: "contacts" } }), "contacts", "the real re-entry stays on the app");
assert.equal(tagEventApp(st7, { kind: "tree_enter", content: { tool: "enrich-profile" } }), "enrich-profile", "a nested app keeps its own tile");
assert.equal(tagEventApp(st7, { kind: "llm_call" }), "enrich-profile", "the nested app's rows stay on its tile");
assert.equal(tagEventApp(st7, { kind: "tree_exit", content: { tool: "enrich-profile" } }), "enrich-profile");
assert.equal(tagEventApp(st7, { kind: "llm_call" }), "contacts", "after the nested app exits, still inside the resumed app");
assert.equal(tagEventApp(st7, { kind: "tree_exit", content: { tool: "contacts" } }), "contacts", "the walk's exit is its own completion");
assert.equal(tagEventApp(st7, { kind: "emit" }), "trunk", "once the walk closes, later events are the trunk's again");

// The real entry replaces the seed; the exit retires it.
const st8 = newTurnApps(apps);
seedPausedApp(st8, "contacts");
tagEventApp(st8, { kind: "tree_enter", content: { tool: "contacts" } });
assert.equal(st8.stack.length, 1, "the real entry replaces the seed");
tagEventApp(st8, { kind: "tree_exit", content: { tool: "contacts" } });
assert.equal(st8.stack.length, 0, "the walk's exit leaves no stale boundary");

// Only an app pause seeds.
const st9 = newTurnApps(apps);
seedPausedApp(st9, "trunk");
seedPausedApp(st9, null);
seedPausedApp(st9, undefined);
assert.equal(st9.stack.length, 0, "trunk/absent pauses seed nothing");

console.log("app-attribution: app stack walk, nested apps, retag and resume seed OK");
process.exit(0);
