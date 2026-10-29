// Offline test of the sync engine (`web/src/sync/engine.ts`).
//
// Two Node-backed workspaces in temp dirs sync through an in-memory wire
// (a SyncPeer pair delivering envelopes between the engines' handlers, like
// a real transport would). Covers the reconcile contract:
//
//   mine-only pushes · theirs-only pulls
//   divergent edits from a common ancestor → the higher journal seq wins
//   dead heat (both wrote once since the last sync) → conflict copy
//   tombstones propagate (a delete beats an older write)
//
// Run: `npm run test:sync`.
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodePlatform } from "../src/platform/node.js";
import { SyncEngine, type SyncEnvelope, type SyncPeer } from "../web/src/sync/engine";
import { Journal } from "../web/src/sync/journal";
import { toIceServers } from "../web/src/sync/transport-webrtc";

/** An in-memory wire: deliveries land on whichever handler is registered. */
class FakePeer implements SyncPeer {
  readonly id: string;
  counterpart: FakePeer | null = null;
  private handler: ((e: SyncEnvelope) => void) | null = null;

  constructor(id: string) {
    this.id = id;
  }

  static pair(idA: string, idB: string): [FakePeer, FakePeer] {
    const a = new FakePeer(idA);
    const b = new FakePeer(idB);
    a.counterpart = b;
    b.counterpart = a;
    return [a, b];
  }

  send(envelope: SyncEnvelope): void {
    queueMicrotask(() => this.counterpart?.deliver(envelope));
  }
  private deliver(envelope: SyncEnvelope): void {
    queueMicrotask(() => this.handler?.(envelope));
  }
  connected(): boolean {
    return this.counterpart !== null;
  }
  onMessage(cb: (e: SyncEnvelope) => void): void {
    this.handler = cb;
  }
  onClosed(): void {}
  close(): void {
    this.counterpart = null;
  }
}

const dirA = await mkdtemp(path.join(os.tmpdir(), "sync-a-"));
const dirB = await mkdtemp(path.join(os.tmpdir(), "sync-b-"));

const platformA = createNodePlatform(dirA);
const platformB = createNodePlatform(dirB);

const engineA = new SyncEngine(platformA, "replica-a");
const engineB = new SyncEngine(platformB, "replica-b");

const [wireA, wireB] = FakePeer.pair("wire-a", "wire-b");
engineA.attach(wireA);
engineB.attach(wireB);

const abs = (platform: typeof platformA, name: string): string =>
  platform.path.join(platform.workspaceRoot, name);

/** Wait until a predicate about the replica states holds. */
async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const fileIs = async (platform: typeof platformA, name: string, want: string): Promise<boolean> =>
  (await readFile(platform.path.join(platform.workspaceRoot, name), "utf8").catch(() => null)) === want;
const fileGone = async (platform: typeof platformA, name: string): Promise<boolean> =>
  platform.fs.stat(platform.path.join(platform.workspaceRoot, name)).then(() => false).catch(() => true);

/** Let queued microtasks/timers drain. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

try {
  // ── round 1: different files on each side converge ────────────────────
  // The app drives mutations through noteMutation (the git autoCommit seam):
  // each call journals the op and pushes it to the connected peer.
  await platformA.fs.writeFile(abs(platformA, "notes.md"), "from A\n");
  await platformB.fs.writeFile(abs(platformB, "todo.md"), "from B\n");
  await engineA.noteMutation(["notes.md"]);
  await engineB.noteMutation(["todo.md"]);
  await waitFor(async () => (await fileIs(platformA, "todo.md", "from B\n")) && (await fileIs(platformB, "notes.md", "from A\n")), "round 1 convergence");
  assert.equal(await readFile(abs(platformA, "todo.md"), "utf8"), "from B\n", "A pulled B's file");
  assert.equal(await readFile(abs(platformB, "notes.md"), "utf8"), "from A\n", "B pulled A's file");

  // ── shared ancestor, then divergent edits: lamport order decides ──────
  await platformA.fs.writeFile(abs(platformA, "shared.txt"), "base\n");
  await engineA.noteMutation(["shared.txt"]);
  await waitFor(() => fileIs(platformB, "shared.txt", "base\n"), "shared ancestor on B");
  assert.equal(await readFile(abs(platformB, "shared.txt"), "utf8"), "base\n", "B has the ancestor");

  // Both edit from the base — B edits AFTER A's edit has landed (causally
  // ordered), then edits again: B's lamport is strictly higher, so B wins.
  await platformA.fs.writeFile(abs(platformA, "shared.txt"), "A edit\n");
  await engineA.noteMutation(["shared.txt"]);
  await waitFor(() => fileIs(platformB, "shared.txt", "A edit\n"), "A edit landed on B");
  await platformB.fs.writeFile(abs(platformB, "shared.txt"), "B edit 1\n");
  await engineB.noteMutation(["shared.txt"]);
  await settle();
  await platformB.fs.writeFile(abs(platformB, "shared.txt"), "B edit 2\n");
  await engineB.noteMutation(["shared.txt"]);
  await waitFor(() => fileIs(platformA, "shared.txt", "B edit 2\n"), "B's later edit reaches A");
  await engineA.reconcile();
  await settle();

  assert.equal(
    await readFile(abs(platformA, "shared.txt"), "utf8"),
    "B edit 2\n",
    "the causally later write wins (B's edit)",
  );
  assert.equal(
    await readFile(abs(platformB, "shared.txt"), "utf8"),
    "B edit 2\n",
    "the winner keeps its content",
  );

  // ── equal clocks on divergent writes: deterministic tie-break ─────────
  // Both rewrite the same file with the same clock distance → equal
  // lamports; the smaller replica id wins ("replica-a" < "replica-b"), and
  // the loser's content is preserved as a conflict copy on the loser.
  await platformA.fs.writeFile(abs(platformA, "race.md"), "A rewrite\n");
  await engineA.noteMutation(["race.md"]);
  await platformB.fs.writeFile(abs(platformB, "race.md"), "B rewrite\n");
  await engineB.noteMutation(["race.md"]);
  await engineA.reconcile();
  await settle();

  // Concurrent writes may carry different lamports (a Lamport clock only
  // guarantees causality, not the converse) — the contract is convergence on
  // ONE winner plus preservation of the loser's bytes. Wait for the replicas
  // to AGREE (either content may win), not for a pre-captured value.
  let lastA: string | null = null;
  let lastB: string | null = null;
  let converged = false;
  for (let i = 0; i < 400; i++) {
    lastA = await readFile(abs(platformA, "race.md"), "utf8").catch(() => null);
    lastB = await readFile(abs(platformB, "race.md"), "utf8").catch(() => null);
    if (lastA != null && lastA === lastB) {
      converged = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!converged) {
    const listOf = async (p: typeof platformA): Promise<string[]> =>
      (await p.fs.readdir(p.workspaceRoot, { withFileTypes: true })).map((e) => e.name).sort();
    throw new Error(
      `race.md did not converge:\n  A=${JSON.stringify(lastA)} files=${(await listOf(platformA)).join(",")}\n  B=${JSON.stringify(lastB)} files=${(await listOf(platformB)).join(",")}`,
    );
  }
  const aRace = lastA!;
  const copyNames = [
    ...(await platformA.fs.readdir(platformA.workspaceRoot, { withFileTypes: true })).map((e) => `A:${e.name}`),
    ...(await platformB.fs.readdir(platformB.workspaceRoot, { withFileTypes: true })).map((e) => `B:${e.name}`),
  ].filter((n) => n.includes("race.md.conflict-"));
  assert.ok(copyNames.length >= 1, `the loser is preserved as a conflict copy: ${copyNames.join(",")}`);
  const copyTexts = await Promise.all(
    copyNames.map((n) => {
      const [side, name] = n.split(":");
      const platform = side === "A" ? platformA : platformB;
      return readFile(platform.path.join(platform.workspaceRoot, name), "utf8");
    }),
  );
  assert.ok(
    copyTexts.some((text) => text !== aRace),
    "the conflict copy holds the losing bytes, not a duplicate of the winner",
  );
  const bFiles = (await platformB.fs.readdir(platformB.workspaceRoot, { withFileTypes: true }))
    .map((e) => e.name)
    .filter((n) => n.startsWith("race.md.conflict-"));
  assert.equal(bFiles.length >= 1, true, `the loser is preserved: ${bFiles.join(",")}`);
  assert.equal(await readFile(abs(platformB, bFiles[0]), "utf8"), "B rewrite\n", "the copy holds the loser's bytes");

  // ── tombstones propagate ──────────────────────────────────────────────
  await platformA.fs.rm(abs(platformA, "todo.md"));
  await engineA.noteMutation(["todo.md"]);
  await waitFor(() => fileGone(platformB, "todo.md"), "A's delete reaches B");
  const gone = await platformB.fs.stat(abs(platformB, "todo.md")).then(() => true).catch(() => false);
  assert.equal(gone, false, "A's delete reached B");

  // ── service ICE servers ───────────────────────────────────────────────
  // The BobSwap create/join responses carry ice_servers; the peer connection
  // uses them (TURN included) instead of the hardcoded STUN fallback.
  assert.deepEqual(
    toIceServers([{ urls: ["stun:stun.example.org:443"] }]),
    [{ urls: ["stun:stun.example.org:443"] }],
    "a server STUN entry survives",
  );
  assert.deepEqual(
    toIceServers([
      {
        urls: "turn:turn.example.org:443",
        username: "user",
        credential: "secret",
        credentialType: "password",
      },
    ]),
    [
      {
        urls: ["turn:turn.example.org:443"],
        username: "user",
        credential: "secret",
        credentialType: "password",
      },
    ],
    "a TURN entry keeps its credentials",
  );
  assert.deepEqual(toIceServers(undefined), [], "no field → empty (STUN fallback)");
  assert.deepEqual(
    toIceServers([{ urls: [] }, { urls: [1, null] }, "nonsense", null, 42]),
    [],
    "malformed entries are dropped, never thrown",
  );

  console.log("sync engine: converge, LWW, conflict copy, tombstones OK");
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
}
console.log("sync: all scenarios passed");
process.exit(0);
