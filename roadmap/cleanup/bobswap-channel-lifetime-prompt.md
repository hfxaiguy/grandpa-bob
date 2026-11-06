# Prompt: make BobSwap sync channels reusable beyond 30 minutes

Copy everything below into the BobSwap (Lovable) project.

---

## Task: let a paired device re-establish signaling without a new pairing code

### Context

BOB is a local agent harness. A browser tab pairs with a desktop through your
`/api/v1/sync/channels` signaling service. Only SDP/ICE goes through BobSwap;
files, desktop ops and voice travel peer-to-peer over the WebRTC data channel.
Security relies on a locally compared DTLS SAS; the relay is untrusted.

Current contract (from `/docs/agents`):

- Pairing code: single-use, 8 digits, expires 10 minutes after creation.
- A successful join sets a **fixed channel expiry 30 minutes after joining**.
- Signal writes and heartbeats do **not** renew either deadline.
- Role tokens authorize signaling; `DELETE` removes the channel.

Consequence: a phone that reloads or is backgrounded for more than 30 minutes
must go back to the desktop and have the operator mint a new code. That makes
"paired" behave like a one-off session.

### Goal

A paired device must be able to re-establish signaling **without a new pairing
code and without operator action on the other device**, for as long as the
pairing exists — while keeping the current security properties (untrusted relay,
SAS verification, signaling-only payloads).

### Proposed design — do A + B (C only if you want a bigger abstraction)

**A. Renewal endpoint**

```
POST /api/v1/sync/channels/{channel_id}/renew
Authorization: Bearer <role_token>

200 {"channel_id": "...", "expires_at": "<ISO-8601>"}
```

- Extends the channel to `now + ttl` (default 30 minutes; allow a per-request
  `{"ttl_seconds": N}` bounded by a server maximum).
- Allowed while unexpired, and optionally within a short grace window (e.g. 10
  minutes) after expiry if the record still exists.
- `403` for a foreign/unknown role token; `404` if purged; `410` if expired
  beyond the grace window.
- No action required from the other peer. (Optional variant: require both
  peers to renew within the window so a session ends when one side disappears.)
- Rate limit per role token (e.g. 10/min) and per IP, with `Retry-After` on
  `429`.
- `expires_at` is returned by create, join and renew so clients can schedule a
  renewal at ~50% of the remaining TTL.
- Keep an optional server-side absolute maximum lifetime (e.g. 7 days) if you
  want a hard bound. Otherwise a channel ends on `DELETE`, on inactivity, or
  when its token is revoked.

**B. Configurable initial TTL**

```
POST /api/v1/sync/channels
{"ttl_seconds": 86400}
```

- Bounded by a server maximum; omit the field for today's 30-minute default.
- Join echoes the resulting `expires_at`.

**C. Persistent pairing credential (only if you prefer this shape)**

- After the first join, issue each device a long-lived `pairing_token` bound to
  the pairing (not just the channel).
- Either side can mint a fresh channel with
  `POST /api/v1/sync/channels {"pairing_token": ...}`; the other side discovers
  it through a small rendezvous endpoint or a pairing feed.
- This removes the renewal clock entirely, at the cost of a durable credential
  to protect, rotate and revoke. Only build it if A+B are not enough.

Recommendation: **A + B**. It is a small, backwards-compatible change and covers
a phone resuming within the configured TTL.

### Security requirements

- Renewal (and any pairing credential) requires the existing role token or a new
  scoped token — never a pairing code.
- Do not change SAS verification; the relay must still never derive or see it.
- Never log pairing codes, role tokens, SDP/ICE payloads; codes never in URLs.
- Rate limit renewals per token and per IP; return `Retry-After` on `429`.
- `DELETE` stays the immediate revocation path; revoking a token must also stop
  renewal.
- Keep expired/unknown responses opaque to unauthenticated callers.
- If adding C, make the credential revocable and visible in the operator
  dashboard.

### Backwards compatibility

- Existing create/join/signal/heartbeat/peers/delete contracts stay unchanged.
- `expires_at` already exists; renewal is a new route and the TTL field is
  optional, so clients that never renew keep today's 30-minute behavior.
- Update `/docs/agents` and the changelog.

### Acceptance tests

1. Create + join; renew at 20 minutes; the channel still accepts signaling at
   40 minutes and `expires_at` has advanced.
2. No renewal: signaling fails after the expiry exactly as today (410 or purged
   404).
3. Renewal with a foreign role token → 403; after `DELETE` → 404/410.
4. Renewal is rate limited and advertises `Retry-After`.
5. A client that reloads within the TTL resumes on the same channel without a
   new pairing code.
6. Old clients that never call renew keep the 30-minute behavior.

### What the BOB client will do (for compatibility)

- Store `expires_at` from create/join/renew and renew at ~50% of the remaining
  TTL while the datachannel is up (client-side change on our side).
- On resume it writes a reconnect entry on the same channel and waits for a
  fresh offer (already implemented desktop-side).
- If a renew returns 404/410, it falls back to today's flow: ask the operator
  for a new pairing code.

### Deliverables

- Implemented endpoint(s) with defaults preserving current behavior.
- Updated agent docs + changelog.
- A short curl walkthrough: create, join, renew, signal after renewal.
- Operator controls for the maximum TTL (and revocation, if C ships).
