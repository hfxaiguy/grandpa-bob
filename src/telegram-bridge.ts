/**
 * Telegram channel: the mailbox and host registry (the HTTP layer lives in
 * src/index.ts).
 *
 * Standalone-only model: the browser tab is the conversation's brain — Node
 * never runs the agent. Every inbound message is *parked* in a mailbox file
 * for a tab to drain; replies come back through the relay endpoint. When no
 * tab is connected, messages simply wait — the mailbox survives channel
 * restarts because it is on disk.
 *
 * State layout (base: BOB_STATE_DIR, default ~/.bobkat; mailbox: <base>/telegram):
 *
 *   bindings.json          { [convKey]: { profile, epoch, lastBeat } }
 *   mailbox/<convKey>.jsonl  one JSON per line: {id, text, arrivedAt}
 *   answered/<convKey>.json  { ids: [...] } — recently answered, so a resumed
 *                            tab does not re-run them (at-least-once delivery)
 *
 * Bindings form from traffic: a tab that drains parked messages claims their
 * chats for its profile (`claimPending`). Claiming a chat bound to a
 * *different* profile is a handover — the epoch bumps, and relays carrying an
 * older epoch (a suspended old tab answering late) are dropped.
 *
 * The sweep expires bindings whose heartbeat went stale — parked messages are
 * never touched; an expired chat simply becomes claimable again.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "./state-dir.js";

/** One-line marker sent on the phone when a tab claims a chat. */
export const BRIDGE_LINKED_TEXT =
  "\ud83d\udda5\ufe0f bridged — this chat now runs your browser conversation while the tab is open.";
/** Reply to attachments: only text crosses the channel in v1. */
export const BRIDGE_TEXT_ONLY_TEXT =
  "\ud83d\udda5\ufe0f attachments are not supported over Telegram yet — send it as text in the web chat.";

/** A text message parked for the browser. */
export interface BridgeMessage {
  id: number;
  text: string;
  chatId: number;
  threadId: number;
}

/** What the browser poller sees for one parked message. */
export interface PendingMessage {
  id: number;
  text: string;
  arrivedAt: number;
  /** The conversation key this message waits under. */
  conv: string;
}

/** The claim result: messages plus per-chat epoch (relays must carry it). */
export interface Claimed {
  messages: PendingMessage[];
  /** Chats newly bound to this profile by this claim. */
  claimed: string[];
  /** Epoch per returned chat. */
  epochs: Record<string, number>;
  answered: Record<string, number[]>;
}

interface Binding {
  profile: string;
  epoch: number;
  lastBeat: number;
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * The heartbeat is refreshed every 4 s (10 s when the tab is hidden), so 15 s
 * of silence means the tab is gone. Expiry only makes the chat claimable
 * again — the mailbox keeps every parked message.
 */
export const BRIDGE_TTL_MS = envMs("BRIDGE_TTL_MS", 15_000);
const SWEEP_MS = envMs("BRIDGE_SWEEP_MS", 3_000);
/** How many answered ids to remember per chat (skip-on-reconnect). */
const ANSWERED_KEEP = 100;

const root = statePath("telegram");
const mailboxDir = path.join(root, "mailbox");
const answeredDir = path.join(root, "answered");
const bindingsFile = path.join(root, "bindings.json");

/** In-memory cache of bindings.json — tiny, and writes rewrite it whole. */
let bindings = new Map<string, Binding>();
let bindingsLoaded: Promise<void> | null = null;

async function ensureDirs(): Promise<void> {
  await fs.mkdir(mailboxDir, { recursive: true });
  await fs.mkdir(answeredDir, { recursive: true });
}

async function loadBindings(): Promise<void> {
  if (bindingsLoaded) return bindingsLoaded;
  bindingsLoaded = (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(bindingsFile, "utf8")) as unknown;
      if (raw && typeof raw === "object") {
        const next = new Map<string, Binding>();
        for (const [conv, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!value || typeof value !== "object") continue;
          const b = value as Partial<Binding>;
          if (typeof b.profile !== "string" || typeof b.epoch !== "number") continue;
          next.set(conv, {
            profile: b.profile,
            epoch: b.epoch,
            lastBeat: typeof b.lastBeat === "number" ? b.lastBeat : 0,
          });
        }
        bindings = next;
      }
    } catch {
      /* first boot / corrupt file: start empty */
    }
  })();
  return bindingsLoaded;
}

let bindingsWrite: Promise<void> = Promise.resolve();

function saveBindings(): void {
  // Serialize writes; beats and claims must never interleave a rewrite.
  bindingsWrite = bindingsWrite
    .then(async () => {
      await ensureDirs();
      const data = JSON.stringify(Object.fromEntries(bindings), null, 2);
      const tmp = `${bindingsFile}.tmp`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, bindingsFile);
    })
    .catch((err) => console.warn("[bridge] bindings write failed:", err));
}

// ── mailbox ──────────────────────────────────────────────────────────────

function mailboxFile(conv: string): string {
  // convKey is "<chatId>:<threadId>" — both numeric, filename-safe.
  return path.join(mailboxDir, `${conv}.jsonl`);
}

function answeredFile(conv: string): string {
  return path.join(answeredDir, `${conv}.json`);
}

/** Park one message for whichever tab drains this chat next. */
export async function parkMessage(conv: string, msg: BridgeMessage): Promise<void> {
  await ensureDirs();
  const line = `${JSON.stringify({ id: msg.id, text: msg.text, arrivedAt: Date.now() })}\n`;
  await fs.appendFile(mailboxFile(conv), line, "utf8");
}

/** Read one mailbox file as parsed entries (torn lines are skipped). */
async function readMailbox(conv: string): Promise<Array<{ id: number; text: string; arrivedAt: number }>> {
  let raw: string;
  try {
    raw = await fs.readFile(mailboxFile(conv), "utf8");
  } catch {
    return [];
  }
  const out: Array<{ id: number; text: string; arrivedAt: number }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { id?: unknown; text?: unknown; arrivedAt?: unknown };
      if (typeof entry.id !== "number" || typeof entry.text !== "string") continue;
      out.push({
        id: entry.id,
        text: entry.text,
        arrivedAt: typeof entry.arrivedAt === "number" ? entry.arrivedAt : 0,
      });
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** Every conversation key that has parked messages. */
async function pendingConvs(): Promise<string[]> {
  try {
    const names = await fs.readdir(mailboxDir);
    return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

/**
 * Drain the inbox for one profile's tab: parked messages from unclaimed
 * chats (claimed now for this profile) and from chats already bound to it.
 * Chats bound to another live profile are left alone — their tab owns them.
 */
export async function claimPending(profileId: string, now = Date.now()): Promise<Claimed> {
  await loadBindings();
  await ensureDirs();
  const messages: PendingMessage[] = [];
  const claimed: string[] = [];
  const epochs: Record<string, number> = {};
  const answered: Record<string, number[]> = {};
  for (const conv of await pendingConvs()) {
    const binding = bindings.get(conv);
    let handoverEpoch: number | null = null;
    if (binding && binding.profile !== profileId) {
      if (now - binding.lastBeat < BRIDGE_TTL_MS) continue; // a live tab owns it
      handoverEpoch = binding.epoch; // expired: claimable again, epoch carries
      bindings.delete(conv);
    }
    const entries = await readMailbox(conv);
    if (!entries.length) continue;
    const current = bindings.get(conv);
    if (!current) {
      bindings.set(conv, {
        profile: profileId,
        epoch: handoverEpoch !== null ? handoverEpoch + 1 : 0,
        lastBeat: now,
      });
      claimed.push(conv);
    } else {
      current.lastBeat = now;
    }
    epochs[conv] = bindings.get(conv)!.epoch;
    answered[conv] = await answeredIds(conv);
    for (const entry of entries) {
      messages.push({ conv, id: entry.id, text: entry.text, arrivedAt: entry.arrivedAt });
    }
  }
  if (claimed.length) saveBindings();
  return { messages, claimed, epochs, answered };
}

/** Refresh the heartbeat for every chat bound to this profile. */
export async function beatProfile(profileId: string, now = Date.now()): Promise<void> {
  await loadBindings();
  let dirty = false;
  for (const [, binding] of bindings) {
    if (binding.profile === profileId && now - binding.lastBeat >= 1000) {
      binding.lastBeat = now;
      dirty = true;
    }
  }
  if (dirty) saveBindings();
}

/** Remove parked messages once the tab has handed them to the app. */
export async function ackMessages(conv: string, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const drop = new Set(ids);
  let raw: string;
  try {
    raw = await fs.readFile(mailboxFile(conv), "utf8");
  } catch {
    return;
  }
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let id: unknown = null;
    try {
      id = (JSON.parse(line) as { id?: unknown }).id;
    } catch {
      kept.push(line); // a torn line is never silently dropped
      continue;
    }
    if (typeof id !== "number" || !drop.has(id)) kept.push(line);
  }
  const tmp = `${mailboxFile(conv)}.tmp`;
  await fs.writeFile(tmp, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  await fs.rename(tmp, mailboxFile(conv));
  await markAnswered(conv, ids);
}

/** Ids answered recently, so a resumed tab does not re-run them. */
export async function answeredIds(conv: string): Promise<number[]> {
  try {
    const raw = JSON.parse(await fs.readFile(answeredFile(conv), "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      const ids = (raw as { ids?: unknown }).ids;
      if (Array.isArray(ids)) return ids.filter((n): n is number => typeof n === "number");
    }
  } catch {
    /* none yet */
  }
  return [];
}

async function markAnswered(conv: string, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const known = await answeredIds(conv);
  const list = [...new Set([...known, ...ids])].slice(-ANSWERED_KEEP);
  await ensureDirs();
  const tmp = `${answeredFile(conv)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ids: list }), "utf8");
  await fs.rename(tmp, answeredFile(conv));
}

// ── bindings (chat → profile) ────────────────────────────────────────────

/** Is this chat currently owned by a live browser tab? */
export function isBridgeFresh(conv: string, now = Date.now()): boolean {
  const b = bindings.get(conv);
  return !!b && now - b.lastBeat < BRIDGE_TTL_MS;
}

/** Current epoch of a chat's binding (0 when unbound) — relays carry it. */
export async function bridgeEpoch(conv: string): Promise<number> {
  await loadBindings();
  return bindings.get(conv)?.epoch ?? 0;
}

/** The profile a chat is currently bound to, or null. */
export async function bindingProfile(conv: string): Promise<string | null> {
  await loadBindings();
  return bindings.get(conv)?.profile ?? null;
}

/** All chats bound to a profile, freshest heartbeat first. */
export async function bindingsFor(profileId: string): Promise<Array<{ conv: string; epoch: number; lastBeat: number }>> {
  await loadBindings();
  return [...bindings.entries()]
    .filter(([, b]) => b.profile === profileId)
    .map(([conv, b]) => ({ conv, epoch: b.epoch, lastBeat: b.lastBeat }))
    .sort((a, b) => b.lastBeat - a.lastBeat);
}

/** Drop a binding explicitly (the tab unlinked the chat). */
export async function bridgeOff(conv: string): Promise<void> {
  await loadBindings();
  if (bindings.delete(conv)) saveBindings();
}

/** Drop bindings whose heartbeat expired. Parked messages are never touched. */
export function startSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    let dirty = false;
    for (const [conv, b] of bindings) {
      if (now - b.lastBeat >= BRIDGE_TTL_MS) {
        bindings.delete(conv);
        dirty = true;
      }
    }
    if (dirty) saveBindings();
  }, SWEEP_MS);
  timer.unref?.();
  return timer;
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

/** Test hook: wipe the on-disk state (mailbox, answered, bindings). */
export async function resetBridge(): Promise<void> {
  bindings = new Map();
  bindingsLoaded = null;
  // A queued bindings write must not re-create the directory afterwards.
  await bindingsWrite.catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
