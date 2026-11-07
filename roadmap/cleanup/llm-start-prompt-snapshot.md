# Show the in-flight LLM prompt (llm_start has no input)

**Status:** open
**Created:** 2026-11-07
**Updated:** 2026-11-07
**Context:** the event inspector shows an `llm_start` row as a 298-char
`{ child, round, model, tools, refName }` payload. The conversation the model
receives is only on the paired `llm_call` row, which is written **after** the
response returns. While a call is in flight (or hanging) there is nothing in the
log or the live stream to inspect.

This file records the question, why the engine does not put the input on
`llm_start`, and the browser-side fix that does not need an engine release.

---

## Why the input is missing today

- Engine emit: `node_modules/grandma-kat/src/knit.mjs` (~line 1340) logs
  `llm_start` before `await callLlm(...)` with only `child`, `round`, `model`,
  `tools`, and temperature. The comment there says the payload is deliberately
  "kept small — the completed `llm_call` carries the payload (messages, content,
  toolCalls)".
- The loop re-sends the whole thread every round: trunk system prompt (~10 KB),
  tool schemas, resolved `ref://` handles. This is why the live sanitizer
  (`web/src/sanitize.ts:54-69`) replaces `messages` with `{ count, chars }` and
  why a single `llm_call` was once ~130 KB.
- `llm_call` carries `messages`, `content`, `reasoning`, `toolCalls`, `usage`,
  `reads`; `llm_error` also carries `messages` on failure. `llm_start` is not
  replayed on resume, so it never becomes a second source of truth.
- Provenance treats `llm_call.messages` as the attested record
  (`web/src/provenance.ts:371-427`), not a reconstruction.

Accepted cost today: a pending call cannot be inspected. A failed call can
(`llm_error`), a completed one can (`llm_call` + `/api/ref`).

## Why not just the UI page

`ui/` only receives sanitized events and raw rows via `/api/ref`
(`ui/src/store.ts:1043`, `web/src/server/local-backend.ts:1031`). The engine
runs in a worker; `thread` is worker stack state. The page cannot read it.

Reconstructing from history is rejected:

- Round 1 has no prior `llm_call` — the only copy is the request being sent.
- The exact thread contains the prompt def's system message, per-round engine
  appends, `ref://` expansion, and error text fed back after failed tools; the
  page never sees those.
- Live event strings are 400-char capped and long arrays summarized
  (`sanitizeValue`), so a replay is lossy.
- Showing a likely-wrong reconstruction while debugging a hang is worse than
  showing nothing.

## Proposed fix — snapshot at the host seam (browser only)

The browser host already sees the exact outgoing thread. `withModelRetry` wraps
every model entry with a handler that is invoked by the engine before the
network call:

```ts
// web/src/agent/model-retry.ts:100-110
handler: (messages, options) =>
  retryModelCall(() => callLlm(entry, messages, options), opts),
```

`node_modules/grandma-kat/src/llm.mjs:219` calls `model.handler(messages, …)`,
so this is the engine's `thread` verbatim (pre protocol formatting; retries
inside `retryModelCall` reuse the same messages, so one snapshot per call).

**Shape**

| Piece | Change |
|---|---|
| Worker | `withModelRetry(registry, { …opts, onRequest })`. `onRequest` receives `{ messages, tools, model }` and stores it in a per-run in-memory map keyed by the next `llm_start` (the run's event tap already sees the `llm_start` immediately before the handler fires). |
| Lifecycle | Drop the snapshot when the matching `llm_call`/`llm_error` row is tapped, on turn end, and on stop. Memory-only: never written to the run-log DB, so seqs, provenance and DB size are unchanged. |
| RPC | One op mirroring `readRow` (e.g. `readPrompt({ run, seq })`) on the main-thread local backend, exposed as `GET /api/prompt?run=…&seq=…`. The worker owns the map, the page asks through the same serialized seam `/api/ref` uses. |
| UI | `EventModal` (`ui/src/components.tsx:812-975`): for `llm_start`, the full-row tab (or a new `prompt` tab) loads the snapshot and shows it with the existing `copy messages` action. Label it "captured request — the log row itself has no messages". `ui/src/store.ts` gets `fetchPrompt`; `describe.ts` can add `[N messages, M chars]` to the `llm_start` detail when a snapshot exists. |
| Tests | Extend the model-retry unit test with an `onRequest` spy (called once per call, retries do not re-fire); a worker/local-backend test for the op; a UI describe/modal test that `llm_start` renders the snapshot and clears it on `llm_call`. |

**Do not** write a synthetic row to the engine log: it would shift seqs,
pollute provenance and turn replays, and the row still would not be the attested
`llm_call`.

## Alternatives considered

- **Engine flag (proper but external):** include `messages` on `llm_start` when
  a debug/trace option is on. Fixes every host, but needs a grandma-kat release
  and doubles the largest payload in the log for that run.
- **Node proxy capture:** when admin-served, `/api/llm/<slot>`
  (`web/src/agent/agent-worker.ts:259-287`) sees the wire body, but the
  all-browser target has no proxy, so the worker hook is the portable seam.
- **UI reconstruction:** rejected above.

## Acceptance

- While a model call is in flight, opening the `llm_start` row shows the exact
  `messages` and `tools` sent, and `copy messages` works.
- When `llm_call`/`llm_error` lands, the snapshot is dropped and the attested
  row is shown instead; the modal does not show two competing inputs.
- A stopped turn, a page reload and a worker restart leave no orphaned
  snapshots (map is per run and cleared on teardown).
- Run-log size and provenance are unchanged; snapshots never reach disk.
- Works in the all-browser target and the admin-served target.
- `npm run test:standalone` boundary holds (`web/src` imports nothing from
  `src/`).

**Estimate:** ~1 focused day (handler hook + map/lifecycle + one op/route +
modal tab + tests).

## Notes / limitations

- The snapshot is the engine thread, not the final provider JSON: protocol
  formatting (OpenAI vs Ollama) happens inside `callLlm` after the handler.
  Content and roles are identical; only wire framing differs.
- A future engine option (above) could replace the snapshot once
  `llm_start.messages` exists; keep the RPC shape so the UI does not change.
