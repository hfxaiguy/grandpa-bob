/**
 * The paired-profile run-log mirror: the desktop store and the tab-side
 * streamer.
 *
 * The log never travels through workspace sync (`logs/` is excluded from the
 * hashmap and from db-sync), so these two unit-tested pieces are the whole
 * path from a browser `llm_error` row to `npm run peer:log`.
 *
 * Run: `npm run test:peer-log`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-peerlog-"));
process.env.BOB_STATE_DIR = stateDir;

const {
  handshakePeerLog,
  appendPeerLog,
  readPeerLog,
  statsPeerLog,
} = await import("../src/bridge/peer-log.js");
const { PeerLogShipper, peerLogEpoch } = await import("../web/src/peer-log.js");

const PROFILE = "linkedin";

function row(seq: number, kind = "flow", content: unknown = { note: `row ${seq}` }) {
  return {
    seq,
    run_id: "run-1",
    definition_id: "trunk",
    branch_path: null,
    iteration: 0,
    scope_id: null,
    kind,
    content,
  };
}

try {
  // ── the desktop store ──────────────────────────────────────────────────
  const fresh = await handshakePeerLog(PROFILE, { epoch: "epoch-a", max: 0 });
  assert.equal(fresh.epoch, "epoch-a");
  assert.equal(fresh.cursor, 0);
  assert.equal(fresh.total, 0);

  const first = await appendPeerLog(PROFILE, "epoch-a", [row(1), row(2), row(3)]);
  assert.deepEqual({ inserted: first.inserted, cursor: first.cursor, total: first.total }, {
    inserted: 3,
    cursor: 3,
    total: 3,
  });

  // A resend after a lost ack is ignored (the stream is append-only).
  const resend = await appendPeerLog(PROFILE, "epoch-a", [row(1), row(2), row(3)]);
  assert.deepEqual({ inserted: resend.inserted, cursor: resend.cursor }, { inserted: 0, cursor: 3 });

  // A window with an overlap stores only the new tail.
  const overlap = await appendPeerLog(PROFILE, "epoch-a", [row(2), row(4), row(5)]);
  assert.deepEqual({ inserted: overlap.inserted, cursor: overlap.cursor }, { inserted: 2, cursor: 5 });

  // Malformed rows are skipped, oversized content keeps its address.
  const big = "x".repeat(300 * 1024);
  const mixed = await appendPeerLog(PROFILE, "epoch-a", [
    { seq: "nope", kind: "flow" },
    { ...row(6, "llm_error", { error: "the real failure" }) },
    { ...row(7, "tool_call", { output: big }) },
    { ...row(8, "web_turn_end", { status: "done", input: "hi" }) },
    { ...row(9, "web_turn_end", { status: "error", error: "agent run failed: boom" }) },
  ]);
  assert.equal(mixed.inserted, 4);
  assert.equal(mixed.skipped, 1);

  const errors = await readPeerLog(PROFILE, { kinds: ["llm_error"] });
  assert.equal(errors.rows.length, 1);
  assert.equal(errors.rows[0].seq, 6);
  assert.deepEqual(errors.rows[0].content, { error: "the real failure" });

  // The default window: engine errors plus failed turns, not successful turns.
  const errorWindow = await readPeerLog(PROFILE, { errorOnly: true });
  assert.deepEqual(errorWindow.rows.map((r) => r.seq), [6, 9]);

  const tail = await readPeerLog(PROFILE, { limit: 2 });
  assert.deepEqual(tail.rows.map((r) => r.seq), [8, 9], "newest window comes back ascending");

  const afterSix = await readPeerLog(PROFILE, { after: 6 });
  assert.deepEqual(afterSix.rows.map((r) => r.seq), [7, 8, 9], "a follow cursor sees only newer rows");
  const afterOne = await readPeerLog(PROFILE, { after: 1, limit: 2 });
  assert.deepEqual(afterOne.rows.map((r) => r.seq), [2, 3], "follow windows move forward in stream order");

  const stats = await statsPeerLog(PROFILE);
  assert.equal(stats.cursor, 9);
  assert.equal(stats.total, 9);
  assert.ok(stats.kinds.some((k) => k.kind === "flow" && k.count === 5));

  // Same epoch, non-regressed max: the copy survives a reconnect.
  const reconnect = await handshakePeerLog(PROFILE, { epoch: "epoch-a", max: 9 });
  assert.equal(reconnect.cursor, 9);
  assert.equal(reconnect.total, 9);

  // A regressed max means the tab's log was recreated under the same epoch.
  const regressed = await handshakePeerLog(PROFILE, { epoch: "epoch-a", max: 2 });
  assert.equal(regressed.cursor, 0);
  assert.equal(regressed.total, 0);

  // Unknown max (the tab could not read it) is not a regression: keep the
  // copy instead of wiping it on a transient RPC failure.
  await appendPeerLog(PROFILE, "epoch-a", [row(1), row(2)]);
  const unknown = await handshakePeerLog(PROFILE, { epoch: "epoch-a" });
  assert.deepEqual({ cursor: unknown.cursor, total: unknown.total }, { cursor: 2, total: 2 });

  // A new epoch resets instead of mixing two sequence spaces.
  await appendPeerLog(PROFILE, "epoch-a", [row(1), row(2)]);
  const other = await handshakePeerLog(PROFILE, { epoch: "epoch-b", max: 9 });
  assert.deepEqual({ epoch: other.epoch, cursor: other.cursor, total: other.total }, {
    epoch: "epoch-b",
    cursor: 0,
    total: 0,
  });

  // A stale tab cannot splice rows into another epoch.
  const stale = await appendPeerLog(PROFILE, "epoch-a", [row(3)]);
  assert.match(String(stale.error), /epoch/i);
  assert.equal(stale.inserted, 0);

  // An unknown profile reads as empty, not an error.
  const none = await readPeerLog("never-paired", { limit: 5 });
  assert.deepEqual({ total: none.total, rows: none.rows.length }, { total: 0, rows: 0 });

  // ── the tab-side streamer ──────────────────────────────────────────────
  const profile = "php";
  const epoch = peerLogEpoch(profile);
  const sent: Record<string, unknown>[] = [];
  const dbRows: ReturnType<typeof row>[] = [];
  const shipper = new PeerLogShipper({
    profile,
    send: (control) => sent.push(control),
    load: async (after, limit) =>
      dbRows.filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit),
    maxSeq: async () => dbRows.reduce((max, r) => Math.max(max, r.seq), 0),
  });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  shipper.start();
  await settle();
  const handshake = sent[0];
  assert.equal(handshake?.op, "log-handshake");
  assert.equal(handshake?.epoch, epoch);

  // Nothing when the desktop has not answered yet, even for urgent rows.
  shipper.push(row(1, "llm_error", { error: "before handshake" }));
  await settle();
  assert.equal(sent.length, 1, "no batch before log-cursor");

  // The desktop is empty: the backfill (from its log DB) is sent, ascending.
  dbRows.push(row(1), row(2), row(3));
  shipper.handleControl({ op: "log-cursor", epoch, cursor: 0 });
  await settle();
  const backfill = sent.at(-1);
  assert.equal(backfill?.op, "log-batch");
  assert.deepEqual((backfill?.events as Array<{ seq: number }>).map((e) => e.seq), [1, 2, 3]);

  // One batch in flight: a push below the ack cursor is dropped, one above
  // waits for the ack.
  shipper.push(row(1, "flow"));
  shipper.push(row(4, "flow"));
  shipper.flush();
  await settle();
  assert.equal(sent.length, 2, "inflight batches hold new pushes");
  shipper.handleControl({ op: "log-ack", upTo: 3 });
  await settle();
  const live = sent.at(-1);
  assert.deepEqual((live?.events as Array<{ seq: number }>).map((e) => e.seq), [4]);

  // A reconnect after the desktop lost its copy resets to cursor 0 and the
  // tab re-streams from its log DB.
  shipper.handleControl({ op: "log-cursor", epoch, cursor: 0 });
  await settle();
  const replay = sent.at(-1);
  assert.deepEqual((replay?.events as Array<{ seq: number }>).map((e) => e.seq), [1, 2, 3]);
  shipper.handleControl({ op: "log-ack", upTo: 4 });
  await settle();
  assert.equal(sent.length, 4, "the replay drains without new rows");

  shipper.close();

  console.log("peer-log: desktop store + tab streamer OK");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
