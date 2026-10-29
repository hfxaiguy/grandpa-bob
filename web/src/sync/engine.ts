/**
 * The sync engine: converge two replicas of the same workspace.
 *
 * The round is symmetric and fire-and-forget:
 *   1. each side sends its `{path: {hash}}` map plus the per-path lamport
 *      from its journal (the cross-replica LWW authority),
 *   2. on receiving a map, a side that has not sent its own yet replies with
 *      one (so both maps cross exactly once), then applies the difference:
 *      mine-only → push (content or tombstone), theirs-only → pull,
 *      same-path-different-hash → conflict: the higher lamport wins; equal
 *      lamports break by replica id (deterministic on both sides) — the
 *      loser is preserved as `<path>.conflict-<ts>`,
 *   3. pushes travel as ops with the file content base64-encoded; deletes
 *      as tombstones; the apply side re-checks LWW so a slow envelope never
 *      overwrites newer bytes.
 *
 * Receiving is ordered: file-request responses act immediately (they unblock
 * awaiting pulls); every other envelope queues and drains sequentially per
 * engine, so pushes/replies/requests never interleave mid-apply.
 *
 * The transport is pluggable (BroadcastChannel, WebRTC DataChannel): the
 * engine speaks one envelope and never knows which wire it is on. No server
 * ever holds workspace bytes.
 */
import type { Platform } from "../platform/types";
import { buildHashmap, type Hashmap } from "./hashmap";
import { Journal, type SyncOp } from "./journal";

/** One wire message. Write ops carry the file content base64-encoded. */
export interface SyncEnvelope {
  v: 1;
  kind: "hashmap" | "ops" | "file-req";
  from: string;
  hashmap?: Hashmap;
  lamports?: Record<string, number>;
  /** `file-req` asks for `path`; the `ops` reply echoes the token. */
  req?: string;
  path?: string;
  ops?: Array<{
    path: string;
    op: "write" | "delete";
    /** base64 content for write ops. */
    base64?: string;
    /** The sender's lamport for this path — the apply-side LWW check. */
    lamport?: number;
  }>;
}

export interface SyncPeer {
  readonly id: string;
  send(envelope: SyncEnvelope): void;
  connected(): boolean;
  /** REPLACES the current message handler. */
  onMessage(cb: (envelope: SyncEnvelope) => void): void;
  /** The wire dropped or was closed. */
  onClosed(cb: () => void): void;
  close(): void;
}

export interface SyncState {
  status: "idle" | "connecting" | "verifying" | "syncing" | "error";
  detail: string;
  conflicts: string[];
  lastSyncAt: string | null;
}

type StateListener = (state: SyncState) => void;

const SEGMENT = /(^|\/)([^/]+)$/;

function conflictCopyOf(path: string, at: string): string {
  const stamp = at.replace(/[:.]/g, "-").slice(0, 19);
  return path.replace(SEGMENT, (_m, pre, name) => `${pre}${name}.conflict-${stamp}`);
}

export class SyncEngine {
  private platform: Platform;
  private peer: SyncPeer | null = null;
  private state: SyncState = { status: "idle", detail: "", conflicts: [], lastSyncAt: null };
  private listeners = new Set<StateListener>();
  private journal: Journal | null = null;
  /** Whether my map has crossed the wire this connection. */
  private mapSent = false;
  /** Outstanding file requests by token. */
  private pendingFile = new Map<string, (value: string | null) => void>();
  /** The peer's id per envelope — the deterministic tie-break input. */
  private peerNameForTiebreak = "";

  readonly id: string;

  constructor(platform: Platform, peerId: string) {
    this.platform = platform;
    this.id = peerId;
  }

  /** The engine's journal (loads once per engine instance). */
  private async j(): Promise<Journal> {
    if (!this.journal) this.journal = await Journal.load(this.platform);
    return this.journal;
  }

  onState(cb: StateListener): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb(this.state);
  }

  attach(peer: SyncPeer): void {
    this.peer?.close();
    this.peer = peer;
    this.mapSent = false;
    this.setState({ status: "connecting", detail: "peer attached", conflicts: [] });
    peer.onMessage((envelope) => this.receive(envelope));
    peer.onClosed(() => {
      this.peer = null;
      this.setState({ status: "idle", detail: "peer disconnected" });
    });
    void this.reconcile();
  }

  detach(): void {
    this.peer?.close();
    this.peer = null;
    this.setState({ status: "idle", detail: "" });
  }

  /** Called by the workspace when a file tool committed mutations. */
  async noteMutation(paths: string[]): Promise<void> {
    if (!this.peer?.connected()) return;
    const journal = await this.j();
    const ops: NonNullable<SyncEnvelope["ops"]> = [];
    for (const path of paths) {
      // A path that no longer exists is a delete: the file tools call
      // autoCommit with the paths they just removed too.
      const abs = this.platform.path.join(this.platform.workspaceRoot, path);
      const exists = await this.platform.fs.stat(abs).then(() => true).catch(() => false);
      if (!exists) {
        if (journal.lastOpFor(path)?.op === "delete") continue; // already a tombstone
        journal.recordOp({ path, op: "delete" });
        ops.push({ path, op: "delete", lamport: journal.lamportFor(path) });
        continue;
      }
      const base64 = await readBase64(this.platform, path).catch(() => null);
      if (base64 == null) continue;
      journal.recordOp({ path, op: "write", hash: hashOfBase64(this.platform, base64) });
      ops.push({ path, op: "write", base64, lamport: journal.lamportFor(path) });
    }
    if (ops.length && this.peer?.connected()) {
      this.peer.send({ v: 1, kind: "ops", from: this.id, ops });
    }
  }

  /** Send my map: starts a round; the difference applies when theirs lands. */
  async reconcile(): Promise<void> {
    if (!this.peer?.connected()) return;
    await this.j();
    this.setState({ status: "verifying", detail: "comparing workspaces" });
    this.mapSent = true;
    const { hashmap, lamports } = await this.myMap();
    this.peer.send({ v: 1, kind: "hashmap", from: this.id, hashmap, lamports });
  }

  private async myMap(): Promise<{ hashmap: Hashmap; lamports: Record<string, number> }> {
    const journal = await this.j();
    const hashmap = await buildHashmap(this.platform, this.platform.workspaceRoot);
    const lamports: Record<string, number> = {};
    for (const path of Object.keys(hashmap)) lamports[path] = journal.lamportFor(path);
    return { hashmap, lamports };
  }

  /** The wire decision for a conflicting path: "mine" or "theirs". Both
   *  sides compute the same answer (lamports + deterministic id tie-break). */
  private conflictWinner(path: string, theirLamport: number, theirId: string): "mine" | "theirs" {
    const mine = this.journal?.lamportFor(path) ?? 0;
    if (theirLamport !== mine) return theirLamport > mine ? "theirs" : "mine";
    return this.id < theirId ? "mine" : "theirs";
  }

  private async applyDifference(
    mine: Hashmap,
    theirs: Hashmap,
    theirLamports: Record<string, number>,
  ): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    const journal = await this.j();
    const conflicts: string[] = [];
    const push: NonNullable<SyncEnvelope["ops"]> = [];
    const pull: string[] = [];

    for (const path of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const m = mine[path];
      const t = theirs[path];
      if (m && t && m.hash === t.hash) continue; // identical
      if (m && !t) {
        // Mine only: a tombstone when my journal says I deleted it. A write
        // push must match the journal's vouched content — if the file
        // changed since the last op, defer to the next noteMutation round.
        if (journal.lastOpFor(path)?.op === "delete") {
          push.push({ path, op: "delete", lamport: journal.lamportFor(path) });
        } else {
          const base64 = await readBase64(this.platform, path).catch(() => null);
          if (base64 == null) continue;
          if (journal.lastOpFor(path)?.hash !== hashOfBase64(this.platform, base64)) continue;
          push.push({ path, op: "write", base64, lamport: journal.lamportFor(path) });
        }
      } else if (!m && t) {
        // Absent from my snapshot is NOT "I deleted it" — only the journal
        // authorizes a tombstone (an asymmetric snapshot would otherwise
        // manufacture deletes that beat real writes). A path I have never
        // journaled is content I have never seen: pull it.
        if (journal.lastOpFor(path)?.op === "delete") {
          push.push({ path, op: "delete", lamport: journal.lamportFor(path) });
        } else {
          pull.push(path);
        }
      } else {
        conflicts.push(path);
      }
    }

    // Conflicts: the lamport decides; the loser pulls while the winner
    // pushes — and the tie-break agrees on both sides, so exactly one side
    // pulls and one pushes per conflicting path.
    for (const path of conflicts) {
      if (this.conflictWinner(path, theirLamports[path] ?? 0, this.peerNameForTiebreak) === "theirs") {
        pull.push(path);
      } else {
        const base64 = await readBase64(this.platform, path).catch(() => null);
        if (base64 == null) continue;
        // Push must match the journal's vouched content — a file that moved
        // since the last op defers to the next noteMutation round.
        if (journal.lastOpFor(path)?.hash !== hashOfBase64(this.platform, base64)) continue;
        push.push({ path, op: "write", base64, lamport: journal.lamportFor(path) });
      }
    }

    for (const path of pull) {
      const base64 = await this.requestFile(path);
      if (base64 == null) continue;
      if (base64 === "") {
        await this.applyDelete(path);
        continue;
      }
      await this.applyRemoteWrite(path, base64);
    }
    if (push.length) peer.send({ v: 1, kind: "ops", from: this.id, ops: push });
    if (conflicts.length) {
      const fresh = conflicts.filter((c) => !this.state.conflicts.includes(c));
      this.setState({ conflicts: [...this.state.conflicts, ...fresh] });
    }
  }

  /** Write the peer's bytes locally; a differing local loser becomes a
   *  conflict copy (both sides agree who won, so this runs at most once). */
  private async applyRemoteWrite(path: string, base64: string): Promise<void> {
    const journal = await this.j();
    const localB64 = await readBase64(this.platform, path).catch(() => null);
    if (localB64 != null && localB64 !== base64) {
      const copy = conflictCopyOf(path, new Date().toISOString());
      await writeBase64(this.platform, copy, localB64);
      journal.recordOp({ path: copy, op: "write", hash: hashOfBase64(this.platform, localB64) });
    }
    await writeBase64(this.platform, path, base64);
    journal.recordOp({ path, op: "write", hash: hashOfBase64(this.platform, base64) });
  }

  /** Ask the peer for one file's base64 ("" = tombstone there, null = timeout). */
  private requestFile(path: string): Promise<string | null> {
    const peer = this.peer;
    if (!peer) return Promise.resolve(null);
    return new Promise((resolve) => {
      const token = crypto.randomUUID();
      const done = (value: string | null): void => {
        clearTimeout(timeout);
        this.pendingFile.delete(token);
        resolve(value);
      };
      const timeout = setTimeout(() => done(null), 15_000);
      this.pendingFile.set(token, done);
      peer.send({ v: 1, kind: "file-req", from: this.id, req: token, path });
    });
  }

  // ── ordered receive path ────────────────────────────────────────────────
  /** File-request responses act immediately (they unblock awaiting pulls);
   *  every other envelope queues so state changes apply in wire order. */
  private receive(envelope: SyncEnvelope): void {
    if (envelope.kind === "ops" && envelope.req) {
      const resolve = this.pendingFile.get(envelope.req);
      const hit = envelope.ops?.[0];
      if (resolve) resolve(hit ? (hit.op === "delete" ? "" : hit.base64 ?? null) : null);
      return;
    }
    this.inbox.push(envelope);
    void this.drain();
  }
  private inbox: SyncEnvelope[] = [];
  private draining = false;

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.inbox.length) {
        const envelope = this.inbox.shift()!;
        await this.onEnvelope(envelope);
      }
    } finally {
      this.draining = false;
    }
  }

  private async onEnvelope(envelope: SyncEnvelope): Promise<void> {
    if (envelope.from === this.id) return;
    this.peerNameForTiebreak = envelope.from;
    const journal = await this.j();
    if (envelope.kind === "file-req" && envelope.req && envelope.path) {
      // The peer asked for a file: answer with its content, or our tombstone.
      const bytes = await readBase64(this.platform, envelope.path).catch(() => null);
      this.peer?.send({
        v: 1,
        kind: "ops",
        from: this.id,
        req: envelope.req,
        ops: [{ path: envelope.path, op: bytes === null ? "delete" : "write", base64: bytes === null ? undefined : bytes }],
      });
      return;
    }
    if (envelope.kind === "hashmap" && envelope.hashmap) {
      const theirLamports = envelope.lamports ?? {};
      for (const lamport of Object.values(theirLamports)) journal.absorbRemote(lamport);
      // Reply exactly once per connection: my map crosses either as this
      // reply (peer initiated) or as my own reconcile (I initiated).
      if (!this.mapSent) {
        const { hashmap, lamports } = await this.myMap();
        this.mapSent = true;
        this.peer?.send({ v: 1, kind: "hashmap", from: this.id, hashmap, lamports });
      }
      const mine = (await this.myMap()).hashmap;
      await this.applyDifference(mine, envelope.hashmap, theirLamports);
      this.setState({ status: "syncing", detail: "in sync", lastSyncAt: new Date().toISOString() });
      await journal.persist();
      return;
    }
    if (envelope.kind === "ops" && Array.isArray(envelope.ops)) {
      // Pushes from the peer: LWW on apply — a slow envelope must never
      // overwrite newer local bytes; equal stamps with differing content
      // preserve the loser deterministically (smaller replica id wins the
      // path; when the peer wins, my content becomes the conflict copy).
      for (const op of envelope.ops) {
        const mineLamport = journal.lamportFor(op.path);
        if (op.lamport !== undefined && op.lamport < mineLamport) continue; // I hold newer
        if (op.lamport !== undefined && op.lamport === mineLamport && mineLamport > 0) {
          // Same recency, different bytes: deterministic tie-break (the
          // smaller replica id wins the path) — when the peer wins, my
          // content becomes the conflict copy.
          const last = journal.lastOpFor(op.path);
          if (
            op.op === "write" && op.base64 !== undefined &&
            last?.op === "write" && last.hash !== hashOfBase64(this.platform, op.base64) &&
            this.id > this.peerNameForTiebreak // the peer wins the tie
          ) {
            const localB64 = await readBase64(this.platform, op.path).catch(() => null);
            if (localB64 != null && localB64 !== op.base64) {
              const copy = conflictCopyOf(op.path, new Date().toISOString());
              await writeBase64(this.platform, copy, localB64);
              journal.recordOp({ path: copy, op: "write", hash: hashOfBase64(this.platform, localB64) });
            }
            await writeBase64(this.platform, op.path, op.base64);
            journal.recordOp({ path: op.path, op: "write", hash: hashOfBase64(this.platform, op.base64) });
          }
          continue;
        }
        // Strictly newer (or unknown-vs-unknown when both stamps are 0):
        // apply — applyRemoteWrite preserves my differing bytes as a
        // conflict copy when the peer overwrote newer-not-journaled content.
        if (op.op === "delete") {
          await this.applyDelete(op.path);
        } else if (op.base64 !== undefined) {
          await this.applyRemoteWrite(op.path, op.base64);
        }
      }
      this.setState({ status: "syncing", detail: "in sync", lastSyncAt: new Date().toISOString() });
      await journal.persist();
    }
  }

  private async applyDelete(path: string): Promise<void> {
    const journal = await this.j();
    const abs = this.platform.path.join(this.platform.workspaceRoot, path);
    await this.platform.fs.rm(abs).catch(() => {});
    journal.recordOp({ path, op: "delete" });
  }
}

// ── fs helpers ───────────────────────────────────────────────────────────

async function readBase64(platform: Platform, rel: string): Promise<string | null> {
  const abs = platform.path.join(platform.workspaceRoot, rel);
  // Missing ≠ empty: a null return means "not here" (requests answer with a
  // tombstone; applyRemoteWrite skips the conflict-copy branch).
  const exists = await platform.fs.stat(abs).then(() => true).catch(() => false);
  if (!exists) return null;
  const bytes =
    (await (platform.fs as { readFileBytes?: (p: string) => Promise<Uint8Array> }).readFileBytes?.(abs).catch(
      () => undefined,
    )) ??
    new TextEncoder().encode(await platform.fs.readFile(abs, "utf8").catch(() => ""));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return bytes.length === 0 ? "" : btoa(binary);
}

async function writeBase64(platform: Platform, rel: string, base64: string): Promise<void> {
  const abs = platform.path.join(platform.workspaceRoot, rel);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  await platform.fs.mkdir(platform.path.dirname(abs), { recursive: true });
  await platform.fs.writeFile(abs, bytes);
}

function hashOfBase64(platform: Platform, base64: string): string {
  return platform.crypto.sha256hex(base64);
}
