# Remaining work — BOB profiles, seed bindings, BobSwap relay

Status as of 2026-10-23. The three requested features landed (profiles with
migration, per-profile seed binding with update banner, copy-mode relay in both
browser and desktop storage modes). This plan lists what is still open, in the
order it should be tackled.

Legend: **P0** = correctness/security before daily use · **P1** = robustness/UX ·
**P2** = tests/docs. Each task names the files it touches and an acceptance test.

---

## Current state

| Feature | Status | Notes |
|---|---|---|
| Profiles (`/profiles/<name>`, registry, migration) | done | one-way, guarded, resumable migration; no rename; no quota display |
| Profile switch/create/duplicate/delete | done | switching reloads; no in-flight-turn guard |
| Export/Import scoped to the active profile | done | archives stay `workspace/...` |
| Seed binding + update banner (boot) | done | boot check only; no conditional GET yet |
| Seed check-now / unbind / publish | done | publish currently uploads **everything** (see C) |
| Relay copy mode (send/receive) | done, **not verified against a live BobSwap** | chunk/ack/sha implemented; no ownership swap |
| Relay in desktop (bridge) mode | done | requires the updated `storage-server.mjs` (`/fs/readBytes`) |
| Device identity (P-256) | done | key pair stored; no sign/verify helpers yet |

Known caveat: the relay client follows the documented BobSwap API but has only
been exercised with typechecks and the folder/seed smokes — never against a
running BobSwap instance.

---

## P0-A. Make the relay real

**Goal:** prove desktop ↔ phone sharing end-to-end against the Lovable-built
service, and lock the transport contract down.

Deployed service: `https://bobswap.hfxaiguy.com` — **live** (health 200,
`/docs/agents` is the authoritative contract, read 2026-10-23). The client now
matches it: broadcast event `relay`, exact `realtime_channel`, 192 KiB chunks,
control plane via role tokens, `complete`-based verification, default Supabase
realtime endpoint/key, and no pairing codes in URLs.

Still open:

- [ ] Obtain an operator-issued `read` key (the docs say the dashboard/key UI is
      not built yet; there is no public signup). Add it in the BobSwap… dialog.
- [ ] Verify in two browsers (two Chrome profiles / desktop + phone):
      5 MB workspace, JSON + sqlite files; assert matching visual check, chunk
      progress, sha success, import into current/new profile, abort from either
      side, receiver closed → no stored content.
- [ ] Confirm control-plane behaviour against the live service: `GET` state
      shows `recipient_device` + `visual_check` after join; terminal
      `completed`/`failed`/`aborted` deletes the row; a receiver-cancel DELETE
      makes the sender fail cleanly.
- [ ] Sender UX: a **Copy channel id** button only. Pairing codes must never be
      put in URLs (service policy); do not re-add a `?recv=&code=` link.
- [ ] Refactor the transport behind an injectable factory
      (`type RealtimeFactory`) so the protocol can be tested without Supabase;
      add `web/scripts/relay-protocol-test.mjs` with a fake in-process bus:
      - chunk slicing at exactly 192 KiB (including the empty-file case);
      - retransmit on a lost ack, abort after 3 attempts;
      - sha mismatch → `complete{sha256_ok:false}`, no import;
      - `abort`/close on both roles.
- [ ] Respect `429 Retry-After` in seed and relay calls with backoff + jitter.
- [ ] Seed GETs: send `If-None-Match` from the recorded sha (the server exposes
      a quoted ETag and returns 304) to make repeat pulls cheap.

**Files:** `web/src/swap.ts`, `web/src/profile-ui.ts`, `web/index.html`,
new `web/scripts/relay-protocol-test.mjs`.
**Acceptance:** two real browsers exchange a 5 MB workspace through the deployed
service; abort leaves both sides unchanged; the fake-bus tests pass in CI.

---

## P0-B. Publish hygiene (privacy)

**Why:** `Publish this profile` currently sends the entire profile, which
includes `workspace/logs/grandma-kat.db` (full chat/prompt history), the
in-workspace SQLite DBs, and `.git`. Uploading that to a seed shelf and letting
another device import it leaks conversation history by default.

- [ ] Add a publish confirmation that lists `files / size / what is included`
      and two default-on exclusions:
      - `workspace/logs/` (chat + run log) — excluded by default;
      - `.git/` — excluded by default.
- [ ] Implement the filtering in one place (e.g.
      `buildWorkspaceArchive(root, { exclude })`), reused by publish and,
      optionally, by the relay sender as a “copy without chat history” toggle.
      `make-seed` already applies exactly this curated subset (`app/`,
      `patterns/`, `lib/`, empty log, models template) and
      `npm run seed:publish` now ships its exact bytes, so extracting those
      rules is the missing half.
- [ ] Ensure any seed→profile import strips `workspace/logs/` regardless of what
      the publisher sent (peer relay imports keep logs; seed imports do not).
      `applySeedArchive()` already skips logs **when a local log exists**; add
      an explicit strip for the “new profile from seed” path.
- [ ] Surface the exclusion in the dialog state and in the flash message
      (“published 198 files, 2.1 MB, without chats/git”).

**Files:** `web/src/workspace-transfer.ts`, `web/src/profile-ui.ts`,
`web/src/main.ts` (seed apply), `web/src/swap.ts` (if relay option).
**Acceptance:** publish a profile whose chat log is non-empty → downloaded seed
archive contains no `workspace/logs/` entries; importing it leaves the local
log untouched.

---

## P0-C. Ownership swap (mode `swap`)

**Goal:** finish the BobSwap ownership handshake designed in the API prompt.
Copy mode already transports the archive; swap adds a signed grant and local
receipts. Nothing is stored on the service.

- [ ] `web/src/device-keys.ts`: add
      - `signGrant(grantBytes)` → base64 signature with the stored private JWK;
      - `verifyGrant(publicKeyB64, grantBytes, signature)`.
- [ ] Canonical grant bytes per the API spec:
      `"bobswap-grant|" + toDeviceId + "|" + channelId + "|" + visualCheck + "|" + ts`.
- [ ] `createRelayChannel(..., mode)` with `"copy" | "swap"`; add the handshake
      messages to `RelayMessage`:
      `transfer_request`, `transfer_accept?`, `transfer_grant`, `transfer_done`.
- [ ] Sender UI (`mode: "swap"`): after `sha256_ok`, show
      “Transfer ownership to **phone** (Q7F2)?” requiring an explicit confirm,
      then send the signed grant; on completion write the local release receipt.
- [ ] Receiver: verify the grant against the owner key announced at join, then
      write the new-owner receipt; abort with no local changes on failure.
- [ ] Entry/exit of ownership in the workspace:
      - define `workspace/.owner.json` shape (device id, name, grant signature,
        channel check, ts);
      - copy mode: if the receiver already has a different `.owner.json`, warn
        and default to **not** overwriting;
      - swap mode: recipient writes the new receipt, previous owner rewrites
        theirs as `{released_to, ts}` and its UI stops claiming ownership.
- [ ] Decide whether `.owner.json` participates in seed publication (likely
      exclude, like logs).
- [ ] Tests on the fake transport: valid grant accepted; tampered grant bytes
      rejected; grant for a different device/channel rejected; receipts written
      only on success.

**Files:** `web/src/device-keys.ts`, `web/src/swap.ts`,
`web/src/profile-ui.ts`, `web/src/profiles.ts` (receipt helpers if shared),
`web/index.html`.
**Acceptance:** harness pair completes a swap in both tabs; both receipts exist
with matching signatures; a replayed grant for another device fails; no server
state remains.

---

## P1-D. Seed sync polish

- [ ] Conditional downloads: remember `lastVersion.sha256` and send
      `If-None-Match` on `/latest`; treat `304` as “up to date” instead of
      re-downloading. (Meta GET stays tiny.)
- [ ] Check beyond boot: on window focus and/or a configurable interval, with a
      per-binding throttle (default 15 min). One check per binding; no banner
      spam (`checkedAt` already exists).
- [ ] “Import latest as a new profile…” in the Seed dialog (promised in the
      original plan, currently only reachable via Receive). The new profile’s
      `.seeded` must be the **archive’s** `createdAt`, not the import clock.
- [ ] Add “from BobSwap seed…” as a source in the new-profile form (fetch
      `/latest`, create, import, switch on reload).
- [ ] Distinguish 401/403 (“key rejected”) from 404 (“no such seed”) in the
      dialog status; both currently collapse to “not found / wrong key”.
- [ ] Show OPFS quota + per-profile usage in the Profiles dialog
      (`navigator.storage.estimate()`), warn below ~15% free.
- [ ] Profile rename (registry + directory move); refuse while active in another
      tab.

**Files:** `web/src/swap.ts`, `web/src/profile-ui.ts`, `web/src/profiles.ts`,
`web/index.html`.
**Acceptance:** a second poll within the throttle issues only the meta request;
`304` path imports nothing; a new profile created from a seed shows the seed’s
timestamp and the banner stays silent afterwards.

---

## P1-E. Profiles hardening

- [ ] Migration tests that are not feasible in the pure suite:
      simulate an interrupted migration by writing `/migration.json` with a
      partial `copied` list plus remaining root files, boot, assert resume +
      verification + cleanup;
      simulate a verification failure (delete one target file) and assert the
      originals are kept and boot refuses.
- [ ] Multi-tab awareness: `storage` events on `bob:profile` in another tab →
      show “another tab switched profiles — reload”; deleting a profile that
      another tab is bound to must be refused (currently only the active tab is
      checked).
- [ ] Guard switching/deleting while an agent turn is running (stop the turn or
      refuse with a message).
- [ ] Duplicate/delete failure cleanup: a failed duplicate currently leaves a
      half-written directory (no registry entry) — remove the partial dir on
      error; add a progress indicator for large workspaces.
- [ ] Cache `summarizeWorkspace` results while the Profiles dialog is open
      (it walks every profile).

**Files:** `web/src/profiles.ts`, `web/src/profile-ui.ts`, `web/src/main.ts`.
**Acceptance:** migration resume test passes headlessly; no orphaned profile
directories after forced errors; the running-turn guard is verified in the UI.

---

## P1-F. Desktop mode gaps

- [ ] Bind the single desktop workspace to a seed (same banner/update flow).
      There is no `profiles.json` on the bridge; store the binding in
      localStorage next to `bob:swap` and reuse `applySeedArchive` equivalents
      for the bridge. Decide whether this is worth it before other P1 work.
- [ ] Backward compatibility for older bridges: a missing `/fs/readBytes`
      currently yields a confusing 404 during desktop publish/share. Detect it
      and show “update the storage server (scripts/storage-server.mjs)”.
- [ ] “Desktop (direct folder)” mode (File System Access) is still not wired in
      `main.ts` (only Browser and local-server exist). Out of scope unless the
      direct-folder mode is being revived; if so, profiles must stay off there.

**Files:** `web/src/platform/desktop.ts`, `web/src/swap.ts`,
`web/src/main.ts`, `web/scripts/storage-server.mjs`.
**Acceptance:** a desktop workspace bound to a seed gets the banner and can pull;
old bridge versions fail with an actionable message.

---

## P2-G. Tests and docs

- [ ] Commit the transport-injection protocol tests (P0-A) as
      `npm run test:relay-protocol` in the root and/or `web` package.
- [ ] Add `smoke:relay` with the fake bus so CI can run the two-role flow
      without network.
- [ ] Extend `web/scripts/profile-smoke.mjs`: resume migration, seed-as-new
      profile, and the publish-exclusion assertions (once C lands).
- [ ] Document in `web/README.md`:
      ownership semantics (ground truth lives in the device, swap is notarized
      at pair time), key scopes, publish exclusions, and the two-service config
      fields (REST URL, realtime URL, realtime key).
- [ ] Add a short operator guide for standing up BobSwap next to BOB
      (account/keys/seed naming, CORS headers, realtime event contract).

---

## Sequencing

1. **P0-C publish hygiene** — small, prevents leaking chats now.
2. **P0-A relay verification** — align with the real service, inject the
   transport, add protocol tests. This de-risks the only unproven feature.
3. **P0-C ownership swap** — the remaining missing feature from the original
   three.
4. **P1-D seed polish** + **P1-E profiles hardening**.
5. **P1-F desktop seed binding**, then **P2-G docs/tests**.

## Open decisions (needed before the corresponding task)

- Seed publication defaults: exclude chats + `.git` (recommended) or make it a
  mandatory choice each publish?
- Relay copies keep logs (current) — add an explicit “omit chat history”
  checkbox or leave peer copies complete?
- Ownership fork protection: keep the simple grant + release receipt, or add the
  optional accept-signature chain so a stale owner cannot grant twice? (Only
  needed if two devices are likely to race for ownership.)
- Realtime channels: publishable/public broadcast (current client) or
  token-authenticated private channels (`setAuth`)?
- Profile deletion: hard delete (current) or require/offer an export first?
