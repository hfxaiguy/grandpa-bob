/**
 * Browser side of the per-profile log event stream.
 *
 * The run log lives only in this tab's OPFS workspace: the sync engine
 * excludes `logs/` (a SQLite file is not a file to merge) and db-sync skips
 * the run log by design. A paired desktop therefore learns the rows here,
 * over the same authenticated control channel that already carries
 * hello/ready/ops-run (`sync/control-peer.ts`):
 *
 *   tab  →  log-handshake { epoch, max }
 *   desk →  log-cursor    { epoch, cursor }
 *   tab  →  log-batch     { epoch, events[] }   (one batch in flight)
 *   desk →  log-ack       { upTo }
 *
 * Shape of the stream, and why it is simpler than the workspace sync:
 *   - append-only: a row is never updated, so no LWW/conflict machinery;
 *   - single writer: this tab hosts the profile (see host-lease.ts);
 *   - the ack cursor makes resends free: the desktop ignores seqs it holds;
 *   - `epoch` names the log's sequence space. A fresh profile/log starts a
 *     new epoch and the desktop resets instead of mixing cursors.
 *
 * Live rows come from `AgentClient.onEngineEvent` (every streamed engine row,
 * not just one run). A reconnect starts with a handshake and backfills from
 * the tab's log DB, so rows logged while the desktop was offline still land.
 */
/** One engine row as it appears in the tab's `calls` table. */
export interface PeerLogRow {
  seq: number;
  run_id?: string;
  definition_id?: string;
  branch_path?: string | null;
  iteration?: number | null;
  scope_id?: number | null;
  kind: string;
  content?: unknown;
}

const EPOCH_KEY = (profile: string): string => `bob:peer-log:${profile}`;
/** A live reconnect never needs to replay more than a retention window. */
const BATCH_ROWS = 200;
/** Cap one frame's rows so a huge tool result cannot monopolize the channel. */
const BATCH_BYTES = 512 * 1024;
/** Above this the live queue yields to the DB backfill (which is on disk). */
const MAX_PENDING = 5_000;
const FLUSH_DELAY_MS = 250;

/** Kinds that should reach the desktop before the next debounce tick. */
const URGENT_KINDS = new Set(["llm_error", "tool_error"]);

const memoryEpochs = new Map<string, string>();

/**
 * Trim an ascending batch to the row and byte caps (always keeping at least
 * one row). The cursor only advances on the desktop's ack, so a capped batch
 * simply means the next window starts where this one stopped.
 */
function capBatch(rows: PeerLogRow[]): PeerLogRow[] {
  const out: PeerLogRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (out.length >= BATCH_ROWS) break;
    let size = 0;
    try {
      size = JSON.stringify(row).length;
    } catch {
      size = 1024;
    }
    if (out.length > 0 && bytes + size > BATCH_BYTES) break;
    out.push(row);
    bytes += size;
  }
  return out;
}

/**
 * The profile's log-stream identity. Persisted in localStorage (not the
 * workspace) so clearing the workspace/log DB does not resurrect a cursor.
 */
export function peerLogEpoch(profile: string): string {
  const remembered = memoryEpochs.get(profile);
  if (remembered) return remembered;
  try {
    const raw = localStorage.getItem(EPOCH_KEY(profile));
    if (raw) {
      memoryEpochs.set(profile, raw);
      return raw;
    }
  } catch {
    /* private mode / no localStorage (Node tests) */
  }
  const epoch =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `epoch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  memoryEpochs.set(profile, epoch);
  try {
    localStorage.setItem(EPOCH_KEY(profile), epoch);
  } catch {
    /* the in-memory map is the fallback */
  }
  return epoch;
}

function normalize(event: unknown): PeerLogRow | null {
  if (!event || typeof event !== "object") return null;
  const raw = event as Record<string, unknown>;
  const seq = Number(raw.seq);
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (!Number.isFinite(seq) || seq <= 0 || !kind) return null;
  return {
    seq,
    run_id: typeof raw.run_id === "string" ? raw.run_id : undefined,
    definition_id: typeof raw.definition_id === "string" ? raw.definition_id : undefined,
    branch_path: typeof raw.branch_path === "string" ? raw.branch_path : null,
    iteration: Number.isFinite(Number(raw.iteration)) ? Number(raw.iteration) : null,
    scope_id: Number.isFinite(Number(raw.scope_id)) ? Number(raw.scope_id) : null,
    kind,
    content: raw.content,
  };
}

export interface PeerLogShipperOptions {
  profile: string;
  /** Send one control frame on the paired channel. */
  send: (control: Record<string, unknown>) => void;
  /** Rows with seq > after, ascending, at most `limit` (from the tab's log DB). */
  load: (after: number, limit: number) => Promise<PeerLogRow[]>;
  /** The tab log's current max seq (0 when empty). */
  maxSeq: () => Promise<number>;
  /** Human-facing note (backlog, stream errors); never fatal. */
  onNote?: (message: string) => void;
}

export class PeerLogShipper {
  private epoch: string;
  /** Highest seq the desktop acknowledged. The stream resumes above it. */
  private cursor = 0;
  /** The desktop has answered the handshake. */
  private ready = false;
  /** One batch (or one DB window fetch) at a time. */
  private inflight = false;
  /** Live rows not yet handed to a batch. */
  private pending = new Map<number, PeerLogRow>();
  /** The DB may hold rows above `cursor` that the live tap missed. */
  private backfill = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private started = false;

  constructor(private opts: PeerLogShipperOptions) {
    this.epoch = peerLogEpoch(opts.profile);
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.announce();
  }

  private async announce(): Promise<void> {
    let max: number | undefined;
    try {
      max = await this.opts.maxSeq();
    } catch {
      // Unknown max: skip the regression check rather than claiming the log is
      // empty (a transient RPC failure must not wipe the desktop copy).
      max = undefined;
    }
    if (this.closed) return;
    this.opts.send({
      op: "log-handshake",
      epoch: this.epoch,
      ...(max === undefined ? {} : { max }),
    });
  }

  /** Route a control frame from the desktop (log-cursor/log-ack/log-error). */
  handleControl(control: Record<string, unknown>): void {
    if (this.closed) return;
    const op = String(control.op ?? "");
    if (op === "log-cursor") {
      const epoch = String(control.epoch ?? "");
      const cursor = Number(control.cursor ?? 0) || 0;
      if (epoch && epoch !== this.epoch) {
        // Another tab reset the desktop copy; follow its epoch rather than
        // fighting it for the sequence space (the host lease makes this rare).
        this.epoch = epoch;
      }
      // log-cursor is authoritative, including a reset back to 0 (the desktop
      // cleared a regressed/foreign sequence space); acks only move forward.
      this.cursor = cursor;
      this.ready = true;
      this.inflight = false;
      this.dropAcked();
      // Always reconcile from the cursor: the live tap may have started late.
      this.backfill = true;
      void this.pump();
      return;
    }
    if (op === "log-ack") {
      const upTo = Number(control.upTo ?? 0) || 0;
      if (upTo > this.cursor) this.cursor = upTo;
      this.inflight = false;
      this.dropAcked();
      void this.pump();
      return;
    }
    if (op === "log-error") {
      this.inflight = false;
      const message = String(control.error ?? "log stream error");
      if (/epoch/i.test(message)) {
        // The desktop copy belongs to another stream: handshake again, which
        // resets it to this tab's epoch, then resume from the new cursor.
        void this.announce();
      } else {
        this.note(`log stream paused: ${message}`);
      }
    }
  }

  /** Feed one streamed engine row (safe to call before the handshake). */
  push(event: unknown): void {
    if (this.closed) return;
    const row = normalize(event);
    if (!row) return;
    if (row.seq <= this.cursor) return;
    this.pending.set(row.seq, row);
    if (this.pending.size > MAX_PENDING) {
      // Keep the newest half; the rest is already in the log DB and the
      // backfill (which runs first) will fetch it from disk.
      const asc = [...this.pending.keys()].sort((a, b) => a - b);
      for (const seq of asc.slice(0, asc.length - Math.floor(MAX_PENDING / 2))) {
        this.pending.delete(seq);
      }
      this.backfill = true;
      this.note("log backlog moved to the run log; backfilling from disk");
    }
    if (URGENT_KINDS.has(row.kind)) this.flush();
    else this.schedule();
  }

  /** Send everything queued now (the debounce, and page unload, call this). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.pump();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, FLUSH_DELAY_MS);
  }

  private dropAcked(): void {
    for (const seq of [...this.pending.keys()]) {
      if (seq <= this.cursor) this.pending.delete(seq);
    }
  }

  private note(message: string): void {
    this.opts.onNote?.(message);
  }

  private async pump(): Promise<void> {
    if (!this.ready || this.inflight || this.closed) return;
    if (this.backfill) {
      // Fetch a window first: it carries rows logged before this connection
      // (or before the live tap existed) and the desktop dedupes the overlap.
      this.inflight = true;
      let rows: PeerLogRow[] = [];
      try {
        rows = await this.opts.load(this.cursor, BATCH_ROWS);
      } catch (err) {
        this.inflight = false;
        this.note(`log backfill failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.inflight = false;
      if (this.closed) return;
      rows = rows
        .map(normalize)
        .filter((row): row is PeerLogRow => !!row && row.seq > this.cursor)
        .sort((a, b) => a.seq - b.seq);
      rows = capBatch(rows);
      if (rows.length === 0) {
        this.backfill = false;
        void this.pump();
        return;
      }
      this.sendBatch(rows);
      return;
    }
    const rows = capBatch(
      [...this.pending.values()]
        .filter((row) => row.seq > this.cursor)
        .sort((a, b) => a.seq - b.seq),
    );
    if (!rows.length) {
      for (const seq of [...this.pending.keys()]) {
        if (seq <= this.cursor) this.pending.delete(seq);
      }
      return;
    }
    for (const row of rows) this.pending.delete(row.seq);
    this.sendBatch(rows);
  }

  private sendBatch(rows: PeerLogRow[]): void {
    this.inflight = true;
    try {
      this.opts.send({
        op: "log-batch",
        epoch: this.epoch,
        from: rows[0].seq,
        to: rows[rows.length - 1].seq,
        events: rows,
      });
    } catch (err) {
      this.inflight = false;
      for (const row of rows) this.pending.set(row.seq, row);
      this.note(`log stream send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
