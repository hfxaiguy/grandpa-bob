# Feature plan — KAT async log store (shape A)

Status as of 2026-10-26. Shape **B** is implemented: grandma-kat exports
`createSessionLogStore(driver)` — a portable log store that keeps the engine's
synchronous logger contract over an asynchronous driver, shadows call rows +
checkpoints, and restores a paused run after a process restart. BOB's browser
target runs it over the OPFS run log (checkpoint restore after a page reload is
covered by `scripts/web-session-restore-test.ts` and the browser smoke's
"first turn after a reload restores the paused run" assertion).

This plan is A: make the **engine itself** able to await storage reads, so a
driver can serve rows lazily from disk mid-turn instead of requiring a complete
in-memory replica. A is not needed for the reload bug; it is a scale/latency
investment. Do not start it until one of the triggers below is real.

---

## Why B is enough today (and what it costs)

B's invariant: every row the engine can address during a synchronous step is
already in the logger's memory.

- `log()` appends the row before returning its seq (refs are addresses).
- A cold worker hydrates the paused run's window (`seq ≤ checkpoint.seq`) once,
  at turn start, before the engine executes.
- Checkpoint shadows are ordered after the call rows they depend on.

Costs that A would remove:

1. **Working-set replica.** A resumed run's rows `≤ cp.seq` must fit in the
   worker's JS heap (today they do; the wasm log itself is streamed).
2. **Cold-turn hydration latency.** One batch SELECT of the run per reload
   (milliseconds today; grows with very long conversations).
3. **No lazy cross-process reads.** A ref minted in another process could not
   be resolved mid-step without a prior hydration (not a current product
   scenario: refs are run-local).

Everything else about B is deliberate and should survive into A: host policy
(which checkpoint a chat resumes, tombstones, labels, retention) stays in the
host; the engine owns the mechanism.

## Triggers (do A when one of these is true)

- The paused run's replay window regularly exceeds a few MB per open session
  (measure: hydration rows/bytes logged by `restore()`), or many concurrently
  open chats make the per-session replica the tab's memory driver.
- A product feature needs refs/memory reads from rows written by **another
  process** between turns (e.g. a desktop copilot editing the same shared log
  mid-conversation), without an explicit rehydrate step.
- Cold-start latency after a reload becomes user-visible (hydration > ~150 ms
  p95 on a real workspace).

If none holds, upgrading is churn — B's replica is also the reason resume stays
deterministic and fast.

---

## The hinge: `ctx.readRef` is synchronous

`refs.mjs` resolves `ref://<seq>/<path>` synchronously:

```js
// refs.mjs:104
const row = exec?.logger?.readRow?.(parsed.seq) ?? null;
```

That function is reached from the **tool context** (`knit.mjs:66`):

```js
readRef: (ref) => resolveRef(exec, ref)   // handed to every tool
```

and from tree-tool slot seeding (`knit.mjs:1488`, already inside an async
function). Tools consume `ctx.readRef(...)` synchronously; some chain it. Making
storage lazy means this becomes `await ctx.readRef(...)` — a **breaking tool API
change** that must be versioned and migrated across the KAT tool surface and
user patterns.

Everything else in the engine is already await-friendly:

- `knit()`/`resume()` are async; `getCheckpoint`/`getEvents` can be awaited.
- `log()` must stay synchronous **for seq allocation** — but not for the write.
  The pending-batch rule already provides read-your-writes; in async mode the
  store must answer `readRow` from its pending buffer until the row lands (or
  flush-before-read with a synchronous in-process cache).

## Design sketch

1. **Split the driver contract into read/write halves** (already close):
   - writes: `appendCalls`, `upsertCheckpoint`, `deleteCheckpointRow`,
     `startRun` (async; unchanged)
   - reads: `getCheckpoint(id)`, `getEvents(runId, { upToSeq })`,
     `readRow(seq)`, `headSeq()` (all async)
2. **`createSessionLogStore` gains a mode:**
   - `mode: "replicated"` (default; B — memory replica, sync reads)
   - `mode: "direct"` — memory holds only the pending write buffer + a bounded
     LRU of recently read rows; `readRow`/`getEvents`/`getCheckpoint` return
     promises that hit the driver, with pending rows served synchronously
     first.
3. **Engine logger interface v2** (`logger.readRowAsync(seq)`,
   `logger.getEventsAsync(runId)` etc.) OR make the v2 methods the only ones and
   provide a sync-compat wrapper for `replicated`. Version it explicitly:
   `grandma-kat` major bump, `runtime.logStore` flag, deprecation window.
4. **Refactor ref resolution to async:**
   - `resolveRef`/`resolveRefs` → async (or add `resolveRefAsync` used by the v2
     path).
   - `toolCtxFor.readRef` returns a Promise. **This is the migration cost.**
   - `inspect_memory`'s `readRef` capability (engine-owned) updates with it.
   - `expects`/predicate evaluation that embeds refs must await (the evaluator
     already awaits predicates; audit every `walk`/`byRef` call site).
5. **Resume becomes hydration-free:** `resume()` awaits the checkpoint row and
   replays events streamed from the driver (paginated by seq range) instead of
   requiring `getEvents` to return one giant array. Keep a page cap and stream
   through the replay loop.
6. **Bound the cache:** LRU by bytes (`seq → row`) shared across sessions of
   one log; never evict rows needed by the in-flight replay page. Expose
   metrics via the host (`onStats`) for the triggers above.
7. **Host driver changes:** BOB's browser driver drops the `ensureLogCursor`
   coupling for reads (seq allocation stays host-owned); the Node driver uses
   `node:sqlite` directly (this finally lets `SqliteLogger` be rebuilt on the
   portable component — the last duplicated logger implementation).

## Work breakdown

**Phase 1 — spike (no API break):**
- Add `readRowAsync`/`getEventsAsync`/`getCheckpointAsync` alongside the sync
  ones; refactor `resume()` and ref seeding (non-tool paths) to await them.
- Prove a "direct" store resumes a run without hydrating the whole window,
  on a synthetic 50k-row run.
- Acceptance: same behavior on KAT + BOB suites; hydration eliminated for
  resume's event replay; cold-start hydration no longer needed for runs whose
  refs stay within the cache (partial win, exposed as an option).

**Phase 2 — tool API v2:**
- `ctx.readRef` async behind `runtime.refs === "async"`; sync `readRef` throws
  a descriptive error in that mode (no silent Promise-as-value bugs).
- Port KAT's `inspect_memory`, `runLogTools` consumers, and BOB's
  `tool_gate`/pattern tools that call `readRef`.
- New tests: a tool using `await ctx.readRef` twice, a chained ref, a ref to a
  row just logged in the same round (pending-buffer read), a ref evicted from
  LRU reloaded from the driver.

**Phase 3 — flip:**
- Default `direct` when the driver advertises it; `replicated` remains for
  synchronous drivers (Node keeps it: it has no reason to pay promises).
- Remove the hydration call from BOB's cold-worker path when the direct driver
  is active; keep it as the fallback.
- Deprecate `readRow` on the engine surface; remove after a release.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Tool API break ripples through user tree patterns | `refs` mode flag; sync mode throws with an actionable message; codemod note in the KAT changelog; BOB seed patterns updated in the same release |
| Read-your-writes regressions (row logged, then read before flush) | pending buffer served first; test a tool ref to a row logged in the same round |
| Await-per-ref latency | LRU + per-page prefetch; benchmark a 100-ref turn |
| Resume against a partially compacted/streamed page | keep B's "pause row present" validation; stream pages up to `cp.seq` only |
| Two implementations drifting during the deprecation | `replicated` is built on the same driver contract; KAT suite runs both modes through the same scenarios |

## Acceptance criteria

- `grandma-kat` suite passes in both modes; new async-ref tests listed above.
- BOB: `test:web-restore`, `test:webturns`, `test:web-memory`, `test:sessions`,
  browser smoke (including the reload-restore assertion) pass with
  `mode: "direct"`.
- Cold reload on a synthetic 10 MB / 200k-row run: first turn starts without
  hydrating the full window (memory high-water < 25% of the replicated mode).
- No behavioral change for tools using the sync API until the major bump; no
  silent promise values.

## Out of scope

- Host policy (session keys, tombstones, labels, retention tiers) — stays in
  the hosts.
- Remote (network) log stores; the driver is still local storage.
- Changing when the engine pauses (`Human`) or the checkpoint payload shape.
