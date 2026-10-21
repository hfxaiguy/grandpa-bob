/**
 * The memory panel is always the active conversation's.
 *
 * Regression: `turn_end` fires `void refreshMemory()`; clicking "new chat"
 * right after started a second fetch. Responses were not tied to a session, so
 * when the old (larger, slower) one resolved last it repainted the fresh chat
 * with the previous conversation's values — and nothing refreshed again until
 * the next turn ended, so the values looked like they had "survived" the
 * switch.
 *
 * Also covers the live SSE push: a write may merge only into the session it
 * names, and only once the panel already reflects that session; otherwise the
 * panel is refetched rather than blended.
 *
 * No network (fetch is stubbed) and no browser (Solid's store is plain JS).
 * Run: npm run test:memory-race
 */
import assert from "node:assert/strict";

const { state, setState, refreshMemory, handleSSE } = await import("../ui/src/store.ts");

// ── a fetch whose responses resolve when the test says so ────────────────
type Pending = { path: string; resolve: (apps: Record<string, Record<string, unknown>>) => void };
const pending: Pending[] = [];
const fetched: string[] = [];
globalThis.fetch = ((path: string) =>
  new Promise((resolve) => {
    fetched.push(path);
    pending.push({
      path,
      resolve: (apps) => resolve({ ok: true, json: async () => ({ apps }) }),
    });
  })) as any;

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

// ── the switch race: an older response must not land ─────────────────────
setState({ active: "web:old", memory: {}, memorySession: null, sessionResumed: false });
const oldFetch = refreshMemory(); // in flight for web:old
setState({ active: "web:new", memory: {}, memorySession: null });
const newFetch = refreshMemory(); // started after the switch

// The fresh session answers first (it has nothing yet).
pending[1].resolve({ trunk: { conversation: [] } });
await newFetch;

// The stale response arrives last — it must be discarded, not repaint.
pending[0].resolve({ trunk: { conversation: ["old thread"] } });
await oldFetch;
assert.deepEqual(state.memory, { trunk: { conversation: [] } }, "old session's values did not land");
assert.equal(state.memorySession, "web:new", "the panel still names the session on screen");
assert.match(fetched[0], /session=web%3Aold/, "each fetch names the session it is for");
assert.match(fetched[1], /session=web%3Anew/);

// ── no session on screen: no fetch, clear the panel ──────────────────────
setState({ active: null, memory: { trunk: { a: 1 } }, memorySession: "web:old" });
const before = fetched.length;
await refreshMemory();
assert.equal(fetched.length, before, "no fetch without a session (it would answer for the server's active one)");
assert.deepEqual(state.memory, {});
assert.equal(state.memorySession, null);

// ── SSE: only the active session's labelled pushes may merge ─────────────
setState({ active: "web:new", memory: {}, memorySession: "web:new", sessionResumed: false });
handleSSE({ type: "memory", session: "web:old", app: "trunk", values: { "conversation/old": "x" } });
assert.deepEqual(state.memory, {}, "a push for another session is dropped");

handleSSE({ type: "memory", app: "trunk", values: { "conversation/x": "y" } });
assert.deepEqual(state.memory, {}, "an unlabelled push is dropped (it cannot be attributed)");

handleSSE({
  type: "memory",
  session: "web:new",
  app: "trunk",
  values: { conversation: [{ role: "user", content: "hi" }] },
});
assert.deepEqual(
  state.memory,
  { trunk: { conversation: [{ role: "user", content: "hi" }] } },
  "the active session's push merges",
);

// A push for the right session while the panel is still another session's
// map must not blend: refetch instead.
setState({ active: "web:new", memory: { trunk: { stale: 1 } }, memorySession: "web:old" });
const n = fetched.length;
handleSSE({ type: "memory", session: "web:new", app: "trunk", values: { "conversation/x": "y" } });
assert.equal(fetched.length, n + 1, "a mismatched panel refetches instead of merging");
assert.deepEqual(state.memory, { trunk: { stale: 1 } }, "and does not merge into the stale map");
pending[pending.length - 1].resolve({ trunk: { conversation: "fresh" } });
await settle();
assert.deepEqual(state.memory, { trunk: { conversation: "fresh" } });

console.log("memory-race: ok");
