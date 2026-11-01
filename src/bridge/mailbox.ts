/**
 * The local pairing mailbox — the BobSwap sync-channel contract, in memory.
 *
 * A desktop/server creates a channel with a single-use code; the browser
 * joins with the code and receives the `offerer` role token (it creates the
 * datachannel). The server keeps the `answerer` token and subscribes to the
 * channel's signal feed directly. SDP/ICE only — workspace bytes never touch
 * this surface.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type SignalSide = "offerer" | "answerer";

export interface SignalEntry {
  seq: number;
  from: SignalSide;
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface MailboxChannel {
  id: string;
  profile: string;
  /** sha256 of the single-use pairing code; undefined for reconnect channels. */
  codeHash?: string;
  codeExpiresAt?: number;
  used: boolean;
  failedJoins: number;
  createdAt: number;
  lastActivity: number;
  tokens: Record<SignalSide, string>;
  signals: SignalEntry[];
  nextSeq: number;
  listeners: Set<(entry: SignalEntry) => void>;
  onJoined?: (profile: string) => void;
  closed: boolean;
}

export interface CreatedChannel {
  channel: MailboxChannel;
  /** Only returned to the operator/creator; never logged. */
  code?: string;
  clientToken: string;
  serverToken: string;
}

const CODE_TTL_MS = 10 * 60_000;
const CHANNEL_TTL_MS = 30 * 60_000;
const MAX_SIGNALS = 500;
const MAX_FAILED_JOINS = 10;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export class Mailbox {
  private channels = new Map<string, MailboxChannel>();
  private sweep: ReturnType<typeof setInterval>;

  constructor() {
    this.sweep = setInterval(() => this.prune(), 60_000);
    this.sweep.unref?.();
  }

  /** Create a channel whose code the operator hands to the browser. */
  createPairing(profile: string): CreatedChannel {
    const channel = this.create(profile);
    const code = String(randomBytes(4).readUInt32BE(0) % 100_000_000).padStart(8, "0");
    // Display as ABCD-1234 for readability; the join normalizes the dash.
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
    channel.codeHash = hash(code);
    channel.codeExpiresAt = Date.now() + CODE_TTL_MS;
    return { channel, code: shown, clientToken: channel.tokens.offerer, serverToken: channel.tokens.answerer };
  }

  /** Create a channel for an already-paired client (no code). */
  createReconnect(profile: string): CreatedChannel {
    const channel = this.create(profile);
    return { channel, clientToken: channel.tokens.offerer, serverToken: channel.tokens.answerer };
  }

  private create(profile: string): MailboxChannel {
    const channel: MailboxChannel = {
      id: `sc_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      profile,
      used: false,
      failedJoins: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      tokens: { offerer: randomBytes(24).toString("base64url"), answerer: randomBytes(24).toString("base64url") },
      signals: [],
      nextSeq: 1,
      listeners: new Set(),
      closed: false,
    };
    this.channels.set(channel.id, channel);
    return channel;
  }

  get(id: string): MailboxChannel | null {
    return this.channels.get(id) ?? null;
  }

  /** Spend the code and return the offerer (browser) token. */
  join(id: string, code: string, profile: string): { channel: MailboxChannel; roleToken: string } {
    const channel = this.get(id);
    if (!channel || channel.closed) throw new Error("unknown or closed channel");
    if (channel.used) throw new Error("pairing code already used");
    if (!channel.codeHash || !channel.codeExpiresAt) throw new Error("channel is not joinable");
    if (Date.now() > channel.codeExpiresAt) throw new Error("pairing code expired");
    const normalized = String(code).replace(/[^0-9A-Fa-f]/g, "");
    if (hash(normalized) !== channel.codeHash) {
      channel.failedJoins++;
      if (channel.failedJoins >= MAX_FAILED_JOINS) this.remove(channel.id);
      throw new Error("pairing code does not match");
    }
    if (profile && channel.profile && profile !== channel.profile) {
      throw new Error(`channel belongs to profile ${channel.profile}`);
    }
    channel.used = true;
    channel.profile = profile || channel.profile;
    channel.lastActivity = Date.now();
    channel.onJoined?.(channel.profile);
    return { channel, roleToken: channel.tokens.offerer };
  }

  /** Bearer role token → which side of the channel it belongs to. */
  sideFor(channel: MailboxChannel, token: string): SignalSide | null {
    if (token === channel.tokens.offerer) return "offerer";
    if (token === channel.tokens.answerer) return "answerer";
    return null;
  }

  append(channel: MailboxChannel, from: SignalSide, type: string, payload: Record<string, unknown>): SignalEntry {
    const entry: SignalEntry = {
      seq: channel.nextSeq++,
      from,
      type,
      payload,
      at: new Date().toISOString(),
    };
    channel.signals.push(entry);
    if (channel.signals.length > MAX_SIGNALS) channel.signals.splice(0, channel.signals.length - MAX_SIGNALS);
    channel.lastActivity = Date.now();
    for (const listener of channel.listeners) {
      try {
        listener(entry);
      } catch {
        /* a dead session is pruned by close() */
      }
    }
    return entry;
  }

  feed(channel: MailboxChannel, after: number): SignalEntry[] {
    return channel.signals.filter((entry) => entry.seq > after);
  }

  close(channel: MailboxChannel): void {
    channel.closed = true;
    this.channels.delete(channel.id);
  }

  closeAll(): void {
    for (const channel of this.channels.values()) channel.closed = true;
    this.channels.clear();
    clearInterval(this.sweep);
  }

  private remove(id: string): void {
    const channel = this.channels.get(id);
    if (channel) channel.closed = true;
    this.channels.delete(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const channel of this.channels.values()) {
      const ttl = channel.used ? CHANNEL_TTL_MS : CODE_TTL_MS;
      if (now - channel.lastActivity > ttl) this.remove(channel.id);
    }
  }
}

/** Constant-time-ish comparison for equal-length hex strings. */
export function sameSecret(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const sha256 = hash;
