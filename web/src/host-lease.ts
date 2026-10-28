/**
 * Single-host lease per workspace.
 *
 * The browser tab is the only agent host, so exactly one tab may run turns
 * against a workspace (an OPFS profile, or a desktop folder through the
 * bridge). The lease picks that tab: the first tab wins, further tabs stay
 * secondary (read-only) and auto-promote when the primary goes away.
 *
 * Two mechanisms behind one interface:
 * - `navigator.locks` (Web Locks) when available — the strongest guarantee:
 *   the browser releases the lock when the holding tab closes or crashes.
 * - a localStorage heartbeat otherwise — `bob-host-lease:<key>` carries
 *   `{holder, at}`; a record older than the staleness window reads as free.
 *   Weaker than Web Locks (a crashed tab holds the lease until it expires),
 *   but only affects browsers without Web Locks.
 *
 * A BroadcastChannel (`bob-host:<key>`) coordinates both paths: heartbeats,
 * a "free" signal on voluntary release, and yield-requests for takeover.
 * Every dependency is injectable, so the contention logic is unit-testable
 * in Node (`scripts/host-lease-test.ts`).
 */

/** Minimal structural types so the module stays lib-free and test-injectable. */
interface LockHandle {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void>,
  ): Promise<unknown>;
}
interface LeaseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface LeaseChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close?(): void;
}

export interface LeaseDeps {
  /** Web Locks manager; `null` forces the localStorage heartbeat path. */
  locks?: LockHandle | null;
  /** localStorage-like store; `null` disables the fallback lease. */
  storage?: LeaseStorage | null;
  /** BroadcastChannel-like bus; `null` runs without cross-tab signals. */
  channel?: LeaseChannel | null;
  now?: () => number;
  holderId?: string;
}

export type LeaseStatus = "primary" | "secondary" | "none";

const LEASE_PREFIX = "bob-host-lease:";
const CHANNEL_PREFIX = "bob-host:";
/** A fallback heartbeat older than this reads as a dead holder. */
const STALE_MS = 6_000;
const HEARTBEAT_MS = 2_000;
/** How often a secondary tab re-tries the acquire. */
const RETRY_MS = 1_000;
/** How long a takeOver waits for the current holder to yield. */
const YIELD_TIMEOUT_MS = 3_000;

interface LeaseRecord {
  holder: string;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRecord(raw: string | null, nowMs: number): LeaseRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value.holder !== "string") return null;
    const at = Number(value.at);
    if (!Number.isFinite(at)) return null;
    // An abandoned holderId with a stopped clock (at === 0) is a release mark.
    if (at === 0) return null;
    if (nowMs - at > STALE_MS) return null;
    return { holder: value.holder, at };
  } catch {
    return null;
  }
}

function randomId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `h-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HostLease {
  readonly key: string;
  status(): LeaseStatus;
  /** Subscribe to status changes; returns an unsubscribe function. */
  subscribe(cb: (status: LeaseStatus) => void): () => void;
  /** Resolves once the first acquire attempt has settled. */
  whenSettled(): Promise<LeaseStatus>;
  /**
   * Ask the current holder to yield and take the lease. Resolves true when
   * this tab is primary afterwards; false when the holder did not respond.
   */
  takeOver(): Promise<boolean>;
  /** Give the lease up (voluntary release; signals "free" to the other tabs). */
  release(): void;
}

/**
 * Acquire the lease for this tab. Call once per page; the returned object
 * lives for the page's lifetime and auto-promotes secondary tabs.
 */
export function createHostLease(key: string, deps: LeaseDeps = {}): HostLease {
  const now = deps.now ?? ((): number => Date.now());
  const id = deps.holderId ?? randomId();
  const storage =
    deps.storage !== undefined
      ? deps.storage
      : ((globalThis.localStorage as LeaseStorage | undefined) ?? null);
  const locks =
    deps.locks !== undefined
      ? deps.locks
      : ((globalThis.navigator as unknown as { locks?: LockHandle } | undefined)?.locks ?? null);
  const channel = deps.channel ?? null;

  const lockName = `bob-host:${key}`;
  const channelName = `bob-host:${key}`;

  let status: LeaseStatus = "none";
  // An opaque read for comparisons: TS narrowing cannot see the async
  // callbacks below mutating `status` (TS2367 false positives).
  const statusNow = (): LeaseStatus => status;
  let stopped = false;
  let settledResolve: ((status: LeaseStatus) => void) | null = null;
  const settled = new Promise<LeaseStatus>((resolve) => (settledResolve = resolve));
  const listeners = new Set<(status: LeaseStatus) => void>();
  /** Resolves the Web Locks hold promise (null on the heartbeat path). */
  let releaseHold: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setInterval> | null = null;

  function setStatus(next: LeaseStatus): void {
    if (status === next) return;
    status = next;
    for (const cb of listeners) cb(next);
  }

  function post(message: Record<string, unknown>): void {
    try {
      channel?.postMessage({ v: 1, from: id, ...message });
    } catch {
      /* a closed port is not an error */
    }
  }

  // ── acquire ──────────────────────────────────────────────────────────

  /** One acquire attempt; true when this tab ends up primary. */
  async function tryAcquire(): Promise<boolean> {
    if (stopped || status === "primary") return status === "primary";
    // No mechanism at all (no Web Locks, no storage): the tab stays "none"
    // rather than retrying forever — an embedded/file-less context.
    if (!locks && !storage) {
      setStatus("none");
      settleAttempt();
      return false;
    }
    const ok = locks ? (await locksAcquire()) : (await heartbeatAcquire());
    if (ok) startHeartbeat();
    else startRetry();
    // The first attempt has settled (primary or secondary): whenSettled
    // resolves either way — a secondary tab is a normal, expected outcome.
    settleAttempt();
    return ok;
  }

  function locksAcquire(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settledCb = false;
      const settle = (granted: boolean): void => {
        if (settledCb) return;
        settledCb = true;
        if (granted) {
          setStatus("primary");
          notifySettled();
        }
        resolve(granted);
      };
      void locks!
        .request(lockName, { ifAvailable: true }, async (lock) => {
          if (lock == null) {
            setStatus("secondary"); // someone else holds the lock
            return settle(false);
          }
          // Hold the lease until release(): resolving this promise returns
          // the lock, and the browser re-releases it when the tab dies.
          settle(true);
          await new Promise<void>((r) => (releaseHold = r));
          releaseHold = null;
          if (!stopped) setStatus("secondary");
        })
        .catch(() => settle(false));
    });
  }

  /** Claim the localStorage record; verify after a beat to break write races. */
  async function heartbeatAcquire(): Promise<boolean> {
    if (!storage) return false;
    const record = parseRecord(storage.getItem(LEASE_PREFIX + key), now());
    if (record && record.holder !== id) {
      setStatus("secondary"); // someone else holds it right now
      return false;
    }
    if (!writeRecord()) return false; // quota/private mode: stay out of the way
    await sleep(150);
    if (stopped) return false;
    const after = parseRecord(storage.getItem(LEASE_PREFIX + key), now());
    if (after && after.holder !== id) {
      setStatus("secondary"); // another tab won the write race
      return false;
    }
    setStatus("primary");
    notifySettled();
    return true;
  }

  /** Write a fresh heartbeat; false when the store is unavailable. */
  function writeRecord(): boolean {
    if (!storage) return false;
    try {
      storage.setItem(LEASE_PREFIX + key, JSON.stringify({ holder: id, at: now() }));
      return true;
    } catch {
      return false;
    }
  }

  function startRetry(): void {
    if (retryTimer || stopped) return;
    retryTimer = setInterval(() => {
      if (stopped || status === "primary") return clearRetry();
      void tryAcquire();
    }, RETRY_MS);
  }

  function clearRetry(): void {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
  }

  function startHeartbeat(): void {
    if (heartbeatTimer || stopped) return;
    heartbeatTimer = setInterval(() => {
      if (stopped || status !== "primary") {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        return;
      }
      // The heartbeat path must keep its record fresh; the locks path only
      // signals liveness (for yield-requests and human-readable debugging).
      if (!locks) {
        const record = parseRecord(storage?.getItem(LEASE_PREFIX + key) ?? null, now());
        if (record && record.holder !== id) {
          // Another tab took the lease (stale-bookkeeping recovery): demote.
          setStatus("secondary");
          startRetry();
          return;
        }
        writeRecord();
      }
      post({ kind: "beat" });
    }, HEARTBEAT_MS);
  }

  function notifySettled(): void {
    settledResolve?.(status);
    settledResolve = null;
    clearRetry();
  }

  /** Resolve `whenSettled` once the first acquire attempt has an outcome. */
  function settleAttempt(): void {
    settledResolve?.(status);
    settledResolve = null;
  }

  // ── takeover / release ───────────────────────────────────────────────

  async function takeOver(): Promise<boolean> {
    if (status === "primary") return true;
    if (stopped) return false;
    post({ kind: "yield-request" });
    const deadline = now() + YIELD_TIMEOUT_MS;
    while (now() < deadline && !stopped) {
      if (await tryAcquire()) return true;
      await sleep(300);
    }
    return statusNow() === "primary";
  }

  /** Give the lease up and keep watching (auto-promote when the holder goes). */
  function yieldTo(): void {
    if (status !== "primary") return;
    if (!locks && storage) {
      // Release mark: parses as free immediately (no staleness wait).
      try {
        storage.setItem(LEASE_PREFIX + key, JSON.stringify({ holder: id, at: 0 }));
      } catch {
        /* leave the stale record; it expires */
      }
    }
    releaseHold?.();
    releaseHold = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    setStatus("secondary");
    post({ kind: "free" });
    startRetry();
  }

  function release(): void {
    if (status !== "primary" && !releaseHold) {
      stopped = true;
      clearRetry();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      setStatus("none");
      return;
    }
    stopped = true;
    clearRetry();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (!locks && storage && status === "primary") {
      // Release mark: `at: 0` parses as free immediately (no staleness wait).
      try {
        storage.setItem(LEASE_PREFIX + key, JSON.stringify({ holder: id, at: 0 }));
      } catch {
        /* leave the stale record; it expires */
      }
    }
    releaseHold?.();
    releaseHold = null;
    setStatus("none");
    post({ kind: "free" });
  }

  // ── channel wiring ───────────────────────────────────────────────────

  if (channel) {
    channel.onmessage = (event) => {
      const data = event?.data as Record<string, unknown> | null;
      if (!isRecord(data) || data.from === id) return;
      const kind = data.kind;
      if (kind === "free") {
        // A holder released: secondaries try immediately, not on the next tick.
        if (status === "secondary") void tryAcquire();
      } else if (kind === "yield-request") {
        // Hand the lease over and keep watching (cooperative takeover).
        if (status === "primary") yieldTo();
      }
      // "beat" is informational; staleness handles dead holders.
    };
  }

  void tryAcquire();

  return {
    key,
    status: () => status,
    subscribe(cb: (s: LeaseStatus) => void): () => void {
      listeners.add(cb);
      cb(status);
      return () => listeners.delete(cb);
    },
    whenSettled: () => settled,
    takeOver,
    release,
  };
}
