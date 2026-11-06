/**
 * Host-level model-call retry.
 *
 * A provider can fail a call after grandma-kat's own retry budget is spent (a
 * load-shedding 52x/529, a second timeout, a reset between attempts). The host
 * now gives such a call one more chance, while a stop, quota wall, auth error
 * or malformed request still fails immediately.
 *
 * Pure: mock handlers and an injected sleep, no network.
 * Run: npm run test:model-retry
 */
import assert from "node:assert/strict";
import {
  isRetryableModelError,
  retryModelCall,
  withModelRetry,
} from "../web/src/agent/model-retry.ts";
import type { ModelRegistry } from "../web/src/model-config.ts";
import { AgentStoppedError } from "../web/src/stop-error.ts";

function httpError(status: number, message = `LLM request failed (${status}): nope`) {
  return Object.assign(new Error(message), { status });
}

// ── 1. classification ───────────────────────────────────────────────────
for (const status of [408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]) {
  assert.equal(isRetryableModelError(httpError(status)), true, `${status} is transient`);
}
for (const status of [400, 401, 402, 403, 404, 413, 422]) {
  assert.equal(isRetryableModelError(httpError(status)), false, `${status} needs a person, not a retry`);
}
assert.equal(
  isRetryableModelError(httpError(429, "LLM request failed (429): insufficient credit")),
  false,
  "a 429 quota wall is not a rate-limit retry",
);

assert.equal(
  isRetryableModelError(Object.assign(new Error("LLM request timed out after 120s"), { code: "llm_timeout" })),
  true,
  "a timeout can be retried",
);
assert.equal(isRetryableModelError(new TypeError("Failed to fetch")), true, "a network failure is transient");
assert.equal(isRetryableModelError(new Error("LLM request returned a truncated body")), true);
assert.equal(isRetryableModelError(new Error("bad tool schema")), false, "a programming error is not transient");
assert.equal(
  isRetryableModelError(new Error("LLM request failed (520): upstream error")),
  true,
  "a status embedded in the message is classified",
);
assert.equal(
  isRetryableModelError(new Error("LLM request failed (401): invalid key")),
  false,
  "an embedded auth status is not retried",
);

// A stop is never retried, even though its AbortError looks like a transport
// failure to a naive classifier.
const stopped = Object.assign(new Error("stopped by user"), { name: "AbortError", code: "ABORT_ERR" });
assert.equal(isRetryableModelError(stopped), false);
assert.equal(isRetryableModelError(Object.assign(new Error("stop"), { stopped: true })), false);

// ── 2. retry loop ───────────────────────────────────────────────────────
{
  const delays: number[] = [];
  let calls = 0;
  const value = await retryModelCall(
    async () => {
      calls += 1;
      if (calls < 3) throw httpError(520);
      return "ok";
    },
    { attempts: 3, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3, "two failures then a success");
  assert.deepEqual(delays, [100, 200], "exponential backoff between attempts");
}

{
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(
    () =>
      retryModelCall(
        async () => {
          calls += 1;
          throw httpError(503);
        },
        { attempts: 2, baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) },
      ),
    /503/,
    "the last failure is surfaced",
  );
  assert.equal(calls, 2, "attempts include the first call");
  assert.deepEqual(delays, [10]);
}

{
  let calls = 0;
  await assert.rejects(
    () =>
      retryModelCall(
        async () => {
          calls += 1;
          throw httpError(402);
        },
        { sleep: async () => assert.fail("a quota wall must not sleep") },
      ),
    /402/,
  );
  assert.equal(calls, 1, "a quota wall is not retried");
}

// A stop while waiting for the retry cancels the wait instead of calling the
// provider once more.
{
  const ctrl = new AbortController();
  let calls = 0;
  await assert.rejects(
    () =>
      retryModelCall(
        async () => {
          calls += 1;
          throw httpError(503);
        },
        {
          sleep: async () => ctrl.abort(),
          signal: ctrl.signal,
        },
      ),
    AgentStoppedError,
  );
  assert.equal(calls, 1, "a stop after the first failure does not retry");
}

// ── 3. registry wrapper ─────────────────────────────────────────────────
{
  let calls = 0;
  const registry: ModelRegistry = {
    strong: {
      baseURL: "https://example.invalid/v1",
      apiKey: "k",
      model: "m",
      handler: async () => {
        calls += 1;
        if (calls === 1) throw httpError(529, "LLM request failed (529): overloaded");
        return { content: "recovered" };
      },
    },
  };
  const wrapped = withModelRetry(registry, {
    attempts: 2,
    baseDelayMs: 0,
    sleep: async () => {},
  });
  const result = await wrapped.strong.handler!([{ role: "user", content: "hi" }], {});
  assert.equal(result.content, "recovered", "the retried call returns the good response");
  assert.equal(calls, 2, "the wrapper retried once");
  assert.equal(wrapped.strong.model, "m", "entry fields are preserved");
  assert.equal(wrapped.strong.baseURL, registry.strong.baseURL);
  assert.equal(wrapped.strong.handler === registry.strong.handler, false, "the handler is wrapped, not replaced");
}

{
  let calls = 0;
  const wrapped = withModelRetry(
    {
      auth: {
        baseURL: "https://example.invalid/v1",
        apiKey: "bad",
        model: "m",
        handler: async () => {
          calls += 1;
          throw httpError(401, "LLM request failed (401): invalid key");
        },
      },
    },
    { sleep: async () => assert.fail("auth failures must not sleep") },
  );
  await assert.rejects(() => wrapped.auth.handler!([], {}), /401/);
  assert.equal(calls, 1, "a rejected key is not retried");
}

console.log("model-retry: classification, backoff, wrapper and non-retryable failures OK");
