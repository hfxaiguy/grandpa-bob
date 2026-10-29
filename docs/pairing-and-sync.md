# Pairing and sync

How a workspace is stored, how replicas converge, and how to pair two devices.
This is the long form of what the **Sync…** dialog does; the code lives in
`web/src/sync/` (journal, engine, transports) and `web/src/sync-ui.ts`.

Two different mechanisms share the word "sync":

| | Git | Replica sync (this document's main subject) |
|---|---|---|
| What moves | commits, plus SQL dumps of app DBs | workspace files, peer-to-peer |
| Where | git remote (push/pull, 5-min auto-sync) | WebRTC DataChannel (cross-device) or BroadcastChannel (same-origin tabs) |
| History | yes — per-write commits, agent `git_*` tools | no — the journal is not a history |
| Server sees | whatever your git remote sees | nothing but SDP/ICE; no workspace bytes |

Git history stays **per replica**: `.git/`, `logs/`, `.gpb-*` and
`assets/inbox/` are excluded from replica sync.

## 1. Where a workspace lives

Every profile has a `kind`:

- **`opfs`** — the workspace is inside the browser's origin storage
  (`/profiles/<name>/`). Self-contained per browser; survives reloads (the app
  asks for persistent storage at boot and warns if the browser refuses).
- **`desktop`** — the workspace is a **real folder on disk**, served by the
  loopback storage bridge. The profile record stores a `folder` root name.

Desktop folders are registered once with `POST /roots { name, dir }` on the
bridge (the picker does this automatically, defaulting to
`~/.bobkat/folders/<name>`). Registrations live in `~/.bobkat/channels.json`;
each request selects its folder with the `x-bob-root` header. The bridge binds
loopback only: a browser on another machine cannot use a desktop profile on
yours, by design.

Both kinds share the same single-host rule: one tab owns a workspace at a time
(a **lease**). The lease key is per workspace — `opfs:<profile>` or
`desktop:<server>` — so a desktop-profile tab and an OPFS-profile tab can both
be hosts at once. Other tabs are read-only and offer **take over**.

## 2. Same-origin tabs

Tabs of the same browser and origin share a `BroadcastChannel` per workspace,
named `bob-sync:<storageMode>:<profileName>`:

- **same workspace, multiple tabs** — converge with no setup; only the lease
  holder runs the engine, the others are read-only.
- **different profiles** (even on the same machine) — these are different
  workspaces and different channels. An OPFS profile and a desktop profile do
  **not** auto-converge; pair them through the dialog if you want that.

## 3. Cross-device pairing

Open **Sync… → Live sync → Pair…**. Both tabs must host their own workspace
(a read-only tab says "take over the workspace first"). Two signaling paths:

### BobSwap REST (automatic, needs a service)

The client targets the sync-channel contract documented at `/docs/agents` on
the service:

1. Offerer clicks **Create a channel** → `POST /api/v1/sync/channels` returns a
   channel id, a **single-use pairing code**, a role token, and optional
   `ice_servers` (STUN and, when deployed, TURN — no client release needed to
   add TURN).
2. Share the channel id + code by any means (Telegram is the obvious one).
3. The joiner enters both and clicks **Join a channel** → the code is spent,
   and the service returns a role token and the ICE servers.
4. Offer, answer and trickled ICE candidates travel through the signal
   mailbox; the client polls it. **Only SDP/ICE metadata touches the service**
   — never workspace content.
5. When the data channel opens, both sides display the verification phrase
   (next section).

If the service has not deployed those endpoints, the dialog says so and manual
paste remains the fallback.

### Manual paste (no service)

1. Offerer: **Create an offer** → non-trickle ICE (all candidates gathered,
   ~4 s cap) → one base64 blob.
2. Send the blob to the other device however you like.
3. Joiner: paste it into **"Paste the other device's blob here"** →
   **Join with an offer** → an answer blob appears.
4. Send the answer back; the offerer pastes it and clicks
   **Finish pairing (use the answer)**.
5. Compare the verification phrase on both screens.

Manual paste uses the built-in STUN fallback only, so same-LAN pairs work
reliably; cross-NAT may fail until a service provides TURN.

### The verification phrase (SAS)

Six words (e.g. `harbor-granite-igloo-fjord-igloo-harbor`) derived from the
connection's **DTLS certificate fingerprints**:

- The seed is the set of `a=fingerprint:` values from **both** SDPs — local and
  peer — deduped and sorted, so each side hashes the identical input and both
  display the same words.
- **Compare them on the two devices.** A signaling relay that substitutes its
  own certificate changes the remote fingerprints, so the phrases stop
  matching. That is the entire point: the relay is untrusted.
- The phrase is verified **between the devices, never on/through the server**;
  there is no server endpoint for it.

### What happens after the handshake

The engines exchange replica id + Lamport clock, then reconcile **pull-only**:
both sides compute the same winner per path (highest origin Lamport, ties to
the smaller replica id). The loser's bytes are preserved as
`<path>.conflict-<timestamp>` and not synced. Deletions travel as tombstones.
A side that was closed journals its changes and catches up on the next
connection — nothing needs to be re-paired if the pair is still open.

**Close cross-device pairing** tears down only the WebRTC pair; same-origin
tabs keep syncing.

## 4. Concrete setups

### Browser copy + desktop folder on one machine

```sh
npm run build
npm run bob     # app :8080 + bridge/mailbox :8795, loopback
```

1. Tab 1: `http://localhost:8080` → activate the **desktop** profile.
2. Tab 2: `http://localhost:8080` → activate an **OPFS** profile.
3. Sync… → Pair… on both → BobSwap channel or manual blob → compare phrase.
4. Keep both tabs open. Each store is complete and self-sufficient; the pair
   keeps them converged.

### Server ↔ remote browser (phone or another computer)

The app server and channels are loopback-only, so serve **only the static app**
over the LAN from the server; the bridge is never exposed:

```sh
npm run build
npm run bob                                     # desktop profile + bridge, loopback
HOST=0.0.0.0 PORT=8081 npm run web:standalone   # app-only static files on the LAN
```

1. On the server: `http://localhost:8080` → desktop profile active.
2. On the other device: `http://<server-lan-ip>:8081` (own OPFS at that
   origin; no bridge there — desktop profiles are per machine).
3. Sync… → Pair… → BobSwap channel (id + code) or manual blobs.
4. Compare the phrase; keep both tabs open while you want them converged.

Firewall: allow the static port (8081 above), not the bridge.

### Two machines with a folder on each

Each machine runs `npm run bob`, each tab activates its own desktop profile,
and the two tabs pair over WebRTC. Folders never leave their machines; only
file contents flow, peer-to-peer.

## 5. Data and backup model

A pair is **two independent copies**, not a cache hierarchy:

- OPFS profile = complete copy in browser storage.
- Desktop profile = complete copy in the folder (the bridge proxies every
  read/write; there is no hidden OPFS staging copy).
- The replica journal (`.gpb-sync/journal.jsonl`) lives in each workspace and
  is how deferred changes catch up.
- No server ever receives workspace bytes. Git remotes, if configured, are a
  separate optional backup/versioning path and still carry DB dumps under
  `logs/scratch` for cross-device database continuity.

## 6. Troubleshooting

| Symptom | Meaning |
|---|---|
| "this tab does not host the workspace — take over the workspace first" | Only the lease holder can pair. Use the lease banner's **take over**. |
| "not running here — this tab is not the workspace host" | The Live sync status of a read-only tab. |
| "sync channels may not be deployed yet" | The BobSwap service lacks `/api/v1/sync/channels…`; use manual paste. |
| "data channel never opened" | NAT/firewall; try same-LAN, or configure TURN via a service's `ice_servers`. |
| Phrases differ | Do not trust the link — signaling was altered or the peers see different certificates; close and retry. |
| Pair connected but files don't move | Both tabs must stay open; check the Live sync status line and the conflict counter. |
| "opfs-sahpool" / persistence warnings | The browser refused persistent origin storage; the workspace still works but can be evicted. |
| "desktop bridge unreachable" | `npm run bob` (or `storage-server`) is not running on the desktop. |
