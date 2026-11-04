/**
 * Pure profile-sync model: catalog normalization, one-time auto-link, consent
 * intersection and the flattened dialog rows.
 *
 * Run: `npm run test:profile-sync`.
 */
import assert from "node:assert/strict";
import {
  autoLinkProfiles,
  buildProfileRows,
  canonicalProfileId,
  defaultLocalConsent,
  effectiveAllow,
  parsePeerStore,
  remapPeerConsent,
  upsertPeer,
  type PeerSyncStore,
} from "../web/src/profile-sync-model.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const older = { id: A, name: "travel", createdAt: "2026-01-01T00:00:00.000Z" };
const newer = { id: B, name: "travel", createdAt: "2026-02-01T00:00:00.000Z" };

assert.equal(canonicalProfileId(older, newer), A, "the older profile id wins");
assert.equal(canonicalProfileId(newer, older), A, "the rule is order-independent");
assert.equal(
  canonicalProfileId(
    { ...older, createdAt: "same" },
    { ...newer, createdAt: "same" },
  ),
  A,
  "a tie falls back to the lexicographically smaller id",
);

const link = autoLinkProfiles([newer], [older], { linkedNames: [], unlinkedIds: [] });
assert.deepEqual(link, [
  {
    id: A,
    remoteId: A,
    name: "travel",
    adoptLocal: { from: B, to: A },
  },
]);

assert.deepEqual(
  autoLinkProfiles([newer], [older], { linkedNames: ["travel"], unlinkedIds: [] }),
  [],
  "a name is auto-linked at most once",
);
assert.deepEqual(
  autoLinkProfiles([newer], [older], { linkedNames: [], unlinkedIds: [B] }),
  [],
  "an unlinked profile is never auto-linked again",
);
assert.deepEqual(
  autoLinkProfiles([{ ...newer, id: A }], [{ ...older, id: A }], {
    linkedNames: [],
    unlinkedIds: [],
  }),
  [],
  "matching ids are already linked",
);

const consent = defaultLocalConsent([{ ...older, createdAt: "" }], [older]);
assert.equal(consent[A], true, "an existing same-id profile starts allowed");
const remoteOnly = defaultLocalConsent([{ ...newer, createdAt: "" }], [older]);
assert.equal(remoteOnly[B], false, "a profile the peer lacks starts denied");
assert.equal(effectiveAllow({ [A]: true }, { [A]: true }, A), true);
assert.equal(effectiveAllow({ [A]: true }, { [A]: false }, A), false, "either veto wins");
assert.equal(effectiveAllow({ [A]: false }, { [A]: true }, A), false);

const store: PeerSyncStore = {
  version: 1,
  peers: {
    peer1: {
      peerId: "peer1",
      deviceName: "phone",
      lastSeen: "now",
      profiles: [older],
      localAllow: { [B]: true },
      remoteAllow: { [A]: true },
      linkedNames: [],
      unlinkedIds: [],
    },
  },
};
const remapped = remapPeerConsent(store, B, A);
assert.equal(remapped.peers.peer1.localAllow[A], true);
assert.equal(remapped.peers.peer1.localAllow[B], undefined);
assert.equal(remapped.peers.peer1.remoteAllow[A], true, "existing remote consent wins");

const upserted = upsertPeer(
  { version: 1, peers: {} },
  {
    peerId: "peer1",
    deviceName: "phone",
    profiles: [older],
    catalog: [{ ...newer, createdAt: "" }],
    links: [link[0]],
  },
);
assert.equal(upserted.peers.peer1.profiles[0].id, A, "the remote catalog is canonicalized");
assert.equal(upserted.peers.peer1.localAllow[A], true);
assert.deepEqual(upserted.peers.peer1.linkedNames, ["travel"]);

const rows = buildProfileRows(
  [
    { id: A, name: "travel", createdAt: "x" },
    { id: C, name: "work", createdAt: "y" },
  ],
  [
    {
      peerId: "peer1",
      deviceName: "phone",
      lastSeen: "now",
      profiles: [older, { id: B, name: "phone-only", createdAt: "z" }],
      localAllow: { [A]: true, [B]: true, [C]: false },
      remoteAllow: { [A]: true, [B]: true, [C]: true },
      linkedNames: [],
      unlinkedIds: [],
    },
  ],
);
const travel = rows.find((row) => row.id === A)!;
assert.equal(travel.remoteOnly, false);
assert.equal(travel.peers[0].allowed, true);
const work = rows.find((row) => row.id === C)!;
assert.equal(work.peers[0].present, false);
assert.equal(work.peers[0].allowed, false, "a peer that lacks the profile cannot sync it");
const phoneOnly = rows.find((row) => row.id === B)!;
assert.equal(phoneOnly.remoteOnly, true);
assert.equal(phoneOnly.name, "phone-only");

const parsed = parsePeerStore(JSON.parse(JSON.stringify(upserted)));
assert.equal(parsed.peers.peer1.profiles[0].id, A);
assert.equal(parsed.peers.peer1.localAllow[A], true);

console.log("profile-sync test: all assertions passed");
