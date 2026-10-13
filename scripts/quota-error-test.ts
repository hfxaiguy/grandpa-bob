/**
 * Quota-error classifier: which model-call failures are a billing/quota wall
 * worth offering a fallback for, and which role to retarget.
 *
 * grandma-kat tags the thrown Error with `status` (the HTTP code) and `slot`
 * (the runtime models key the prompt resolved to). A 402 is canonical; some
 * providers use 403/429 with quota wording, so the text is a secondary signal.
 * Transient failures (5xx, timeouts) must NOT classify as quota — they are
 * retried with backoff and would otherwise prompt the user on a blip.
 *
 * Run: npm run test:quota-error
 */
import assert from "node:assert/strict";
import { isQuotaError, quotaRole } from "../src/util/quota-error.js";

// ── 1. a 402 is a quota wall regardless of message ──
{
  const err = Object.assign(new Error("LLM request failed (402): whatever"), { status: 402 });
  assert.equal(isQuotaError(err), true);
}

// ── 2. a 403/429 whose text names quota/billing also classifies ──
{
  const blocked = Object.assign(
    new Error(
      "LLM request failed (403): Subscription access is currently blocked because a usage or billing limit was previously reached.",
    ),
    { status: 403 },
  );
  assert.equal(isQuotaError(blocked), true, "billing wording on a 403");

  const energy = Object.assign(
    new Error(
      "LLM request failed (429): Subscription energy allocation exceeded and credit balance depleted. Your included kWh has been exhausted.",
    ),
    { status: 429 },
  );
  assert.equal(isQuotaError(energy), true, "the neuralwatt energy/credit wording");
}

// ── 3. transient failures are NOT a quota wall ──
{
  assert.equal(
    isQuotaError(Object.assign(new Error("LLM request failed (503): down"), { status: 503 })),
    false,
  );
  assert.equal(isQuotaError(new Error("LLM request timed out after 120s (http://x)")), false);
  assert.equal(isQuotaError(new Error("max tool iterations exceeded")), false);
  assert.equal(isQuotaError(undefined), false);
  assert.equal(isQuotaError(null), false);
  assert.equal(isQuotaError("a string, not an error"), false);
}

// ── 4. the failing role comes from the error's slot tag ──
{
  const tagged = Object.assign(new Error("LLM request failed (402): no credit"), {
    status: 402,
    slot: "cheap",
  });
  assert.equal(quotaRole(tagged), "cheap");
}

// ── 5. an untagged failure falls back to the primary role ──
{
  assert.equal(quotaRole(new Error("LLM request failed (402): no credit")), "strong");
  assert.equal(quotaRole(Object.assign(new Error("x"), { slot: "" })), "strong");
  assert.equal(quotaRole(undefined, "default"), "default");
}

console.log("quota-error-test: 402/403/429 classification, transients, role tagging OK");
