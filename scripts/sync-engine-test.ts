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
    console.log(`[wire ${this.id}→]`, envelope.kind, JSON.stringify(envelope).slice(0, 140));
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

/** Wait until both engines report the target status. */
async function waitBoth(target: string, what: string): Promise<void> {
  const read = (engine: SyncEngine): string => {
    let out = "";
    engine.onState((s) => (out = s.status)); // subscribe fires immediately
    return out;
  };
  for (let i = 0; i < 200; i++) {
    if (read(engineA) === target && read(engineB) === target) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never reached "${target}": ${what}`);
}

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
  await settle();
  await waitBoth("syncing", "round 1");

  assert.equal(await readFile(abs(platformA, "todo.md"), "utf8"), "from B\n", "A pulled B's file");
  assert.equal(await readFile(abs(platformB, "notes.md"), "utf8"), "from A\n", "B pulled A's file");

  // ── shared ancestor, then divergent edits: lamport order decides ──────
  await platformA.fs.writeFile(abs(platformA, "shared.txt"), "base\n");
  await engineA.noteMutation(["shared.txt"]);
  await settle();
  await waitBoth("syncing", "shared ancestor");
  assert.equal(await readFile(abs(platformB, "shared.txt"), "utf8"), "base\n", "B has the ancestor");

  // Both edit from the base — B writes twice, so its lamport is higher.
  await platformA.fs.writeFile(abs(platformA, "shared.txt"), "A edit\n");
  await engineA.noteMutation(["shared.txt"]);
  await platformB.fs.writeFile(abs(platformB, "shared.txt"), "B edit 1\n");
  await engineB.noteMutation(["shared.txt"]);
  await platformB.fs.writeFile(abs(platformB, "shared.txt"), "B edit 2\n");
  await engineB.noteMutation(["shared.txt"]);
  await engineA.reconcile();
  await settle();
  await waitBoth("syncing", "conflict round");

  assert.equal(
    await readFile(abs(platformA, "shared.txt"), "utf8"),
    "B edit 2\n",
    "the higher lamport wins (B's edit)",
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
  await waitBoth("syncing", "tie-break round");

  assert.equal(
    await readFile(abs(platformA, "race.md"), "utf8"),
    "A rewrite\n",
    "replica-a wins the tie (smaller id)",
  );
  assert.equal(
    await readFile(abs(platformB, "race.md"), "utf8"),
    "A rewrite\n",
    "the winner's content reaches the loser",
  );
  const bFiles = (await platformB.fs.readdir(platformB.workspaceRoot, { withFileTypes: true }))
    .map((e) => e.name)
    .filter((n) => n.startsWith("race.md.conflict-"));
  assert.equal(bFiles.length >= 1, true, `the loser is preserved: ${bFiles.join(",")}`);
  assert.equal(await readFile(abs(platformB, bFiles[0]), "utf8"), "B rewrite\n", "the copy holds the loser's bytes");

  // ── tombstones propagate ──────────────────────────────────────────────
  await platformA.fs.rm(abs(platformA, "todo.md"));
  await engineA.noteMutation(["todo.md"]);
  await settle();
  await waitBoth("syncing", "tombstone round");
  const gone = await platformB.fs.stat(abs(platformB, "todo.md")).then(() => true).catch(() => false);
  assert.equal(gone, false, "A's delete reached B");

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
