/**
 * BobSwap relay signaling for the desktop peer.
 *
 * The local mailbox is loopback-only, so a phone on another network cannot
 * reach it to exchange SDP/ICE. BobSwap's sync-channel contract is the same
 * two-party mailbox the browser already uses; only signaling travels through
 * it. Workspace bytes, ops and voice clips stay on the DTLS datachannel.
 *
 * This module is the Node side of that channel: create it with the account's
 * read key, offer the datachannel, and poll the peer's signal feed.
 */
import { RTCPeerConnection } from "werift";
import type { SyncEnvelope, SyncPeer } from "../../web/src/sync/engine.js";
import { chunkedPeer } from "../../web/src/sync/chunking.js";
import { pairingPhrase } from "../../web/src/sync/sas.js";
import { expandLocalCandidate, expandLocalSdp, localMdnsHosts } from "./mdns.js";

export interface SyncRelayOptions {
  /** BobSwap origin, e.g. https://bobswap.hfxaiguy.com */
  baseUrl: string;
  /** Read-scope BobSwap key; channel creation is authenticated. */
  key?: string;
}

export interface RelayChannel {
  baseUrl: string;
  profile: string;
  id: string;
  code: string;
  roleToken: string;
  role: "offerer" | "answerer" | "joiner";
  iceServers: unknown[];
  /** ISO-8601 expiry returned by create/join/renew (when the service reports it). */
  expiresAt?: string;
}

interface RelaySignal {
  seq: number;
  from: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface OpenedPeer {
  peer: SyncPeer;
  phrase: string;
  close(): void;
}

/** A reconnect offer on an existing channel, tagged with the waiting tab's profile. */
export interface ReconnectedPeer extends OpenedPeer {
  profile?: string;
}

interface OfferOptions {
  /** Reconnect generation; fresh offers/answers/candidates carry it. */
  nonce?: string;
  /** Start polling after this signal sequence (old pairing messages are ignored). */
  after?: number;
}

export type PeerEvent = (type: string, data?: Record<string, unknown>) => void;

/** The transport a peer session speaks over: local mailbox or BobSwap relay. */
export interface PeerTransport {
  readonly kind: "mailbox" | "relay";
  readonly id: string;
  readonly profile: string;
  open(iceServers: unknown[], onEvent?: PeerEvent): Promise<OpenedPeer>;
  /** Leave an error where the other side's signal wait will see it. */
  signalError(message: string): void;
  close(): void;
}

const REQUEST_TIMEOUT_MS = 20_000;
const POLL_MS = 1_500;
const OPEN_TIMEOUT_MS = 60_000;
/** Renew well inside the relay's default 30-minute channel lifetime. */
const RENEW_EVERY_MS = 10 * 60_000;
/** After a transient renewal failure, try again well before the TTL runs out. */
const RENEW_RETRY_MS = 2 * 60_000;

/**
 * A relay failure that ends the pairing: the channel is gone (expired, purged
 * or deleted) or the role token is no longer accepted. Everything else —
 * network blips, timeouts, `429` rate limits, `5xx` — is transient, and
 * tearing the session down for one of those is what turns a short outage into
 * "the pairing session is gone" half an hour later.
 */
export function isTerminalRelayError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return status === 401 || status === 403 || status === 404 || status === 410;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /pairing (?:session|channel) is gone|channel is gone or expired|invalid role token/i.test(
    message,
  );
}

function relayBase(raw: string): string {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("relay URL is required");
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error(`invalid relay URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("relay URL must be http(s)");
  }
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""));
}

async function relayFetch(
  channel: Pick<RelayChannel, "baseUrl" | "roleToken">,
  pathname: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${channel.baseUrl}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${channel.roleToken}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) {
      const fail = (message: string): never => {
        const error = new Error(message) as Error & { status?: number };
        error.status = res.status;
        throw error;
      };
      if (res.status === 404 || res.status === 410) {
        fail("the relay pairing channel is gone or expired — run `npm run pair -- --relay` again");
      }
      if (res.status === 429) {
        const retry = res.headers.get("retry-after");
        fail(`the relay is rate limiting signaling${retry ? ` — retry in ${retry}s` : ""}`);
      }
      fail(data.error || `relay signaling failed: HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`the relay did not answer ${channel.baseUrl} within ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Create an offerer channel on the relay; the returned code is single-use. */
export async function createRelayChannel(
  relay: SyncRelayOptions,
  profile: string,
): Promise<RelayChannel> {
  const baseUrl = relayBase(relay.baseUrl);
  const key = String(relay.key ?? "").trim();
  if (!key) {
    throw new Error(
      "the BobSwap relay needs a read-scope key to create a pairing code — " +
        "set BOB_SYNC_RELAY_KEY (or pass --relay-key)",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/sync/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: "{}",
    });
  } catch (err) {
    throw new Error(
      `cannot reach the BobSwap relay at ${baseUrl} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    channel_id?: string;
    pairing_code?: string;
    role_token?: string;
    role?: string;
    ice_servers?: unknown;
    expires_at?: string;
    error?: string;
  };
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "the relay rejected the read key — check BOB_SYNC_RELAY_KEY (read scope can create sync channels)",
      );
    }
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      throw new Error(`the relay is rate limiting code creation${retry ? ` — retry in ${retry}s` : ""}`);
    }
    throw new Error(data.error || `relay channel creation failed: HTTP ${res.status}`);
  }
  if (!data.channel_id || !data.pairing_code || !data.role_token) {
    throw new Error("the relay answered without a channel, pairing code or role token");
  }
  if (data.role && data.role !== "offerer") {
    throw new Error(`the relay created a ${data.role} channel; the desktop must be the offerer`);
  }
  return {
    baseUrl,
    profile,
    id: data.channel_id,
    code: data.pairing_code,
    roleToken: data.role_token,
    role: "offerer",
    iceServers: Array.isArray(data.ice_servers) ? data.ice_servers : [],
    expiresAt: typeof data.expires_at === "string" ? data.expires_at : undefined,
  };
}

/**
 * Extend a live relay channel. BobSwap's renewal route is optional: an
 * older deployment answers 404, which callers treat as "not supported" and
 * fall back to the fixed 30-minute lifetime.
 */
export async function renewRelayChannel(channel: RelayChannel): Promise<string | undefined> {
  const data = await relayFetch(
    channel,
    `/api/v1/sync/channels/${encodeURIComponent(channel.id)}/renew`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return typeof data.expires_at === "string" ? data.expires_at : undefined;
}

async function relaySignal(
  channel: RelayChannel,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await relayFetch(channel, `/api/v1/sync/channels/${encodeURIComponent(channel.id)}/signal`, {
    method: "PUT",
    body: JSON.stringify({ type, payload }),
  });
}

async function relayFeed(
  channel: RelayChannel,
  after: number,
): Promise<{ entries: RelaySignal[]; cursor: number }> {
  const data = await relayFetch(
    channel,
    `/api/v1/sync/channels/${encodeURIComponent(channel.id)}/signal?after=${after}`,
  );
  const raw = Array.isArray(data) ? data : Array.isArray(data.messages) ? data.messages : [];
  const entries = raw.filter(
    (entry): entry is RelaySignal =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as RelaySignal).seq === "number" &&
      typeof (entry as RelaySignal).type === "string",
  );
  const cursor = Array.isArray(data)
    ? entries.reduce((max, entry) => Math.max(max, entry.seq), after)
    : typeof data.cursor === "number"
      ? data.cursor
      : after;
  return { entries, cursor };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Offer the datachannel from the desktop, exchanging only SDP/ICE through the
 * relay. Resolves once the browser's datachannel is open.
 */
export function offerRelayChannel(
  channel: RelayChannel,
  iceServers: unknown[] = [],
  onEvent?: PeerEvent,
  options: OfferOptions = {},
): Promise<OpenedPeer> {
  const nonce = options.nonce;
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({
      iceServers: (channel.iceServers.length ? channel.iceServers : iceServers) as never,
    });
    const dc = pc.createDataChannel("bob-sync", { ordered: true });
    // The datachannel can carry the browser's first frame (`hello`) as soon
    // as it opens, before `finish` below builds the SyncPeer. Install the
    // message handler now and hold text frames until `onMessage` attaches;
    // otherwise werift drops them at the transport layer.
    let frameHandler: ((text: string) => void) | null = null;
    const earlyFrames: string[] = [];
    dc.onmessage = (event: unknown) => {
      const raw = (event as { data?: unknown })?.data ?? event;
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : String(raw);
      if (frameHandler) frameHandler(text);
      else if (earlyFrames.length < 200) earlyFrames.push(text);
    };
    const mdnsHosts = localMdnsHosts();
    const pending: unknown[] = [];
    let remoteSet = false;
    let opened = false;
    let settled = false;
    let closed = false;
    let cursor = options.after ?? 0;
    let phrase = "";
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let writes: Promise<void> = Promise.resolve();
    const openTimer = setTimeout(
      () => fail(new Error("timed out waiting for the browser's answer")),
      OPEN_TIMEOUT_MS,
    );

    const send = (type: string, payload: Record<string, unknown>): Promise<void> => {
      if (closed) return Promise.resolve();
      writes = writes.then(() => relaySignal(channel, type, payload)).catch((err) => {
        if (!closed) fail(err instanceof Error ? err : new Error(String(err)));
      });
      return writes;
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      closed = true;
      onEvent?.("offer-failed", { error: err.message });
      clearTimeout(openTimer);
      if (pollTimer) clearTimeout(pollTimer);
      if (candidateTimer) clearTimeout(candidateTimer);
      try {
        dc.close();
      } catch {
        /* already closed */
      }
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      reject(err);
    };

    const finish = (): void => {
      if (settled || opened) return;
      opened = true;
      settled = true;
      clearTimeout(openTimer);
      if (pollTimer) clearTimeout(pollTimer);
      onEvent?.("channel-open", {});
      phrase = pairingPhrase(
        pc.localDescription?.sdp ?? "",
        pc.remoteDescription?.sdp ?? "",
      );
      const base: SyncPeer = {
        id: `server:${channel.profile}`,
        send(envelope: SyncEnvelope): void {
          if (dc.readyState !== "open") return;
          dc.send(JSON.stringify(envelope));
        },
        connected: () => dc.readyState === "open" && pc.connectionState !== "closed",
        onMessage(cb) {
          frameHandler = (text) => {
            try {
              cb(JSON.parse(text) as SyncEnvelope);
            } catch {
              /* torn frame */
            }
          };
          for (const text of earlyFrames.splice(0)) frameHandler(text);
        },
        onClosed(cb) {
          const fire = (): void => cb();
          dc.addEventListener("close", fire);
          pc.addEventListener("connectionstatechange", () => {
            if (["failed", "closed", "disconnected"].includes(pc.connectionState)) fire();
          });
        },
        close() {
          closed = true;
          if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
          }
          if (candidateTimer) {
            clearTimeout(candidateTimer);
            candidateTimer = null;
          }
          try {
            dc.close();
          } catch {
            /* already closed */
          }
          try {
            pc.close();
          } catch {
            /* already closed */
          }
        },
      };
      resolve({ peer: chunkedPeer(base), phrase, close: () => base.close() });
    };

    const handle = async (entry: RelaySignal): Promise<void> => {
      if (entry.from === "offerer") return;
      if (entry.type === "error" || entry.type === "bye") {
        const message = entry.payload.message ?? entry.payload.error;
        throw new Error(
          typeof message === "string" && message ? message : "the browser closed the pairing channel",
        );
      }
      if (nonce && entry.payload.nonce !== nonce) return;
      if (entry.type === "candidates") {
        const list = entry.payload.candidates;
        if (!Array.isArray(list)) return;
        for (const candidate of list) {
          for (const expanded of expandLocalCandidate(candidate, mdnsHosts)) {
            if (remoteSet) await pc.addIceCandidate(expanded as never).catch(() => undefined);
            else pending.push(expanded);
          }
        }
        return;
      }
      if (entry.type === "answer" && !remoteSet) {
        const sdp = entry.payload.sdp;
        if (typeof sdp !== "string" || !sdp) throw new Error("answer without SDP");
        await pc.setRemoteDescription({ type: "answer", sdp: expandLocalSdp(sdp, mdnsHosts) });
        remoteSet = true;
        onEvent?.("answer-received", { bytes: sdp.length });
        for (const candidate of pending.splice(0)) {
          await pc.addIceCandidate(candidate as never).catch(() => undefined);
        }
      }
    };

    const poll = async (): Promise<void> => {
      if (closed) return;
      try {
        const feed = await relayFeed(channel, cursor);
        cursor = feed.cursor;
        for (const entry of feed.entries) {
          if (closed) return;
          await handle(entry);
        }
      } catch (err) {
        if (closed) return;
        // A dead channel is final; a transient relay/network error is not.
        // Keep polling until the open deadline instead of failing the offer,
        // so one rate-limit burst does not abort the handshake.
        if (isTerminalRelayError(err)) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        onEvent?.("offer-retry", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!closed) pollTimer = setTimeout(() => void poll(), POLL_MS);
    };

    let candidateBuf: unknown[] = [];
    let candidateTimer: ReturnType<typeof setTimeout> | null = null;
    pc.onicecandidate = (event: any) => {
      const candidate = event?.candidate;
      if (!candidate || closed) return;
      const json = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
      candidateBuf.push(json);
      // One signal per burst keeps the relay's per-token write limit happy.
      if (candidateTimer) return;
      candidateTimer = setTimeout(() => {
        candidateTimer = null;
        const list = candidateBuf.splice(0);
        if (list.length) {
          void send("candidates", { candidates: list, ...(nonce ? { nonce } : {}) });
        }
      }, 250);
    };
    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(pc.connectionState) && !opened) {
        fail(new Error(`connection ${pc.connectionState}`));
      }
    });
    dc.addEventListener("open", finish);

    void (async () => {
      try {
        onEvent?.("offer-creating", {});
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await send("offer", {
          type: "offer",
          sdp: pc.localDescription?.sdp ?? "",
          ...(nonce ? { nonce } : {}),
        });
        onEvent?.("offer-sent", { bytes: pc.localDescription?.sdp?.length ?? 0 });
        void poll();
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

/** BobSwap-backed transport used by `PeerSession`. */
export class RelayTransport implements PeerTransport {
  readonly kind = "relay" as const;
  readonly id: string;
  readonly profile: string;
  private opened: OpenedPeer | null = null;
  private closed = false;
  private onEvent?: PeerEvent;
  /** Signal sequence already read by the reconnect watcher. */
  private cursor = 0;
  private reconnectWait: Promise<ReconnectedPeer> | null = null;
  private handled = new Set<string>();
  /** Renewal cadence: well inside the relay's 30-minute default lifetime. */
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewUnsupported = false;

  constructor(private readonly channel: RelayChannel) {
    this.id = channel.id;
    this.profile = channel.profile;
    this.scheduleRenewal();
  }

  /** Ask the relay to extend the channel; the service may not support it yet. */
  private scheduleRenewal(delayMs = RENEW_EVERY_MS): void {
    if (this.closed || this.renewUnsupported || this.renewTimer) return;
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      void this.renewNow();
    }, delayMs);
    this.renewTimer.unref?.();
  }

  private async renewNow(): Promise<void> {
    if (this.closed || this.renewUnsupported) return;
    let renewed = true;
    try {
      const expiresAt = await renewRelayChannel(this.channel);
      if (expiresAt) this.channel.expiresAt = expiresAt;
      this.onEvent?.("renewed", { expiresAt: expiresAt ?? null });
    } catch (err) {
      if (isTerminalRelayError(err)) {
        // The channel is gone or the token was rejected: renewal cannot help.
        this.renewUnsupported = true;
        this.onEvent?.("renew-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      // Transient (network/429/5xx): retry soon, before the TTL runs out.
      renewed = false;
    }
    this.scheduleRenewal(renewed ? RENEW_EVERY_MS : RENEW_RETRY_MS);
  }

  open(iceServers: unknown[], onEvent?: PeerEvent): Promise<OpenedPeer> {
    this.onEvent = onEvent;
    return offerRelayChannel(this.channel, iceServers, onEvent).then((opened) => {
      this.opened = opened;
      return opened;
    });
  }

  /**
   * Wait for the browser to ask for a reconnect on the same signaling channel.
   * The browser sends `{ reconnect: nonce, profile }`; we answer with a fresh
   * offer tagged by that nonce.
   */
  waitForReconnect(): Promise<ReconnectedPeer> {
    if (this.reconnectWait) return this.reconnectWait;
    const promise = this.watchReconnect().finally(() => {
      if (this.reconnectWait === promise) this.reconnectWait = null;
    });
    this.reconnectWait = promise;
    return promise;
  }

  private async watchReconnect(): Promise<ReconnectedPeer> {
    let failures = 0;
    for (;;) {
      if (this.closed) throw new Error("the relay transport is closed");
      let feed: { entries: RelaySignal[]; cursor: number };
      try {
        feed = await relayFeed(this.channel, this.cursor);
      } catch (err) {
        if (this.closed) throw new Error("the relay transport is closed");
        // Only a dead channel/token ends the pairing. A rate limit, a timeout
        // or a dropped connection must not: the session has to stay alive so
        // its renewal keeps the channel open until the tab comes back.
        if (isTerminalRelayError(err)) throw err;
        failures += 1;
        this.onEvent?.("reconnect-retry", {
          attempt: failures,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(Math.min(POLL_MS * 2 ** Math.min(failures, 4), 30_000));
        continue;
      }
      failures = 0;
      this.cursor = feed.cursor;
      for (const entry of feed.entries) {
        if (entry.from === "offerer") continue;
        const nonce = entry.payload.reconnect;
        if (
          entry.type !== "candidates" ||
          typeof nonce !== "string" ||
          !nonce ||
          this.handled.has(nonce)
        ) {
          continue;
        }
        this.handled.add(nonce);
        const profile =
          typeof entry.payload.profile === "string" ? entry.payload.profile : undefined;
        let opened: OpenedPeer;
        try {
          opened = await offerRelayChannel(this.channel, [], this.onEvent, {
            nonce,
            after: this.cursor,
          });
        } catch (err) {
          if (this.closed) throw new Error("the relay transport is closed");
          if (isTerminalRelayError(err)) throw err;
          // The browser retries with a fresh nonce; a failed attempt (ICE,
          // timeout, a peer `bye`) leaves the pairing resumable.
          this.onEvent?.("reconnect-failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        this.opened = opened;
        return { ...opened, profile };
      }
      await sleep(POLL_MS);
    }
  }

  signalError(message: string): void {
    // `bye` is one of the contract's allowed signal types; the browser maps it
    // to the same failure as the local mailbox's `error` entry.
    void relaySignal(this.channel, "bye", { message }).catch(() => undefined);
  }

  close(): void {
    this.closed = true;
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
      this.renewTimer = null;
    }
    this.opened?.close();
    this.opened = null;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
