/**
 * Old turn markers regain their visual bubbles.
 *
 * The incident this guards: the contacts.graph app drew its graph from an
 * emit carrying `{ text, component: "ui.mjs", props }`. The turn was persisted
 * by a build that predated component bubbles, so its marker had no
 * `components` field — replay degraded the bubble to text forever even though
 * the run log's raw emit row still held the full value. `getTurns` now
 * rehydrates components from those rows for old markers, and never overrides a
 * marker that already carries the field.
 *
 * Run: `npm run test:turn-components`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNodePlatform } from "../src/platform/node.js";
import {
  appendEvents,
  getTurns,
  writeTurnEnd,
} from "../web/src/agent/log-store.ts";
import type { TurnMarker } from "../web/src/web-log-types.ts";

const dir = await mkdtemp(path.join(os.tmpdir(), "gpb-turn-components-"));
const workspace = path.join(dir, "workspace");
// A registered app tree, so the replay attributes the emits like a live run.
await mkdir(path.join(workspace, "app/contacts/app/graph"), { recursive: true });
await writeFile(path.join(workspace, "app/contacts/app/graph/tree.prod.mjs"), "export default null;\n");
const platform = createNodePlatform(workspace);

const PROPS = {
  title: "Who knows whom",
  contacts: [{ id: "1", name: "Ada", type: "person" }],
  relationships: [],
  truncated: false,
};

function marker(over: Partial<TurnMarker>): TurnMarker {
  return {
    key: "web:test",
    turnId: "turn-1",
    runId: "run-1",
    fromSeq: null,
    toSeq: null,
    input: "draw my network",
    inputApp: "trunk",
    status: "done",
    error: null,
    output: "contacts.graph — 1 contact, 0 relationships.",
    emits: ["input: 1 contact / 0 relationships", "contacts.graph — 1 contact, 0 relationships."],
    levels: ["machine", null],
    emitApps: ["contacts", "contacts"],
    buttons: [],
    awaiting: "trunk",
    startedAt: 1,
    endedAt: 2,
    ts: 2,
    ...over,
  };
}

// ── turn 1: old marker, no `components` field ──────────────────────────
await appendEvents(platform, [
  { run_id: "run-1", definition_id: "tree", seq: 1, kind: "tree_enter", content: { tool: "contacts.graph" } },
  {
    run_id: "run-1",
    definition_id: "tree",
    seq: 2,
    kind: "emit",
    content: { child: "input", value: { text: "input: 1 contact / 0 relationships", level: "machine" } },
  },
  {
    run_id: "run-1",
    definition_id: "tree",
    seq: 3,
    kind: "emit",
    content: {
      child: "graph",
      value: { text: "contacts.graph — 1 contact, 0 relationships.", component: "ui.mjs", props: PROPS },
    },
  },
  { run_id: "run-1", definition_id: "tree", seq: 4, kind: "tree_exit", content: { tool: "contacts.graph" } },
]);
await writeTurnEnd(platform, marker({}));

let turns = await getTurns(platform, "web:test", { withEvents: true });
assert.equal(turns.length, 1, "one turn");
assert.deepEqual(
  turns[0].components?.map((c) => (c ? c.src : null)),
  [null, "ui.mjs"],
  "old marker: components rehydrated from the run log, aligned with emits",
);
assert.deepEqual(turns[0].components?.[1]?.props, PROPS, "the view props survive the replay");
assert.deepEqual(
  turns[0].emitApps,
  ["contacts.graph", "contacts.graph"],
  "replayed attribution still wins for the tile",
);

// ── turn 2: marker WITH components — never overridden by the log ───────
await appendEvents(platform, [
  { run_id: "run-2", definition_id: "tree", seq: 10, kind: "tree_enter", content: { tool: "contacts.graph" } },
  {
    run_id: "run-2",
    definition_id: "tree",
    seq: 11,
    kind: "emit",
    content: {
      child: "graph",
      value: { text: "logged", component: "logged.mjs", props: { from: "log" } },
    },
  },
  { run_id: "run-2", definition_id: "tree", seq: 12, kind: "tree_exit", content: { tool: "contacts.graph" } },
]);
const stored = [{ src: "marker.mjs", props: { from: "marker" } }, null];
await writeTurnEnd(
  platform,
  marker({
    turnId: "turn-2",
    runId: "run-2",
    emits: ["logged"],
    levels: [null],
    emitApps: ["contacts.graph"],
    components: stored,
  }),
);

turns = await getTurns(platform, "web:test", { withEvents: true });
assert.equal(turns.length, 2, "two turns");
assert.deepEqual(turns[1].components, stored, "a marker that carries components wins over the replay");

await rm(dir, { recursive: true, force: true });
console.log("turn-components: ok — old markers regain their views; stored components win");
