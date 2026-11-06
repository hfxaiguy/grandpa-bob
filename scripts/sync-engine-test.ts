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
import { mkdtemp, rm, readFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodePlatform } from "../src/platform/node.js";
import { SyncEngine, type SyncEnvelope, type SyncPeer, type TransferState } from "../web/src/sync/engine";
import { buildHashmap } from "../web/src/sync/hashmap";
import { watchCommits } from "../web/src/sync/commit-watch";
import { createMemoryPlatform } from "../web/src/platform/memory";
import { applyDatabaseDumps, isDatabaseDumpPath, writeDatabaseDumps } from "../web/src/db-sync";
import { Journal } from "../web/src/sync/journal";
import { pairingPhrase, toIceServers } from "../web/src/sync/transport-webrtc";

/** An in-memory wire: deliveries land on whichever handler is registered. */
class FakePeer implements SyncPeer {
  readonly id: string;
  counterpart: FakePeer | null = null;
  /** Everything this side put on the wire (the tests inspect replies). */
  readonly sent: SyncEnvelope[] = [];
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
    this.sent.push(envelope);
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
const appliedOnB: string[][] = [];
const engineB = new SyncEngine(platformB, "replica-b", {
  onApplied: async (paths) => {
    appliedOnB.push(paths);
    if (paths.some(isDatabaseDumpPath)) {
      // Exercise the receiving half of the dump transport: the file arrives as
      // a workspace file, then the host replays it into the local DB.
      await applyDatabaseDumps(platformB, { applyClean: true });
    }
  },
});

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

/** The wire/base64 form the engine hashes (see hashOfBase64). */
const b64Of = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

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

  // ── first contact merges instead of replacing ─────────────────────────
  // Pairing no longer deletes the browser workspace. Files that exist on one
  // side are copied to the other (both keep a copy); a same-path conflict
  // keeps the fresher copy and preserves the older bytes as a conflict file.
  await platformA.fs.writeFile(abs(platformA, "only-a.txt"), "only A\n");
  await platformB.fs.writeFile(abs(platformB, "only-b.txt"), "only B\n");
  await platformA.fs.writeFile(abs(platformA, "fresher.txt"), "older A\n");
  await utimes(
    abs(platformA, "fresher.txt"),
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-01-01T00:00:00Z"),
  );
  await platformB.fs.writeFile(abs(platformB, "fresher.txt"), "newer B\n");
  await utimes(
    abs(platformB, "fresher.txt"),
    new Date("2026-02-01T00:00:00Z"),
    new Date("2026-02-01T00:00:00Z"),
  );
  await engineA.reconcile();
  await engineB.reconcile();
  await waitFor(
    async () =>
      (await fileIs(platformA, "only-b.txt", "only B\n")) &&
      (await fileIs(platformB, "only-a.txt", "only A\n")) &&
      (await fileIs(platformA, "fresher.txt", "newer B\n")) &&
      (await fileIs(platformB, "fresher.txt", "newer B\n")),
    "first-contact merge",
  );
  assert.equal(
    await readFile(abs(platformA, "fresher.txt"), "utf8"),
    "newer B\n",
    "the fresher copy wins on the stale side",
  );
  assert.equal(
    await readFile(abs(platformB, "fresher.txt"), "utf8"),
    "newer B\n",
    "the fresher side keeps its own copy",
  );
  const aConflicts = (
    await platformA.fs.readdir(platformA.workspaceRoot, { withFileTypes: true })
  )
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("fresher.txt.conflict-"));
  assert.equal(aConflicts.length, 1, `A keeps the older copy: ${aConflicts.join(",")}`);
  assert.equal(
    await readFile(abs(platformA, aConflicts[0]), "utf8"),
    "older A\n",
    "the conflict file holds the losing bytes",
  );

  // A journaled edit is authoritative even when its mtime is older: a seed
  // import stamps every file "now", so mtime alone would clobber real edits.
  wireA.counterpart = null;
  wireB.counterpart = null;
  await platformA.fs.writeFile(abs(platformA, "journaled.txt"), "A edited\n");
  await utimes(
    abs(platformA, "journaled.txt"),
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-01-01T00:00:00Z"),
  );
  await engineA.noteMutation(["journaled.txt"]);
  await platformB.fs.writeFile(abs(platformB, "journaled.txt"), "B newer mtime\n");
  await utimes(
    abs(platformB, "journaled.txt"),
    new Date("2026-02-01T00:00:00Z"),
    new Date("2026-02-01T00:00:00Z"),
  );
  wireA.counterpart = wireB;
  wireB.counterpart = wireA;
  await engineA.reconcile();
  await engineB.reconcile();
  await waitFor(
    async () =>
      (await fileIs(platformA, "journaled.txt", "A edited\n")) &&
      (await fileIs(platformB, "journaled.txt", "A edited\n")),
    "a journaled edit beats an unjournaled newer mtime",
  );
  const bConflicts = (
    await platformB.fs.readdir(platformB.workspaceRoot, { withFileTypes: true })
  )
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("journaled.txt.conflict-"));
  assert.equal(bConflicts.length, 1, `B keeps its losing copy: ${bConflicts.join(",")}`);
  assert.equal(
    await readFile(abs(platformB, bConflicts[0]), "utf8"),
    "B newer mtime\n",
    "the losing unjournaled copy is preserved",
  );

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

  // ── SQLite files never travel as binaries; their dumps do ─────────────
  // A root `*.db` is live local state (the browser exports the whole file
  // after each commit), so copying it can race that write. App DBs travel as
  // their SQL dumps; sidecars are runtime state.
  await platformA.fs.writeFile(abs(platformA, "local.db"), "A db bytes");
  await platformB.fs.writeFile(abs(platformB, "local.db"), "B db bytes");
  await platformA.fs.writeFile(abs(platformA, "local.db-wal"), "wal");
  const aDb = await platformA.sqlite.open(abs(platformA, "contacts.db"), { readOnly: false });
  await aDb.exec("CREATE TABLE people (name TEXT); INSERT INTO people (name) VALUES ('Ada');");
  await aDb.close();
  await writeDatabaseDumps(platformA);
  const dumpText = await readFile(abs(platformA, "db/contacts.db.sql"), "utf8");
  const syncMap = await buildHashmap(platformA, platformA.workspaceRoot);
  assert.equal("contacts.db" in syncMap, false, "a root .db is not peer-synced");
  assert.equal("local.db" in syncMap, false, "every root .db is excluded");
  assert.equal("local.db-wal" in syncMap, false, "a SQLite sidecar is not peer-synced");
  assert.equal("db/contacts.db.sql" in syncMap, true, "the dump still syncs");
  await engineA.reconcile();
  await waitFor(
    async () => appliedOnB.some((paths) => paths.includes("db/contacts.db.sql")),
    "B applied the delivered dump",
  );
  assert.equal(await readFile(abs(platformB, "local.db"), "utf8"), "B db bytes", "B's local DB was not overwritten");
  assert.equal(
    await readFile(abs(platformB, "db/contacts.db.sql"), "utf8"),
    dumpText,
    "the dump reached B",
  );
  const bDb = await platformB.sqlite.open(abs(platformB, "contacts.db"), { readOnly: true });
  try {
    const rows = (await (await bDb.prepare("SELECT name FROM people")).all()) as Array<{
      name?: unknown;
    }>;
    assert.equal(String(rows[0]?.name), "Ada", "B's DB was replayed from the dump");
  } finally {
    await bDb.close();
  }

  // ── a mixed-version peer cannot push an excluded path ─────────────────
  // An older engine's map still advertises root `*.db` (the exclusion is new).
  // Applying that raw copy would race the local whole-file engine persisting
  // its image — the torn-database failure the exclusion exists to prevent.
  const bDbBytes = "B's live database bytes";
  await platformB.fs.writeFile(abs(platformB, "contacts.db"), bDbBytes);
  const aDbBytes = new Uint8Array(await readFile(abs(platformA, "contacts.db")));
  const aDbB64 = b64Of(aDbBytes);
  const oldPeer = "old-replica"; // predates the *.db exclusion
  wireB.sent.length = 0; // inspect only the replies to these probes

  wireA.send({
    v: 1,
    kind: "hashmap",
    from: oldPeer,
    hashmap: {
      "contacts.db": { hash: platformA.crypto.sha256hex(aDbB64), bytes: aDbBytes.length, mtime: 0 },
    },
    lamports: { "contacts.db": 9000 },
    deletes: {},
  });
  await settle();
  assert.equal(
    await readFile(abs(platformB, "contacts.db"), "utf8"),
    bDbBytes,
    "an old peer's map cannot raw-copy a live .db over this replica's",
  );

  // A .db tombstone from the same peer must not delete the live file either.
  wireA.send({
    v: 1,
    kind: "hashmap",
    from: oldPeer,
    hashmap: {},
    lamports: {},
    deletes: { "contacts.db": 9500 },
  });
  await settle();
  assert.equal(
    await readFile(abs(platformB, "contacts.db"), "utf8"),
    bDbBytes,
    "an old peer's .db tombstone cannot delete the live file",
  );

  // A raw ops push is the other old path to the same hazard. The same push
  // for an ordinary file must still apply.
  wireA.send({
    v: 1,
    kind: "ops",
    from: oldPeer,
    ops: [{ path: "contacts.db", op: "write", base64: aDbB64, lamport: 9600 }],
  });
  wireA.send({
    v: 1,
    kind: "ops",
    from: oldPeer,
    ops: [
      {
        path: "from-old-peer.txt",
        op: "write",
        base64: b64Of(new TextEncoder().encode("ordinary\n")),
        lamport: 9700,
      },
    ],
  });
  await settle();
  assert.equal(
    await readFile(abs(platformB, "contacts.db"), "utf8"),
    bDbBytes,
    "a raw ops push cannot overwrite a live .db",
  );
  assert.equal(
    await readFile(abs(platformB, "from-old-peer.txt"), "utf8"),
    "ordinary\n",
    "ordinary ops still apply",
  );

  // A file request for an excluded path is answered at once with an empty
  // payload — never a tombstone, which the requester would read as a delete.
  wireA.send({ v: 1, kind: "file-req", from: oldPeer, req: "probe-db", path: "contacts.db" });
  await waitFor(
    async () => wireB.sent.some((e) => e.kind === "ops" && e.req === "probe-db"),
    "the excluded path's file request is answered",
  );
  const refusal = wireB.sent.find((e) => e.kind === "ops" && e.req === "probe-db");
  assert.deepEqual(refusal?.ops, [], "an excluded path is answered empty, not with a tombstone");

  // Ordinary file requests still serve their bytes.
  wireA.send({ v: 1, kind: "file-req", from: oldPeer, req: "probe-file", path: "notes.md" });
  await waitFor(
    async () => wireB.sent.some((e) => e.kind === "ops" && e.req === "probe-file"),
    "an ordinary file request is answered",
  );
  const served = wireB.sent.find((e) => e.kind === "ops" && e.req === "probe-file");
  assert.equal(atob(served?.ops?.[0]?.base64 ?? ""), "from A\n", "ordinary files are still served");

  // ── a locally-initiated round advances this side's completion clock ───
  // The toolbar's "desktop: synced HH:MM" comes from lastSyncAt. A map this
  // side sends must be answered, or the clock stays at the last map this
  // side received even while every change it sends lands on the peer.
  let lastSyncAtA: string | null = null;
  engineA.onState((state) => {
    lastSyncAtA = state.lastSyncAt;
  });
  await settle();
  const beforeClock = lastSyncAtA;
  assert.ok(beforeClock, "A has completed a round before the clock test");
  await platformA.fs.writeFile(abs(platformA, "clock.txt"), "tick\n");
  await engineA.noteMutation(["clock.txt"]);
  await waitFor(() => fileIs(platformB, "clock.txt", "tick\n"), "clock.txt reaches B");
  await waitFor(async () => lastSyncAtA !== beforeClock, "A's completion clock advances on its own round");

  // ── transfer progress: bytes, files and direction are reported ────────
  let transferA: TransferState | null = null;
  let transferB: TransferState | null = null;
  let maxRound = { done: 0, total: 0 };
  const directionsB = new Set<string>();
  engineA.onState((state) => {
    transferA = state.transfer;
  });
  engineB.onState((state) => {
    transferB = state.transfer;
    directionsB.add(state.transfer.direction);
    maxRound = {
      done: Math.max(maxRound.done, state.transfer.roundDone),
      total: Math.max(maxRound.total, state.transfer.roundTotal),
    };
  });
  await platformA.fs.writeFile(abs(platformA, "transfer.txt"), "payload\n");
  await engineA.noteMutation(["transfer.txt"]);
  await waitFor(() => fileIs(platformB, "transfer.txt", "payload\n"), "transfer.txt reaches B");
  await settle();
  assert.ok(transferB && transferB.received >= 8, "B counts the received file's bytes");
  assert.ok(transferB && transferB.filesReceived >= 1, "B counts the received file");
  assert.ok(transferA && transferA.sent >= 8, "A counts the served bytes");
  assert.ok(transferA && transferA.filesSent >= 1, "A counts the served file");
  assert.ok(
    directionsB.has("down") || directionsB.has("both"),
    "B reports the download direction",
  );
  assert.ok(maxRound.total >= 1 && maxRound.done >= 1, "the pull round reports file progress");
  console.log("ok  transfer counters and direction");

  // ── a manual round waits for a peer that has spoken ───────────────────
  // The Sync… → Live sync → "Sync now" button uses this: peers that answered
  // before are awaited, so the button can report a real completion.
  const manualRound = await engineA.reconcileAll(4_000);
  assert.equal(manualRound.peers, 1, "one peer is attached");
  assert.equal(manualRound.completed, 1, "the peer answered the manual round");

  // ── directories and "." are never journaled as files ──────────────────
  // A `git_commit` with no paths reaches the commit seam as ["."]; treating
  // that as a file would publish the workspace root as an empty-byte path.
  await platformA.fs.mkdir(abs(platformA, "dir-only"), { recursive: true });
  await engineA.noteMutation([".", "dir-only"]);
  await new Promise((r) => setTimeout(r, 700)); // journal persistence debounce
  const journalRaw = await readFile(
    platformA.path.join(platformA.workspaceRoot, ".gpb-sync/journal.jsonl"),
    "utf8",
  ).catch(() => "");
  assert.ok(!journalRaw.includes(`"path":"."`), "the workspace root is not journaled");
  assert.ok(!journalRaw.includes(`"path":"dir-only"`), "a directory is not journaled");

  // ── the worker's commit seam reports only real commits ────────────────
  // The agent worker wraps its own Platform with this; the main thread's
  // engine then journals the paths. "no-changes"/"failed" stay quiet.
  const commits: string[][] = [];
  const workerLike = createMemoryPlatform({
    autoCommit: async (paths) => (paths.includes("quiet.md") ? "no-changes" : "abc1234"),
  });
  const unwatch = watchCommits(workerLike, (paths) => commits.push(paths));
  await workerLike.git.autoCommit(["changed.md", "db/notes.db.sql"], "agent(write_file): changed.md");
  await workerLike.git.autoCommit(["quiet.md"], "agent(edit_file): quiet.md");
  unwatch();
  assert.deepEqual(
    commits,
    [["changed.md", "db/notes.db.sql"]],
    "a successful commit reports its paths; a no-change commit does not",
  );

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

  // Short authentication string: both sides derive the same six words from
  // the pair of DTLS certificate fingerprints, and a substituted certificate
  // (the relay-MITM case) changes the phrase.
  const sdpA = "v=0\r\na=fingerprint:sha-256 AA:11:BB:22\r\n";
  const sdpB = "v=0\r\na=fingerprint:sha-256 CC:33:DD:44\r\n";
  assert.equal(
    pairingPhrase(sdpA, sdpB),
    pairingPhrase(sdpB, sdpA),
    "the SAS is symmetric across the two sides",
  );
  assert.match(
    pairingPhrase(sdpA, sdpB),
    /^[a-z]+(-[a-z]+){5}$/,
    "the SAS renders six words",
  );
  const tampered = sdpB.replace("CC:33:DD:44", "EE:55:FF:66");
  assert.notEqual(
    pairingPhrase(sdpA, sdpB),
    pairingPhrase(sdpA, tampered),
    "a substituted certificate changes the phrase",
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
