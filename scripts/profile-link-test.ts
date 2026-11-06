/**
 * ProfileLink: phrase gate, catalog/consent exchange and per-profile
 * multiplexing, over an in-memory SyncPeer pair.
 *
 * Run: `npm run test:profile-link`.
 */
import assert from "node:assert/strict";
import type { SyncEnvelope, SyncPeer } from "../web/src/sync/engine.js";
import { controlPeer } from "../web/src/sync/control-peer.js";
import { ProfileLink } from "../web/src/sync/profile-link.js";

function wire(): [SyncPeer, SyncPeer] {
  let leftHandler: ((envelope: SyncEnvelope) => void) | null = null;
  let rightHandler: ((envelope: SyncEnvelope) => void) | null = null;
  let closed = false;
  const left: SyncPeer = {
    id: "left",
    send: (envelope) => queueMicrotask(() => rightHandler?.(structuredClone(envelope))),
    connected: () => !closed,
    onMessage: (cb) => (leftHandler = cb),
    onClosed: () => undefined,
    close: () => (closed = true),
  };
  const right: SyncPeer = {
    id: "right",
    send: (envelope) => queueMicrotask(() => leftHandler?.(structuredClone(envelope))),
    connected: () => !closed,
    onMessage: (cb) => (rightHandler = cb),
    onClosed: () => undefined,
    close: () => (closed = true),
  };
  return [left, right];
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const [leftWire, rightWire] = wire();
const leftCatalogs: unknown[] = [];
const rightCatalogs: unknown[] = [];
const leftConsent: Record<string, boolean>[] = [];
const rightConsent: Record<string, boolean>[] = [];

const left = new ProfileLink(leftWire, {
  deviceId: "device-left",
  deviceName: "laptop",
  catalog: [{ id: A, name: "travel", createdAt: "2026-01-01T00:00:00.000Z" }],
  consent: { [A]: true },
  peerId: "engine",
  requirePhrase: true,
  onCatalog: (catalog) => leftCatalogs.push(catalog),
  onConsent: (consent) => leftConsent.push(consent),
});
const right = new ProfileLink(rightWire, {
  deviceId: "device-right",
  deviceName: "phone",
  catalog: [{ id: B, name: "work", createdAt: "2026-02-01T00:00:00.000Z" }],
  consent: { [B]: false },
  peerId: "engine",
  requirePhrase: true,
  onCatalog: (catalog) => rightCatalogs.push(catalog),
  onConsent: (consent) => rightConsent.push(consent),
});

left.start();
right.start();
await tick();
assert.equal(leftCatalogs.length, 0, "no catalog moves before the phrase gate");
assert.equal(rightCatalogs.length, 0);

// Data also cannot cross before confirmation.
let delivered = 0;
const leftTravel = left.peerFor(A);
leftTravel.onMessage(() => delivered++);
right.peerFor(B).send({ v: 1, kind: "ops", from: "engine", profile: B, ops: [] });
await tick();
assert.equal(delivered, 0, "no data frame moves before the phrase gate");

left.confirmPhrase();
await tick();
assert.equal(leftCatalogs.length, 0, "one confirmation is not enough");
right.confirmPhrase();
await tick();
assert.equal(leftCatalogs.length, 1, "left received the right catalog");
assert.equal(rightCatalogs.length, 1, "right received the left catalog");
assert.equal(leftCatalogs[0] && (leftCatalogs[0] as Array<{ id: string }>)[0].id, B);
assert.equal(leftConsent[0]?.[B], false);
assert.equal(rightConsent[0]?.[A], true);

// Per-profile routing, including a frame that arrived before the handler was
// registered (the consent-then-attach window).
const rightWork = right.peerFor(B);
let rightDelivered = 0;
rightWork.onMessage(() => rightDelivered++);
left.peerFor(B).send({ v: 1, kind: "ops", from: "engine", profile: B, ops: [] });
await tick();
assert.equal(rightDelivered, 1, "the tagged frame reaches the matching profile");

// Detaching one profile leaves the link open for the other.
right.detachProfile(B);
left.peerFor(B).send({ v: 1, kind: "ops", from: "engine", profile: B, ops: [] });
await tick();
assert.equal(rightDelivered, 1, "a detached profile receives nothing");
assert.equal(rightWire.connected(), true, "the device link stays up");

// A mismatch aborts before any catalog.
const [aWire, bWire] = wire();
let rejected = "";
const a = new ProfileLink(aWire, {
  deviceId: "a",
  deviceName: "a",
  catalog: [],
  consent: {},
  peerId: "engine",
  requirePhrase: true,
  onPhraseRejected: (reason) => (rejected = reason),
});
const bCatalogs: unknown[] = [];
const b = new ProfileLink(bWire, {
  deviceId: "b",
  deviceName: "b",
  catalog: [{ id: A, name: "travel", createdAt: "x" }],
  consent: {},
  peerId: "engine",
  requirePhrase: true,
  onCatalog: (catalog) => bCatalogs.push(catalog),
});
a.start();
b.start();
a.rejectPhrase("different words");
await tick();
assert.match(rejected, /different words/);
assert.equal(bCatalogs.length, 0, "a rejected phrase never releases the catalog");

// Preview metadata is answered only after this side allowed the profile, and
// the consent frame is ordered before the preview request on the same link.
const [previewWireA, previewWireB] = wire();
const C = "33333333-3333-4333-8333-333333333333";
let answererConsent: Record<string, boolean> = {};
const previewRequester = new ProfileLink(previewWireA, {
  deviceId: "preview-requester",
  deviceName: "phone",
  catalog: [],
  consent: {},
  peerId: "engine",
  requirePhrase: false,
});
const previewAnswerer = new ProfileLink(previewWireB, {
  deviceId: "preview-answerer",
  deviceName: "desktop",
  catalog: [{ id: C, name: "centre", createdAt: "2026-03-01T00:00:00.000Z" }],
  consent: { [C]: true },
  peerId: "engine",
  requirePhrase: false,
  onConsent: (consent) => {
    answererConsent = consent;
  },
  onPreviewRequest: async (profileId) =>
    answererConsent[profileId] === true
      ? { id: profileId, files: 3, bytes: 42, updatedAt: "2026-03-01T00:00:00.000Z" }
      : null,
});
previewRequester.start();
previewAnswerer.start();
await tick();
assert.equal(await previewRequester.requestPreview(C), null, "no preview before consent");
previewRequester.setConsent({ [C]: true });
await tick();
const preview = await previewRequester.requestPreview(C);
assert.equal(preview?.files, 3, "preview answers after the local allow is sent");
assert.equal(preview?.bytes, 42);

// A ProfileLink on a controlPeer still receives profile controls: the
// desktop/server ServerConnection wraps its transport that way, and the
// profile multiplexer must not be starved by the handshake control handler.
const [wrappedWire, rawWire] = wire();
const D = "44444444-4444-4444-8444-444444444444";
const wrappedCatalogs: unknown[] = [];
const wrapped = controlPeer(wrappedWire, () => undefined);
const linkOnWrapped = new ProfileLink(wrapped, {
  deviceId: "wrapped",
  deviceName: "wrapped",
  catalog: [],
  consent: {},
  peerId: "engine",
  requirePhrase: false,
  onCatalog: (catalog) => wrappedCatalogs.push(catalog),
});
const linkOnRaw = new ProfileLink(rawWire, {
  deviceId: "raw",
  deviceName: "raw",
  catalog: [{ id: D, name: "centre", createdAt: "2026-04-01T00:00:00.000Z" }],
  consent: {},
  peerId: "engine",
  requirePhrase: false,
});
linkOnWrapped.start();
linkOnRaw.start();
await tick();
assert.equal(wrappedCatalogs.length, 1, "a ProfileLink on a controlPeer receives the catalog");

console.log("profile-link: phrase gate, catalog, consent and mux OK");
