# Prompt: make BobSwap renewal TTLs practical for always-paired devices

Copy everything below into the BobSwap (Lovable) project.

---

## Task: default the renew TTL ceiling to seven days and clamp over-limit requests

### Context

BOB is a local agent harness. A browser tab pairs with a desktop through your
`/api/v1/sync/channels` signaling service; only SDP/ICE goes through BobSwap,
while files, desktop ops and voice travel peer-to-peer over the WebRTC data
channel. The relay is untrusted and security relies on a locally compared DTLS
SAS.

The desktop now renews a live channel with:

```
POST /api/v1/sync/channels/{channel_id}/renew
Authorization: Bearer <role_token>
Content-Type: application/json

{"ttl_seconds": 604800}
```

and schedules its next renewal at a third of the returned `expires_at`,
capped at 24 hours. With a seven-day channel that means one renewal a day and
six days of slack for a transient failure, a suspended laptop or a desktop
restart.

Today the operator maximum TTL defaults to **86400 s**, so a seven-day request
is either clamped to 24 hours or rejected. Clamping is acceptable (BOB renews
every 8 hours), but it removes most of the outage margin. Rejection is worse:
BOB retries once without `ttl_seconds`, then falls back to the 30-minute
default and a 10-minute cadence.

### Required changes

1. **Raise the default operator maximum TTL from `86400` to `604800` seconds
   (seven days).** Keep the setting adjustable from `60` to `604800` seconds.
   Existing deployments should adopt the new default unless an operator has
   explicitly saved a different value.

2. **Honor `ttl_seconds` on renew up to the operator maximum.** If the request
   exceeds the maximum, clamp it to the maximum and answer `200` with the
   actual `expires_at` — do **not** reject an over-limit value with `4xx`.
   A value below `60`, a non-integer, or a non-numeric value should still be
   `400`.

3. **Set `expires_at = now + effective_ttl` on every successful renew**, not
   `old_expires_at + ttl`. Return `expires_at` on create, join and renew. This
   is what lets the client schedule safely from the server's clock.

4. **Keep the rest of the renewal contract unchanged:** either paired role may
   renew while the channel is unexpired, with no action from the other peer
   and no pairing code; `403` for a foreign/unknown role token; `404` when the
   channel is deleted or purged; `410` when it has expired; `409` before the
   channel is paired. No absolute lifetime cap — repeated renewals keep the
   pairing alive, and only `DELETE`, token revocation or nobody renewing ends
   it.

5. **Keep `{}` and a missing body working exactly as today:** default TTL
   `1800` seconds. Old clients that never send `ttl_seconds` must keep the
   current behavior.

6. **Keep the existing rate limits** per role token and per IP, returning
   `Retry-After` on `429`. A daily renewal should never come close to the
   limit, but a burst must stay harmless.

7. **Do not log pairing codes, role tokens, SDP/ICE payloads or full request
   bodies.** Keep expired/unknown responses opaque to unauthenticated
   callers.

8. **Update `/docs/agents` and the changelog** with the new default, the
   clamping rule and the seven-day ceiling.

### Backwards compatibility

- Old clients sending `{}` keep the 30-minute default.
- Existing channels keep their current `expires_at` until their next renewal;
  no migration or channel recreation is needed.
- Clamping rather than rejecting is essential: newer BOB clients request seven
  days unconditionally and rely on `expires_at` to learn the effective TTL.
  Rejecting a valid over-limit request punishes the client for the operator's
  lower cap.

### Acceptance tests

1. Renew with `{"ttl_seconds": 604800}` and operator max `604800` → `200`,
   `expires_at` ≈ now + 604800 s.
2. Renew with `{"ttl_seconds": 604800}` and operator max `86400` → `200`,
   `expires_at` ≈ now + 86400 s (clamped, not `400`).
3. Renew with `{"ttl_seconds": 7200}` → `200`, `expires_at` = now + 7200 s
   (the exact requested value is honored).
4. Renew with `{}` or no body → `200`, `expires_at` = now + 1800 s.
5. Renew with `{"ttl_seconds": 59}` → `400`; with `604801` → `200` clamped to
   the operator maximum; with a string → `400`.
6. A renew with a foreign role token → `403`; after `DELETE` → `404`/`410`;
   after expiry → `410`; before pairing → `409`.
7. Two renewals 24 hours apart keep the same channel usable and advance
   `expires_at` both times.
8. The renew endpoint is still rate limited and returns `Retry-After` on
   `429`.
9. Changing the operator maximum in the dashboard takes effect on the next
   renew without redeploying.

### Why this matters

Without the adjustment, a desktop that is closed for a weekend — or a phone
that stays paired but idle — loses its signaling channel and needs a new
pairing code, even though the WebRTC pairing itself is still valid. A
seven-day TTL plus daily renewal makes "paired" behave like a durable pairing
without adding a long-lived credential or weakening SAS verification.
