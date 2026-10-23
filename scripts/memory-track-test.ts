/**
 * Memory rebuild — the shared tracker + the raw run-log reader both hosts use.
 *
 * A memory panel is process/page state: the Node admin's map dies on restart,
 * the browser backend's on reload. Both rebuild it lazily from the persisted
 * run log (`WebLog.memoryWrites` / `log-store.memoryWrites`), so this pins the
 * pieces that make that correct:
 *
 *   1. A fresh tracker + rebuild reproduces the panel a running process had
 *      (the restart/reload path), and is one-shot per session afterwards.
 *   2. Raw values survive: a 1 000-char string is not truncated and a 7-element
 *      array is not collapsed into a summary (the sanitized event window would
 *      do both).
 *   3. The scan is not tail-capped: a memory write followed by 600 record rows
 *      (past MAX_TURN_EVENTS = 500) still rebuilds. The documented 500-event
 *      cap applies only to the sanitized per-turn event window.
 *   4. App attribution comes from the run's tree_enter/tree_exit, sessions
 *      stay isolated, `clear()` is final, and the LRU unseals evicted sessions.
 *
 * Run: npm run test:memory-track
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebLog } from "../src/web-log.ts";
import { createMemoryTracker, type MemoryWrite } from "../src/memory-track.ts";
import { createNodePlatform } from "../src/platform/node.ts";
import {
  appendEvents,
  memoryWrites as browserMemoryWrites,
  writeTurnEnd,
} from "../web/src/agent/log-store.ts";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-memory-track-"));
const logs = path.join(ws, "logs");
await fs.mkdir(logs, { recursive: true });
const dbPath = path.join(logs, "grandma-kat.db");

const SESSION = "web:restart";
const RUN = "run-restart";
const BIG = "x".repeat(1000);
const LIST = ["a", "b", "c", "d", "e", "f", "g"];

// The host ensures the schema (same shape as the engine logger).
new WebLog(dbPath, (k) => k).close();

const db = new DatabaseSync(dbPath);
const insert = db.prepare(
  `INSERT INTO calls (run_id, definition_id, seq, branch_path, iteration, scope_id, kind, content)
   VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
);
insert.run(RUN, "engine", 10001, "app-branch", null, "tree_enter", JSON.stringify({ tool: "contacts" }));
insert.run(RUN, "engine", 10002, "memory", 1, "record", JSON.stringify({ op: "memory", child: "big", value: BIG }));
insert.run(RUN, "engine", 10003, "memory", 2, "record", JSON.stringify({ op: "memoryUpdate", child: "list", value: LIST }));
// Far past MAX_TURN_EVENTS: a tail-window read would never see the writes above.
for (let i = 0; i < 600; i++) {
  insert.run(RUN, "engine", 10004 + i, "work", null, "record", JSON.stringify({ op: "toolResult", text: `noise ${i}` }));
}
insert.run(RUN, "engine", 10604, "app-branch", null, "tree_exit", JSON.stringify({ tool: "contacts" }));
db.prepare(
  `INSERT INTO calls (run_id, definition_id, seq, branch_path, iteration, scope_id, kind, content)
   VALUES (?, 'web', 10700, NULL, 0, NULL, 'web_turn_end', ?)`,
).run(
  SESSION,
  JSON.stringify({
    key: SESSION,
    turnId: "t1",
    runId: RUN,
    fromSeq: 10000,
    toSeq: 10604,
    input: "hi",
    status: "done",
    startedAt: 1,
    endedAt: 2,
    ts: 3,
  }),
);
db.close();

const log = new WebLog(dbPath, (k) => k);
const writes = log.memoryWrites(SESSION);
log.close();

assert.equal(writes.length, 2, "only memory writes are read, not the 600 record rows");
assert.deepEqual(writes.map((w) => w.app), ["contacts", "contacts"], "app attribution comes from tree_enter/exit");
assert.equal(writes[0].content?.value, BIG, "a long raw value is not truncated");
assert.deepEqual(writes[1].content?.value, LIST, "an array value is not collapsed into a summary");

// A fresh tracker = a restarted admin / reloaded tab. Rebuild → same panel.
const alive = createMemoryTracker();
alive.track(SESSION, writes[0], "contacts"); // what a live turn would have tracked
alive.track(SESSION, writes[1], "contacts");
const live = alive.payload(SESSION);
assert.equal(live.apps.contacts["memory/big"], BIG);
assert.deepEqual(live.apps.contacts["memory/list"], LIST);

const rebooted = createMemoryTracker();
assert.equal(rebooted.needsRebuild(SESSION), true);
rebooted.rebuild(SESSION, writes);
assert.deepEqual(rebooted.payload(SESSION), live, "a restart rebuilds the same panel from the log");
assert.equal(rebooted.needsRebuild(SESSION), false, "the rebuild is one-shot per session");

// Rebuild does not clobber what the process tracked before it, and later live
// writes still win.
const mid = createMemoryTracker();
mid.rebuild(SESSION, writes);
mid.track(SESSION, { kind: "record", branch_path: "memory", scope_id: 1, content: { op: "memory", child: "big", value: "live" } }, "contacts");
assert.equal(mid.payload(SESSION).apps.contacts["memory/big"], "live", "a live write after rebuild wins");
mid.rebuild(SESSION, writes);
assert.equal(mid.payload(SESSION).apps.contacts["memory/big"], "live", "a second rebuild is a no-op");

// clear() is final: a later rebuild must not resurrect the dropped session.
const dropped = createMemoryTracker();
dropped.clear(SESSION);
dropped.rebuild(SESSION, writes);
assert.deepEqual(dropped.payload(SESSION), { values: {}, apps: {} }, "a cleared session is not resurrected");

// Conversations stay isolated even on colliding slot keys.
const perSession = createMemoryTracker();
const write = (value: unknown): MemoryWrite => ({
  kind: "record",
  branch_path: "m",
  scope_id: 1,
  content: { op: "memory", child: "x", value },
});
perSession.track("web:a", write(1), "trunk");
perSession.track("web:b", write(2), "trunk");
assert.equal(perSession.payload("web:a").apps.trunk["m/x"], 1);
assert.equal(perSession.payload("web:b").apps.trunk["m/x"], 2);

// LRU: rebuilt sessions are sealed, but eviction unseals so a later view can
// rebuild again (the maps are bounded, the log is not).
const lru = createMemoryTracker({ maxSessions: 2 });
lru.rebuild("web:1", [write(1)]);
lru.rebuild("web:2", [write(2)]);
assert.equal(lru.needsRebuild("web:1"), false);
lru.rebuild("web:3", [write(3)]); // evicts web:1
assert.equal(lru.needsRebuild("web:1"), true, "an evicted session rebuilds again");
assert.equal(lru.needsRebuild("web:3"), false);

// ── the browser reader ──────────────────────────────────────────────────
// Same contract over the backend's own logger APIs (OPFS sqlite in the tab,
// node:sqlite here): raw values, app attribution, no MAX_TURN_EVENTS cap.
const webWs = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-browser-log-"));
const webPlatform = createNodePlatform(webWs);
// The replay attributes app names against the workspace's app trees; the
// fixture's `email` boundary must exist there to be a tile (nested-app rule).
await fs.mkdir(path.join(webWs, "app", "email"), { recursive: true });
await fs.writeFile(path.join(webWs, "app", "email", "tree.prod.mjs"), "export default {};\n");
const BROWSER_KEY = "web:browser";
const BROWSER_RUN = "run-browser";
const browserEvents = [
  { seq: 1, run_id: BROWSER_RUN, definition_id: "engine", branch_path: "app-branch", iteration: 0, scope_id: null, kind: "tree_enter", content: { tool: "email" } },
  { seq: 2, run_id: BROWSER_RUN, definition_id: "engine", branch_path: "memory", iteration: 0, scope_id: 1, kind: "record", content: { op: "memory", child: "big", value: BIG } },
  ...Array.from({ length: 600 }, (_, i) => ({
    seq: 3 + i, run_id: BROWSER_RUN, definition_id: "engine", branch_path: "work", iteration: 0, scope_id: null,
    kind: "record", content: { op: "toolResult", text: `noise ${i}` },
  })),
  { seq: 603, run_id: BROWSER_RUN, definition_id: "engine", branch_path: "app-branch", iteration: 0, scope_id: null, kind: "tree_exit", content: { tool: "email" } },
];
await appendEvents(webPlatform, browserEvents);
await writeTurnEnd(webPlatform, {
  key: BROWSER_KEY,
  turnId: "b1",
  runId: BROWSER_RUN,
  fromSeq: null,
  toSeq: null,
  input: "hi",
  status: "done",
  startedAt: 1,
  endedAt: 2,
  ts: 3,
});
const browserWrites = await browserMemoryWrites(webPlatform, BROWSER_KEY);
assert.equal(browserWrites.length, 1, "browser reader skips the 600 record rows and finds the write");
assert.equal(browserWrites[0].app, "email", "browser reader attributes the app from tree markers");
assert.equal(browserWrites[0].content?.value, BIG, "browser reader keeps the raw value");

await fs.rm(ws, { recursive: true, force: true });
await fs.rm(webWs, { recursive: true, force: true });
console.log("memory-track: rebuild restores raw values across restarts, uncapped and per session");
