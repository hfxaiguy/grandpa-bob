/**
 * Two-way bridge between a Telegram chat and a browser (OPFS) conversation.
 *
 * The browser tab is the conversation's brain: it runs the turns against its
 * own OPFS continuation and memory, and polls the admin's bridge endpoints
 * (admin.ts). This module is the server half: it remembers which chat is
 * bridged, holds messages the browser should answer, and watches the
 * heartbeat. It is deliberately stateless on disk — no log writes, no session
 * adoption, no follow bindings. The OPFS session never exists server-side;
 * only message text crosses the wire.
 *
 * Ownership while a tab is open: bot.ts defers text messages for a bridged
 * chat instead of running the tree (deferToBridge). When the heartbeat goes
 * stale — tab closed, laptop asleep — the sweep below hands every deferred
 * message to the bot's own session and one marker line tells the phone the
 * browser went away (see BRIDGE_AWAY_TEXT). That is a fallback identity, not
 * the same thread: the server's session has its own continuation.
 *
 * Relays that arrive after a fallback (a suspended tab resuming) are dropped
 * via the epoch counter: the phone already has the server's answer, so a late
 * browser reply would only duplicate it.
 */
/** One-line marker sent on the phone when a tab establishes the bridge. */
export const BRIDGE_LINKED_TEXT =
  "\ud83d\udda5\ufe0f bridged — this chat now runs your browser conversation while the tab is open.";
/** One-line marker sent before the first server-side fallback answer. */
export const BRIDGE_AWAY_TEXT =
  "\ud83d\udda5\ufe0f the browser went away — I'm answering from the bot's own memory now.";
/** Reply to attachments while bridged (only text crosses the bridge in v1). */
export const BRIDGE_TEXT_ONLY_TEXT =
  "\ud83d\udda5\ufe0f this chat is bridged to the browser — text only for now. Send it as text in the browser chat.";

/** A text message the browser should answer. */
export interface BridgeMessage {
  id: number;
  text: string;
  chatId: number;
  threadId: number;
}

/** What the browser poller sees for one pending message. */
export interface PendingMessage {
  id: number;
  text: string;
  arrivedAt: number;
}

interface DeferredMessage extends BridgeMessage {
  arrivedAt: number;
  /** Server-side fallback: run this message in the bot's own session. */
  run: () => Promise<void> | void;
  /** Marker to send before the fallback answer (bridge loss only). */
  away: () => Promise<void> | void;
}

interface ChatState {
  lastBeat: number;
  pending: DeferredMessage[];
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * The heartbeat is refreshed every 4 s (10 s when the tab is hidden), so 15 s
 * of silence means the tab is gone. Kept short on purpose: the phone waits at
 * most this long before the bot takes over.
 */
const TTL_MS = envMs("BRIDGE_TTL_MS", 15_000);
const SWEEP_MS = envMs("BRIDGE_SWEEP_MS", 3_000);
/** Cap a pathological backlog; older deferred messages are dropped. */
const MAX_PENDING = 50;
/** How many answered ids the inbox reports so a resumed tab can skip them. */
const ANSWERED_KEEP = 100;

const chats = new Map<string, ChatState>();
/** Bumped when a bridge falls back; late relays carrying an old epoch drop. */
const epochs = new Map<string, number>();
/** Ids answered server-side, so a resumed tab does not re-run them. */
const answered = new Map<string, number[]>();

let sweepTimer: NodeJS.Timeout | null = null;
let sweeping = false;

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => void sweepStale(), SWEEP_MS);
  // Never keep the process alive for the sweep.
  sweepTimer.unref?.();
}

/** Is this chat currently owned by a live browser tab? */
export function isBridgeFresh(convKey: string, now = Date.now()): boolean {
  const st = chats.get(convKey);
  return !!st && now - st.lastBeat < TTL_MS;
}

/**
 * Refresh the heartbeat for a chat. Returns `linked: true` exactly when the
 * bridge was off before this beat — the caller announces it on the phone once.
 */
export function bridgeBeat(convKey: string, now = Date.now()): { linked: boolean } {
  const linked = !isBridgeFresh(convKey, now);
  const st = chats.get(convKey) ?? { lastBeat: 0, pending: [] };
  st.lastBeat = now;
  chats.set(convKey, st);
  ensureSweep();
  return { linked };
}

/**
 * Defer a text message to the browser when its chat is bridged. Returns true
 * when the message was taken (the caller must NOT run the tree). The `run` and
 * `away` closures are kept until the browser answers or the sweep falls back.
 */
export function deferToBridge(
  convKey: string,
  msg: BridgeMessage,
  run: () => Promise<void> | void,
  away: () => Promise<void> | void,
): boolean {
  if (!isBridgeFresh(convKey)) return false;
  const st = chats.get(convKey);
  if (!st) return false;
  if (!st.pending.some((p) => p.id === msg.id)) {
    st.pending.push({ ...msg, arrivedAt: Date.now(), run, away });
    if (st.pending.length > MAX_PENDING) st.pending.shift();
    ensureSweep();
  }
  return true;
}

/** Messages waiting for the browser (oldest first). */
export function bridgePending(convKey: string): PendingMessage[] {
  const st = chats.get(convKey);
  if (!st) return [];
  return st.pending.map((p) => ({ id: p.id, text: p.text, arrivedAt: p.arrivedAt }));
}

/** The browser answered a message (or finished a turn): stop tracking it. */
export function bridgeReplied(convKey: string, messageId?: number): void {
  const st = chats.get(convKey);
  if (!st) return;
  if (messageId === undefined) st.pending = [];
  else st.pending = st.pending.filter((p) => p.id !== messageId);
}

/** Turn the bridge off explicitly (the tab was closed or the user disabled it). */
export function bridgeOff(convKey: string): void {
  chats.delete(convKey);
}

/** The freshest bridged chat, stale or not — the poller's target after a beat. */
export function bridgeLastTarget(): string | null {
  let key: string | null = null;
  let latest = -1;
  for (const [conv, st] of chats) {
    if (st.lastBeat > latest) {
      latest = st.lastBeat;
      key = conv;
    }
  }
  return key;
}

/** Current epoch — the browser echoes it when relaying a completed turn. */
export function bridgeEpoch(convKey: string): number {
  return epochs.get(convKey) ?? 0;
}

/** Ids the server itself answered after the bridge went stale. */
export function bridgeAnswered(convKey: string): number[] {
  return [...(answered.get(convKey) ?? [])];
}

function markAnswered(convKey: string, id: number): void {
  const list = answered.get(convKey) ?? [];
  list.push(id);
  answered.set(convKey, list.slice(-ANSWERED_KEEP));
}

/** Split text the way the phone path does (Telegram caps at 4096). */
export function chunkForTelegram(text: string, size = 4000): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/**
 * Fall back every chat whose heartbeat has gone stale. Deferred messages run
 * in arrival order inside the bot's own session; the away marker precedes the
 * first of them. Empty bridges are simply forgotten.
 */
async function sweepStale(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    for (const [conv, st] of [...chats]) {
      if (now - st.lastBeat < TTL_MS) continue;
      if (!st.pending.length) {
        chats.delete(conv);
        continue;
      }
      const pending = st.pending;
      chats.delete(conv);
      epochs.set(conv, bridgeEpoch(conv) + 1);
      try {
        await pending[0].away();
      } catch (err) {
        console.warn("[bridge] away marker failed:", err);
      }
      for (const p of pending) {
        markAnswered(conv, p.id);
        try {
          await p.run();
        } catch (err) {
          console.warn("[bridge] fallback run failed:", err);
        }
      }
    }
  } finally {
    sweeping = false;
  }
}

/** Test/restart hook: forget every bridged chat. */
export function resetBridge(): void {
  chats.clear();
  epochs.clear();
  answered.clear();
}
