/**
 * Classify a model-call failure as a quota/billing wall.
 *
 * grandma-kat's `llm.mjs` throws on a non-retryable HTTP status, tagging the
 * Error with `status` (and, from knit, `slot` — the runtime `models` key the
 * prompt resolved to). A 402 is the canonical "payment required"; some
 * providers instead return 403/429 with a quota/billing message, so the text
 * is a secondary signal.
 *
 * A quota wall is worth a user decision (switch the model for this
 * conversation) — unlike a transient 5xx/timeout, which grandma-kat already
 * retries with backoff and which we deliberately do NOT prompt for.
 */

/** Billing/quota wording, matched case-insensitively against the error text. */
const QUOTA_TEXT = /quota|billing|credit|kwh|energy|payment required/i;

export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; message?: unknown };
  if (e.status === 402) return true;
  return typeof e.message === "string" && QUOTA_TEXT.test(e.message);
}

/**
 * The model slot/role a failure came from, when grandma-kat tagged one. Falls
 * back to "strong" — the primary conversation role — so a caller always has a
 * role to retarget.
 */
export function quotaRole(err: unknown, fallback = "strong"): string {
  if (err && typeof err === "object") {
    const slot = (err as { slot?: unknown }).slot;
    if (typeof slot === "string" && slot.trim()) return slot.trim();
  }
  return fallback;
}
