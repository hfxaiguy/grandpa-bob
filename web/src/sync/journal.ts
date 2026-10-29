/**
 * The sync ops journal — one per replica (an instance per engine).
 *
 * Every workspace mutation records an op (`write` with the content hash, or
 * `delete` as a tombstone) stamped with the replica's logical clock: each
 * mutation bumps the clock, and a remote op's clock is absorbed
 * (`clock = max(clock, op.lamport)`), so write order is comparable across
 * replicas even though the clocks are independent. Ties (two replicas wrote
 * at the same clock value) break deterministically by replica id — both
 * sides agree on the winner, the loser is preserved as
 * `<path>.conflict-<ts>`. No ambiguity, no dead heat.
 *
 * The journal is memory-authoritative and persisted whole (the platform fs
 * has no append) beside the workspace at `.gpb-sync/journal.jsonl` — never
 * inside it, so it never syncs as a workspace file, never enters git
 * history, and stays out of the agent's file walk by the `.gpb-` prefix
 * (same rule as the run log's `.gpb-runlog`).
 */
import type { Platform } from "../platform/types";

export interface SyncOp {
  /** Lamport clock of this write — the cross-replica LWW authority. */
  lamport: number;
  /** Workspace-relative path (no leading slash). */
  path: string;
  /** "write" carries the content hash; "delete" is a tombstone. */
  op: "write" | "delete";
  /** sha256 hex of the new content (write ops only). */
  hash?: string;
  at: string;
}

const JOURNAL_DIR = ".gpb-sync";
const JOURNAL_FILE = `${JOURNAL_DIR}/journal.jsonl`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class Journal {
  private ops: SyncOp[] = [];
  private lamportByPath = new Map<string, number>();
  private clock = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Load the persisted journal for this replica (fresh when none). */
  static async load(platform: Platform): Promise<Journal> {
    const journal = new Journal(platform);
    const file = platform.path.join(platform.workspaceRoot, JOURNAL_FILE);
    let raw: string;
    try {
      raw = await platform.fs.readFile(file, "utf8");
    } catch {
      return journal; // fresh replica
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const op = JSON.parse(line) as unknown;
        if (!isRecord(op) || typeof op.lamport !== "number" || typeof op.path !== "string") continue;
        if (op.op !== "write" && op.op !== "delete") continue;
        journal.ops.push(op as unknown as SyncOp);
        journal.lamportByPath.set(op.path, op.lamport);
        if (op.lamport > journal.clock) journal.clock = op.lamport;
      } catch {
        /* torn line */
      }
    }
    return journal;
  }

  private constructor(private platform: Platform) {}

  /** Last op recorded for a path (write or tombstone) — null when never touched. */
  lastOpFor(path: string): SyncOp | null {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      if (this.ops[i].path === path) return this.ops[i];
    }
    return null;
  }

  /** Paths whose LAST op is a tombstone, with the tombstone's lamport.
   *  Deletions must travel explicitly: a hashmap lists existing files, so a
   *  deleted path is otherwise invisible to the peer. */
  deletions(): Map<string, number> {
    const out = new Map<string, number>();
    for (const op of this.ops) {
      if (op.op === "delete") out.set(op.path, op.lamport);
      else out.delete(op.path);
    }
    return out;
  }

  /** The replica's known lamport for a path (0 = never seen here). */
  lamportFor(path: string): number {
    return this.lamportByPath.get(path) ?? 0;
  }

  /** Record one LOCAL mutation: the stamp is strictly newer than anything
   *  known for this path, so a local write causally follows what it saw. */
  recordOp(op: Omit<SyncOp, "lamport" | "at">): SyncOp {
    const last = this.lastOpFor(op.path);
    if (last && last.op === op.op && last.hash === op.hash) return last; // idempotent
    const base = Math.max(this.clock, this.lamportByPath.get(op.path) ?? 0);
    this.clock = base + 1;
    const full: SyncOp = { ...op, lamport: this.clock, at: new Date().toISOString() };
    this.ops.push(full);
    this.lamportByPath.set(full.path, full.lamport);
    this.schedulePersist();
    return full;
  }

  /**
   * Record an APPLIED remote op under the ORIGINATING side's lamport.
   *
   * This is what keeps per-path stamps meaningful: re-stamping a mirror with
   * my own (clock-inflated) value would make content that came FROM the peer
   * look newer than the peer's own later writes — every mirror would fabricate
   * a fresher version. The originating stamp is the version; my clock only
   * advances so my own future writes are causally later.
   */
  recordRemoteOp(op: Omit<SyncOp, "at">): SyncOp {
    if (op.lamport > this.clock) this.clock = op.lamport;
    const current = this.lamportByPath.get(op.path) ?? 0;
    if (op.lamport < current) {
      // An older version than what I already hold: keep the stamp, no append.
      const last = this.lastOpFor(op.path);
      return last ?? { ...op, at: new Date().toISOString() };
    }
    const full: SyncOp = { ...op, at: new Date().toISOString() };
    const last = this.lastOpFor(op.path);
    if (last && last.op === full.op && last.hash === full.hash && last.lamport === full.lamport) return last;
    this.ops.push(full);
    this.lamportByPath.set(full.path, full.lamport);
    this.schedulePersist();
    return full;
  }

  /** Absorb a REMOTE op's clock without journaling it (an applied remote
   *  write re-records through recordOp with my own stamp). */
  absorbRemote(lamport: number): void {
    if (lamport > this.clock) this.clock = lamport;
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch((err) => console.warn("[sync] journal persist failed:", err));
    }, 500);
  }

  async persist(): Promise<void> {
    const file = this.platform.path.join(this.platform.workspaceRoot, JOURNAL_FILE);
    await this.platform.fs.mkdir(this.platform.path.join(this.platform.workspaceRoot, JOURNAL_DIR), { recursive: true });
    await this.platform.fs.writeFile(file, `${this.ops.map((op) => JSON.stringify(op)).join("\n")}\n`);
  }
}
