/**
 * Memory-slot tracking — one implementation for both hosts.
 *
 * The Node admin (src/admin.ts) and the in-browser backend
 * (web/src/server/local-backend.ts) both keep a read-only "current memory" map
 * for the tiles' memory panels: the last value each tree memory slot was
 * written with, per conversation key and grouped by the app (tree tool) that
 * wrote it — "trunk" for the top-level tree.
 *
 * A slot is identified by (scope_id, name): `.memoryUpdate()` deep in a branch
 * writes to the slot's *declaring* scope, so keying by scope_id collapses the
 * update onto the `.memory()` node instead of leaving it stuck at its seed
 * value. Each write also records the concrete node paths it lands on, so the
 * panel can merge one write in place (the admin's SSE `memory` message)
 * instead of refetching.
 *
 * Scoping by conversation key keeps live sessions apart: every run re-seeds its
 * trunk slots at scope_id 0, so a concurrent Telegram turn mirrored into the
 * panel would otherwise write the very same slot keys and leave the browser
 * showing a chimera of both conversations.
 *
 * The map is process state: it dies with the Node admin's process and with the
 * browser tab. Hosts rebuild it lazily from their persisted run log
 * (`rebuild`). That rebuild deliberately does NOT reuse the sanitized per-turn
 * event window (`getTurns(…, { withEvents: true })`): the window is tail-capped
 * at MAX_TURN_EVENTS in both src/web-log.ts and web/src/agent/log-store.ts, and
 * sanitization truncates strings (MAX_EVENT_STR) and collapses arrays for
 * streaming — while the panel needs the engine's own values, including a slot
 * written early in a very long turn. The hosts' `memoryWrites()` readers query
 * the raw `calls` rows for each turn's seq bounds instead.
 */

/** One raw memory-slot write, as read back from the run log (`calls`). */
export interface MemoryWrite {
  /** The row's seq — replay sorts by it, so overlapping readers stay ordered. */
  seq?: number;
  kind?: string;
  branch_path?: string | null;
  scope_id?: number | null;
  content?: Record<string, unknown> | null;
  /** The app (outermost tree tool) the write belongs to; "trunk" at top level. */
  app?: string;
}

/** The `/api/tree/memory` body: flat path→value plus the same values per app. */
export interface MemoryPayload {
  values: Record<string, unknown>;
  apps: Record<string, Record<string, unknown>>;
}

/** A write pushed to a live browser (the admin's SSE `memory` message). */
export interface MemoryWritePush {
  session: string;
  app: string;
  values: Record<string, unknown>;
}

export interface MemoryTracker {
  /** Track one raw agent event; returns the pushed write, or null. */
  track(key: string, ev: unknown, app?: string): MemoryWritePush | null;
  /** The panel payload for one conversation. */
  payload(key: string): MemoryPayload;
  /**
   * Replace a session's map with the values of its persisted writes (oldest
   * first). Idempotent: the first call per session wins, later calls no-op —
   * everything after that point arrives through `track()`. A session this
   * process already tracked is left alone: its writes are newer than anything
   * in the log (a live turn may not be persisted yet).
   */
  rebuild(key: string, writes: MemoryWrite[]): void;
  /** True until this session has been rebuilt or cleared in this process. */
  needsRebuild(key: string): boolean;
  /** Forget a conversation's tracked memory, or every session. */
  clear(key?: string): void;
}

/**
 * Bound the per-session maps: conversations come and go (clear mints a fresh
 * key), and only the drawer's handful are ever on screen.
 */
export const MAX_MEMORY_SESSIONS = 32;

export function createMemoryTracker({
  maxSessions = MAX_MEMORY_SESSIONS,
}: { maxSessions?: number } = {}): MemoryTracker {
  const values = new Map<string, Map<string, Map<string, unknown>>>(); // session -> app -> slotKey -> value
  const paths = new Map<string, Map<string, Map<string, Set<string>>>>(); // session -> app -> slotKey -> node paths
  /**
   * Sessions whose map is authoritative: rebuilt from the log or deliberately
   * dropped. Without this, a polled `/api/tree/memory` would rescan the log on
   * every request — and a cleared session would resurrect its old slots.
   */
  const sealed = new Set<string>();

  /**
   * The tracked memory for one conversation, created on first use. The oldest
   * conversations are dropped once `maxSessions` are held (Map preserves
   * insertion order, so `.keys().next()` is the least recently *created*).
   * Eviction unseals: the next view rebuilds from the log.
   */
  function sessionMemory(key: string): {
    values: Map<string, Map<string, unknown>>;
    paths: Map<string, Map<string, Set<string>>>;
  } {
    let sessionValues = values.get(key);
    if (!sessionValues) {
      sessionValues = new Map();
      values.set(key, sessionValues);
      while (values.size > maxSessions) {
        const oldest = values.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        values.delete(oldest);
        paths.delete(oldest);
        sealed.delete(oldest);
      }
    }
    let sessionPaths = paths.get(key);
    if (!sessionPaths) {
      sessionPaths = new Map();
      paths.set(key, sessionPaths);
    }
    return { values: sessionValues, paths: sessionPaths };
  }

  function track(key: string, ev: unknown, app = "trunk"): MemoryWritePush | null {
    const raw = ev as MemoryWrite | null | undefined;
    const content = raw?.content ?? null;
    // Memory writes are record events with op memory/memoryUpdate; older runs
    // logged them as their own "memory" kind.
    const memWrite =
      raw?.kind === "memory" ||
      (raw?.kind === "record" && (content?.op === "memory" || content?.op === "memoryUpdate"));
    if (!memWrite || raw?.scope_id == null || !content) return null;
    const child = typeof content.child === "string" ? content.child : "";
    const slotKey = `${raw.scope_id}/${child}`;
    const nodePath = (raw.branch_path ?? "") + (child ? "/" + child : "");
    const { values: sessionValues, paths: sessionPaths } = sessionMemory(key);
    let slotPaths: Set<string> | undefined;
    if (nodePath) {
      let slots = sessionPaths.get(app);
      if (!slots) { slots = new Map(); sessionPaths.set(app, slots); }
      slotPaths = slots.get(slotKey);
      if (!slotPaths) { slotPaths = new Set(); slots.set(slotKey, slotPaths); }
      slotPaths.add(nodePath);
    }
    if (!("value" in content)) return null;
    let slots = sessionValues.get(app);
    if (!slots) { slots = new Map(); sessionValues.set(app, slots); }
    slots.set(slotKey, content.value);
    // The concrete node paths this write lands on, so the browser can merge it
    // in immediately instead of waiting for the next full re-fetch at turn end.
    const pushed: Record<string, unknown> = {};
    for (const p of slotPaths ?? []) pushed[p] = content.value;
    return Object.keys(pushed).length ? { session: key, app, values: pushed } : null;
  }

  function payload(key: string): MemoryPayload {
    const flat: Record<string, unknown> = {};
    const apps: Record<string, Record<string, unknown>> = {};
    const sessionValues = values.get(key);
    const sessionPaths = paths.get(key);
    if (!sessionValues || !sessionPaths) return { values: flat, apps };
    for (const [app, slots] of sessionValues) {
      const pathMap = sessionPaths.get(app);
      if (!pathMap) continue;
      for (const [slotKey, v] of slots) {
        if (v === undefined) continue;
        for (const p of pathMap.get(slotKey) ?? []) {
          flat[p] = v;
          (apps[app] ??= {})[p] = v;
        }
      }
    }
    return { values: flat, apps };
  }

  function rebuild(key: string, writes: MemoryWrite[]): void {
    if (sealed.has(key)) return;
    sealed.add(key);
    // Writes tracked before this rebuild are newer than anything in the log (a
    // live turn may not have a marker yet), so keep them instead of replaying
    // history over them. A mid-turn write still arrives through `track()`.
    if (values.has(key)) return;
    // Touch the session even when there is nothing to replay, so it still
    // participates in the LRU (and its seal is evicted with it).
    sessionMemory(key);
    for (const w of [...writes].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
      track(key, w, w.app ?? "trunk");
    }
  }

  function clear(key?: string): void {
    if (key) {
      values.delete(key);
      paths.delete(key);
      sealed.add(key);
      return;
    }
    for (const k of new Set([...values.keys(), ...paths.keys()])) sealed.add(k);
    values.clear();
    paths.clear();
  }

  return {
    track,
    payload,
    rebuild,
    needsRebuild: (key) => !sealed.has(key),
    clear,
  };
}
