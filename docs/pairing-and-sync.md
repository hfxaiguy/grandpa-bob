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

Every profile's workspace lives in this origin's OPFS
(`/profiles/<name>/`). Self-contained per browser; survives reloads (the app
asks for persistent storage at boot and warns if the browser refuses).

A profile can additionally pair with a **desktop/server peer**: the same
WebRTC channel flow as two browsers, with a mirror folder and an allowlisted
exec surface granted on the server console (see
[§6](#6-desktopserver-peer)). The profile record stores the mirror folder name
(`kind: "desktop"`, `folder`).

Desktop folders are registered once with `POST /roots { name, dir }` on the
bridge (the profile dialog does this automatically, defaulting to
`~/.bobkat/folders/<name>`). Registrations live in `~/.bobkat/channels.json`;
each request selects its folder with the `x-bob-root` header. The bridge binds
loopback only: a browser on another machine cannot use a mirror folder on
yours, by design.

The single-host rule is per OPFS profile: one tab owns `opfs:<profile>` at a
time (a **lease**). Other tabs are read-only and offer **take over**. Only the
lease holder runs the mirror, so the shared folder has one writer.

## 2. Same-origin tabs

Tabs of the same browser and origin share a `BroadcastChannel` per workspace,
named `bob-sync:opfs:<profileName>`:

- **same profile, multiple tabs** — converge with no setup; only the lease
  holder runs the engine, the others are read-only.
- **different profiles** (even on the same machine) — these are different
  workspaces and different channels. Pair them through the dialog if you want
  that.

## 3. Cross-device pairing

Open **Sync… → Live sync → Pair…**. Both tabs must host their own workspace
(a read-only tab says "take over the workspace first"). The dialog is one code
field plus a source switch — **Another tab / relay** (BobSwap) or **My desktop /
server** — so the code is the only thing to exchange. The relay and desktop
paths share the same code flow (§6 covers the desktop side); manual paste is
the no-service fallback.

### BobSwap REST (automatic, needs a service)

The client targets the sync-channel contract documented at `/docs/agents` on
the service:

1. Offerer clicks **Create a code** → `POST /api/v1/sync/channels` returns an
   internal channel id, a **single-use 8-digit code** (`XXXX-XXXX`), a role
   token and optional `ice_servers` (STUN and, when deployed, TURN — no client
   release needed to add TURN). The dialog shows only the code; the channel id
   stays in client state for signaling.
2. Share the code by any means (Telegram is the obvious one).
3. The joiner enters it and clicks **Pair with code** → `POST
   /api/v1/sync/channels/join` spends the code, resolves the channel and
   returns the channel id, a role token and the ICE servers. The service
   answers one opaque `invalid pairing code` for wrong, spent or expired
   codes, with a per-IP join rate limit.
4. Offer, answer and trickled ICE candidates travel through the signal
   mailbox; the client polls it. **Only SDP/ICE metadata touches the service**
   — never workspace content.
5. When the data channel opens, both sides display the verification phrase
   (next section).

The service keeps `POST /api/v1/sync/channels/{channel_id}/join` as a
deprecated alias for one release; the UI never asks for a channel id. If the
service has not deployed the code-only join yet, the dialog says so and manual
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

### Two profiles on one machine

```sh
npm run build
npm run bob     # app :8080 + bridge/mailbox :8795, loopback
```

1. Tab 1: `http://localhost:8080` → activate profile A.
2. Tab 2: `http://localhost:8080` → activate profile B.
3. Sync… → Pair… on both → **Another tab / relay** (code) or manual blob →
   compare phrase.
4. Keep both tabs open. Each workspace is complete and self-sufficient; the
   pair keeps them converged.

### Server ↔ remote browser (phone or another computer)

The app server and channels are loopback-only, so serve **only the static app**
over the LAN from the server; the bridge is never exposed:

```sh
npm run build
npm run bob                                     # app + bridge, loopback
HOST=0.0.0.0 PORT=8081 npm run web:standalone   # app-only static files on the LAN
```

1. On the server: `http://localhost:8080`.
2. On the other device: `http://<server-lan-ip>:8081` (its own OPFS at that
   origin; a mirror binding is per machine).
3. Sync… → Pair… → **Another tab / relay** (code only) or manual blobs.
4. Compare the phrase; keep both tabs open while you want them converged.

Firewall: allow the static port (8081 above), not the bridge.

### Two machines with a mirror folder on each

Each machine runs `npm run bob`, each tab binds a mirror folder on its own
machine, and the two tabs pair over WebRTC. Folders never leave their
machines; only file contents flow, peer-to-peer.

## 5. Data and backup model

A pair is **two independent copies**, not a cache hierarchy:

- Every profile = complete copy in browser storage.
- A desktop mirror = a synced copy in the folder (OPFS remains canonical; a
  divergent desktop edit becomes a `.conflict-*` file next to it).
- The replica journal (`.gpb-sync/journal.jsonl`) lives in each workspace and
  is how deferred changes catch up; it is never mirrored to the desktop.
- No **signaling/relay service** receives workspace bytes (SDP/ICE only). A
  paired desktop/server is a peer endpoint whose mirror folder deliberately
  holds a copy. Git remotes, if configured, are a separate optional
  backup/versioning path and still carry DB dumps under `logs/scratch` for
  cross-device database continuity.

## 6. Desktop/server peer

A desktop/server is another peer, not a storage mode. Pairing is the same
channel flow used between two browsers:

1. On the desktop/server, `npm run pair` creates a mailbox channel on the
   combined process's `:8795` and prints a single-use 8-digit code, the
   mirror folder and requested exec allowlist. The tab's active profile must
   match `--profile` (default `default`), while `--mirror` / `--mirror-path`
   pick the folder independently — so one desktop can host a separate mirror
   per browser profile. (`--exec git,make,…` grants ops; `--list` /
   `--revoke <profile>` manage paired profiles.) Codes and pairing sessions
   live in the `npm run bob` process: restarting it invalidates any open code,
   so run `npm run pair` again after a restart.
2. In the tab, **Sync… → Pair… → Pair with a code**, select **My desktop /
   server**, and enter the code — no channel id. The dialog shows the active
   profile and, once the channel opens, the mirror + exec capabilities the
   console is approving. Both sides derive the same SAS from the DTLS
   fingerprints; the operator compares it on the console before approving.
3. On approval the server mints a per-profile **client key** and the tab pins
   a per-profile **server proof key**. Reconnects use a client-key channel and
   mutual HMAC proofs — no human step. Revoking on the server drops the key and
   live channel.
4. First pairing: a non-empty desktop folder replaces the profile's workspace;
   an empty folder receives the tab's workspace. The Node peer runs the same
   `rtcPeer` + `SyncEngine` (werift polyfill); its journal lives in
   `~/.bobkat/peers/<profile>/`, never in the mirror folder.
5. Exec is the `ShellTools` allowlist (`execFile`, cwd, argument escape guard,
   git deny, timeout/output caps), never a shell string. The agent worker
   routes only allowlisted commands over a `MessagePort`; other shell commands
   keep using the local virtual shell. Changed files converge before the tool
   result returns; divergent paths keep both copies.

The product process does not mount `/fs`, `/git`, `/sql` or `/roots`; the
standalone `storage-server` CLI keeps them for tests/debug. Only `/health` and
the opt-in `/stt` remain on the channel server.

## 7. Troubleshooting

| Symptom | Meaning |
|---|---|
| "this tab does not host the workspace — take over the workspace first" | Only the lease holder can pair. Use the lease banner's **take over**. |
| "not running here — this tab is not the workspace host" | The Live sync status of a read-only tab. |
| "sync channels may not be deployed yet" | The BobSwap service lacks `/api/v1/sync/channels…`; use manual paste. |
| "this relay has no single-code join" | The relay predates code-only pairing; update it, or switch the Pair dialog to **My desktop / server**. Manual paste still works. |
| "invalid pairing code" | The code is wrong, already spent or older than 10 minutes. Create a new one on the other device. A 429 means the per-IP join rate limit; wait for `Retry-After`. |
| `BobSwap signal poll: HTTP 404` / "the pairing session is gone" | The browser joined, then the bridge lost the channel — usually `npm run bob` was restarted or the pairing session was closed before approval. Rerun `npm run pair` and use the new code; the desktop console prints the first error (profile mismatch, denial, or session timeout). |
| "pairing failed: NetworkError when attempting to fetch resource." / `cannot reach http://…` | The tab could not reach the mailbox. Open the app at `http://localhost:8080` or `http://127.0.0.1:8080` on the machine running `npm run bob`; in **My desktop / server** open **Advanced** and check the mailbox URL (`http://127.0.0.1:8795`), then check `/health` in that tab. A browser on another device cannot reach the loopback mailbox — pair browser↔browser instead. |
| `origin https://… is not allowed` | The page origin is not on the bridge allowlist. Use the locally served app, or add the exact `https://` origin to `BOB_APP_ORIGINS` and restart `npm run bob`. The default allows loopback and `https://bobkat.hfxaiguy.com`. |
| Local Network Access prompt / `Permission was denied … loopback address space` | Chrome/Edge blocks a public HTTPS page from reaching `127.0.0.1` until the site is allowed. Allow Local Network Access for the hosted origin in the browser's site settings, then restart `npm run bob` so the bridge sends `Access-Control-Allow-Private-Network: true` on CORS preflights. The app served at `http://localhost:8080` avoids the prompt. |
| "pairing failed: connection failed" before approval | ICE could not connect. Firefox/Firedragon may hide host candidates as `<uuid>.local`; the bridge now rewrites those to its own local IPv4 addresses, so restart `npm run bob` on the current build. The mirror folder does not exist yet by design — it is created only after approval. |
| "data channel never opened" | NAT/firewall; try same-LAN, or configure TURN via a service's `ice_servers`. |
| Phrases differ | Do not trust the link — signaling was altered or the peers see different certificates; close and retry. |
| "this code is for browser profile …" | The tab's active profile differs from the console's `--profile`; switch to that profile or rerun `npm run pair -- --profile <tab profile>`. |
| Pair connected but files don't move | Both tabs must stay open; check the Live sync status line and the conflict counter. |
| "opfs-sahpool" / persistence warnings | The browser refused persistent origin storage; the workspace still works but can be evicted. |
| `desktop: offline` chip | `npm run bob` is not running, the mailbox URL is wrong, or the profile needs re-pairing (`npm run pair`). |
| `desktop: sync error` / no ops | The server console has not approved exec, or the command is not in its allowlist. |
| Paired but the mirror is stale | Both sides must be reachable; the desktop peer reconnects with its client key, and `npm run pair -- --list` shows the registered profiles. |
