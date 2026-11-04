# Profile identity + per-peer sync matrix

Status: implemented with this plan (2026-11-03). Supersedes the single-profile
pairing assumptions in `bob-profiles-seeds-relay-remaining.md` where they
conflict.

## Goal

Profiles become durable identities (UUID) instead of local names. After two Bob
instances pair, each side can see the other's profile catalog and choose, per
profile **and** per peer, whether that profile syncs. The browser Profiles
dialog grows an expandable peer list under each profile row. Remote-only
profiles are visible with a preview and an explicit pull confirmation.

## Decisions

- `ProfileRecord.id` is a UUID and the identity. `name` is a mutable label.
- Registry version 2. Version 1 registries migrate by assigning UUIDs; the
  localStorage mirror is migrated at the same time.
- Pairing exchanges a catalog: `{id, name, presence}` plus `createdAt` only for
  the one-time name auto-link rule (see below). No size/file metadata in the
  catalog.
- Auto-link once by name. Canonical UUID is the older `createdAt`; ties go to
  the lexicographically smaller UUID. Both sides rewrite to the canonical id.
  An Unlink action records the pair so it is not auto-linked again.
- Consent is stored per local profile × peer. Both sides must allow. Effective
  sync is the intersection. Unchecking either side immediately detaches that
  profile's virtual peer and drops in-flight frames for it.
- Defaults: an auto-linked existing profile starts allowed on both sides; new
  or remote-only profiles start denied.
- No polling. Catalog/consent are exchanged once when a connection opens, then
  pushed as deltas. Each profile engine reconciles once when attached; after
  that it receives pushes.
- Remote-only pull: request preview (size/files/modified), confirm locally, and
  only then create the local profile. The peer must have allowed it before the
  preview is answered.
- Deletion is local-only. No tombstones; a peer's copy can reappear as
  remote-only and must be requested again.
- Re-pair/revoke resets that peer's consent to defaults.
- Phrase confirmation is explicit on both ends. No catalog or file frame moves
  until both confirm. Browser ↔ browser uses a control gate; browser ↔ desktop
  uses the CLI approval prompt as the desktop confirmation and a browser button
  before `ready`. Reconnects skip it.
- Desktop is part of this phase: device-level pairing (`--profile` optional),
  one link, per-profile mirror folders with `.bob-profile.json` manifests, and
  a bridge-side catalog/consent/mux. The desktop host stays headless; consent
  defaults to allow for auto-linked profiles and can be changed with
  `npm run pair -- --deny/--allow`.

## Phases

1. **Identity.** `web/src/profiles.ts`: v2 registry, UUID validation, v1
   migration, id-based helpers, id-preserving mutators. Tests in
   `scripts/profiles-test.ts`.
2. **Catalog + policy.** New `web/src/profile-sync-model.ts`: catalog entry,
   auto-link, union rows, consent store, preview types. Pure tests in
   `scripts/profile-sync-test.ts`.
3. **Link protocol.** `web/src/sync/profile-link.ts`: phrase gate, catalog and
   consent exchange, per-profile virtual peer mux, preview request/response.
   `SyncEnvelope.profile` added in `engine.ts`.
4. **Multi-profile manager.** `web/src/sync/index.ts` owns one engine per
   profile (lazy), BroadcastChannel per profile, and device links. Active
   profile keeps the existing `SyncHandle` surface.
5. **Browser UI.** `web/src/profile-ui.ts` + `web/index.html`: expandable
   profile rows, peer checkboxes, remote-only rows, preview/confirm, unlink.
   `web/src/sync-ui.ts`: phrase confirmation buttons on both pairing paths.
6. **Desktop.** `src/bridge/profiles.ts` (state-dir profile catalog +
   manifests), `src/bridge/peer.ts` reworked around `ProfileLink`, device-level
   pairing in `src/bridge/server.ts`, and CLI flags in `scripts/pair.ts`.
7. **Tests/docs.** Update profiles/desktop tests, add sync-model tests, run
   typecheck + targeted tests. README notes for the new flow.

## Acceptance

- Two browsers with same-named profiles auto-link to one UUID and show the
  other peer under the profile row.
- Unchecking on either side stops that profile's transfer immediately; files
  already received remain.
- A profile existing only on the peer appears as remote-only; checking it asks
  for a preview and only creates after confirmation.
- Neither side exchanges catalog or file data before both phrase confirmations.
- Desktop pairing yields a catalog with browser-only, desktop-only and shared
  profiles without a second `npm run pair`.
- `npm run typecheck`, `npm run test:profiles`, `npm run test:sync`, and
  `npm run test:desktop-profile` pass.
