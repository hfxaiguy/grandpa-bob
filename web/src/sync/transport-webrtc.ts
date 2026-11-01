/**
 * Cross-device transport: a WebRTC DataChannel, peer-to-peer.
 *
 * Signaling is the only server touch, and the two providers below both keep
 * workspace bytes off it — signaling blobs are SDP + ICE candidates only:
 *
 * - BobSwap REST mailbox (automatic; works anywhere): create a sync channel,
 *   join with the pairing code, exchange offer/answer/candidates via the
 *   signal endpoints. Server contract: /docs/agents → "Sync channels".
 * - Manual paste (no service): non-trickle ICE — wait for gathering to
 *   complete, bundle SDP + every candidate into one blob, and copy it across
 *   by any means (a Telegram message is the obvious one).
 *
 * Both providers reduce to the same small interface; the DTLS fingerprints
 * inside the SDP bind the channel — `verifyPhrase` renders a 6-word phrase
 * both sides display before any bytes move.
 */
import type { SyncEnvelope, SyncPeer } from "./engine";
import { chunkedPeer } from "./chunking";
import { pairingPhrase, verifyPhrase } from "./sas";

export { pairingPhrase, verifyPhrase } from "./sas";

/**
 * Fallback when a service supplies no ICE servers (or the manual-paste path,
 * which never contacts a service). The BobSwap create/join responses carry
 * their own `ice_servers` (STUN and, when deployed, TURN) — `toIceServers`
 * normalizes those and `rtcPeer` uses them instead, so a deployment can add
 * TURN without a client release.
 */
const STUN: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];

/**
 * Normalize a service's `ice_servers` field into RTCIceServer entries.
 * Accepts `{ urls: string | string[], username?, credential?, credentialType? }`
 * (a bare url string or list also works); invalid entries are dropped. An
 * empty result means the caller should fall back to the built-in STUN list.
 */
export function toIceServers(raw: unknown): RTCIceServer[] {
  type IceServer = RTCIceServer & { credentialType?: "password" | "oauth" };
  const servers: IceServer[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as {
      urls?: unknown;
      username?: unknown;
      credential?: unknown;
      credentialType?: unknown;
    };
    const urls = Array.isArray(record.urls) ? record.urls : [record.urls];
    const clean = urls.filter((url): url is string => typeof url === "string" && url.length > 0);
    if (clean.length === 0) continue;
    const server: IceServer = { urls: clean };
    if (typeof record.username === "string") server.username = record.username;
    if (typeof record.credential === "string") server.credential = record.credential;
    if (record.credentialType === "password" || record.credentialType === "oauth") {
      server.credentialType = record.credentialType;
    }
    servers.push(server);
  }
  return servers;
}

export interface SignalOffer {
  /** The pasted blob the OTHER side produced (offer for the joiner, answer for the offerer). */
  blob: string;
}

/** The signaling provider interface both paths implement. */
export interface SignalingProvider {
  /** Exchange SDP+ICE and resolve when the connection is up. */
  connect(pc: RTCPeerConnection): Promise<void>;
  close(): void;
}

// ── manual paste (non-trickle) ───────────────────────────────────────────

interface IceBundle {
  type: "offer" | "answer";
  sdp: string;
  /** All candidates, gathered before the blob is produced. */
  candidates: RTCIceCandidateInit[];
}

/** One entry of the BobSwap signal feed. */
interface SignalEntry {
  seq: number;
  from: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Gather ALL candidates (non-trickle): the blob is complete in one paste. */
async function gatherComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 4_000); // gathering rarely needs longer
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function encodeBundle(bundle: IceBundle): string {
  return btoa(JSON.stringify(bundle));
}

function decodeBundle(blob: string): IceBundle {
  const raw = JSON.parse(atob(blob.replace(/\s+/g, ""))) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("not a pairing blob");
  const b = raw as Partial<IceBundle>;
  if ((b.type !== "offer" && b.type !== "answer") || typeof b.sdp !== "string") {
    throw new Error("not a pairing blob (type/sdp missing)");
  }
  return { type: b.type, sdp: b.sdp, candidates: Array.isArray(b.candidates) ? b.candidates : [] };
}

/**
 * Manual paste signaling. The role is explicit (the UI decides who offers):
 * the offerer's outgoing blob resolves as soon as the local description is
 * gathered; the joiner produces its answer after accepting the offer blob.
 */
export class ManualSignaling implements SignalingProvider {
  /** The blob to hand the OTHER side (one paste per direction). */
  readonly outgoing: Promise<string>;
  private outgoingResolve: (blob: string) => void;
  private incomingResolve: (blob: string) => void;
  private incoming: Promise<string>;

  constructor(
    private role: "offerer" | "joiner",
  ) {
    let outResolve!: (blob: string) => void;
    this.outgoing = new Promise<string>((r) => (outResolve = r));
    this.outgoingResolve = outResolve;
    let inResolve!: (blob: string) => void;
    this.incoming = new Promise<string>((r) => (inResolve = r));
    this.incomingResolve = inResolve;
  }

  /** Feed the blob the other side produced (the answer for the offerer, the offer for the joiner). */
  accept(blob: string): void {
    this.incomingResolve(blob);
  }

  async connect(pc: RTCPeerConnection): Promise<void> {
    const candidates: RTCIceCandidateInit[] = [];
    pc.onicecandidate = (event) => {
      if (event.candidate) candidates.push(event.candidate.toJSON());
    };

    const gatherLocal = async (kind: "offer" | "answer"): Promise<IceBundle> => {
      const local =
        kind === "offer" ? await pc.createOffer() : await pc.createAnswer();
      await pc.setLocalDescription(local);
      await gatherComplete(pc);
      return { type: kind, sdp: pc.localDescription!.sdp, candidates };
    };

    if (this.role === "offerer") {
      const bundle = await gatherLocal("offer");
      this.outgoingResolve(encodeBundle(bundle));
      const answer = decodeBundle(await this.incoming);
      if (answer.type !== "answer") throw new Error("expected the answer blob");
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      for (const c of answer.candidates) await pc.addIceCandidate(c).catch(() => {});
    } else {
      const offer = decodeBundle(await this.incoming);
      if (offer.type !== "offer") throw new Error("expected the offer blob");
      await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      for (const c of offer.candidates) await pc.addIceCandidate(c).catch(() => {});
      const bundle = await gatherLocal("answer");
      this.outgoingResolve(encodeBundle(bundle));
    }
  }

  close(): void {}
}

// ── BobSwap REST mailbox (contract: /docs/agents → "Sync channels") ──────

export class BobSwapSignaling implements SignalingProvider {
  private stopped = false;

  constructor(
    private service: { baseUrl: string; readKey?: string },
    private channel: {
      id: string;
      roleToken: string;
      /** `joiner` is the relay's name for the answerer side. */
      role: "offerer" | "answerer" | "joiner";
    },
    private onStatus?: (text: string) => void,
  ) {}

  /** Normalize the relay's public role names onto the signal-feed sides. */
  private ownSide(): "offerer" | "answerer" {
    return this.channel.role === "offerer" ? "offerer" : "answerer";
  }

  /** The peer's feed label. Accept `joiner` as an alias for `answerer`. */
  private isOwn(entryFrom: unknown): boolean {
    if (entryFrom === this.ownSide()) return true;
    return this.ownSide() === "answerer" && entryFrom === "joiner";
  }

  private url(pathname: string): string {
    return `${this.service.baseUrl.replace(/\/$/, "")}${pathname}`;
  }

  /** The signal endpoints authenticate with the role token, not the API key. */
  private signalHeaders(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.channel.roleToken}` };
  }

  /** PUT is the contract's verb for signaling (POST is channel create/join). */
  private async signal(body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(this.url(`/api/v1/sync/channels/${this.channel.id}/signal`), {
      method: "PUT",
      headers: this.signalHeaders(),
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("the pairing session is gone — the server may have restarted or the code expired");
      }
      throw new Error(data.error ?? `BobSwap signal: HTTP ${res.status}`);
    }
    return data;
  }

  private async feed(after: number): Promise<{ entries: SignalEntry[]; cursor: number }> {
    const res = await fetch(
      this.url(`/api/v1/sync/channels/${this.channel.id}/signal?after=${after}`),
      { headers: this.signalHeaders() },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 404) {
        throw new Error("the pairing session is gone — the server may have restarted or the code expired");
      }
      throw new Error(data.error ?? `BobSwap signal poll: HTTP ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    // Both response shapes are accepted: {messages, cursor} and a bare array
    // (the contract text says "Array of peer messages").
    const entries: SignalEntry[] = Array.isArray(data)
      ? (data as SignalEntry[])
      : ((data as { messages?: SignalEntry[] }).messages ?? []);
    const cursor = Array.isArray(data)
      ? entries.reduce(
          (max, m) => (typeof m?.seq === "number" ? Math.max(max, m.seq) : max),
          after,
        )
      : ((data as { cursor?: number }).cursor ?? after);
    return { entries, cursor };
  }

  /**
   * Candidates pooled from the feed: ICE gathering starts immediately on both
   * sides, so candidates often arrive BEFORE the peer's SDP — adding them
   * prior to `setRemoteDescription` is an InvalidStateError, so they wait
   * here until the remote description is applied.
   */
  private pending: unknown[] = [];

  private async applyCandidates(pc: RTCPeerConnection, payload: unknown): Promise<void> {
    const list = (payload as { candidates?: unknown[] }).candidates;
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (c && typeof c === "object") await pc.addIceCandidate(c as RTCIceCandidateInit).catch(() => {});
    }
  }

  /** Poll the feed; collect candidates and hold them until the peer's SDP arrives. */
  private async awaitPeerSdp(
    kind: "offer" | "answer",
  ): Promise<{ sdp: string; cursor: number }> {
    let cursor = 0;
    for (;;) {
      const { entries, cursor: next } = await this.feed(cursor);
      let hit: { sdp: string } | null = null;
      for (const m of entries) {
        if (this.isOwn(m.from)) continue;
        if (m.type === "error") {
          const message = (m.payload as { message?: unknown }).message;
          throw new Error(
            typeof message === "string" && message ? message : "the peer closed the pairing session",
          );
        }
        if (m.type === kind && !hit) {
          const sdp = (m.payload as { sdp?: unknown }).sdp;
          if (typeof sdp !== "string" || sdp.length === 0) throw new Error(`peer sent an empty ${kind}`);
          hit = { sdp };
        } else if (m.type === "candidates") {
          const list = (m.payload as { candidates?: unknown[] }).candidates;
          if (Array.isArray(list)) this.pending.push(...list);
        }
      }
      cursor = next;
      if (hit) return { ...hit, cursor };
      this.onStatus?.("waiting for the peer's signal…");
      if (this.stopped) throw new Error("signaling stopped while waiting for the peer");
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  /** Apply SDP-dependent state that had to wait for the remote description. */
  private async flushPending(pc: RTCPeerConnection): Promise<void> {
    const buffered = this.pending.splice(0);
    for (const c of buffered) {
      if (c && typeof c === "object") await pc.addIceCandidate(c as RTCIceCandidateInit).catch(() => {});
    }
  }

  /**
   * Post-exchange candidate drain: SDP and ICE candidates trickle
   * independently, so the feed must be read until the connection settles —
   * missing a candidate queues the connection forever otherwise.
   */
  private async drainCandidates(pc: RTCPeerConnection, cursor: number): Promise<void> {
    for (;;) {
      const settled = ["connected", "failed", "closed"].includes(pc.connectionState);
      if (this.stopped || settled) return;
      try {
        const { entries, cursor: next } = await this.feed(cursor);
        cursor = next;
        for (const m of entries) {
          if (this.isOwn(m.from)) continue;
          if (m.type === "candidates") void this.applyCandidates(pc, m.payload);
        }
      } catch (err) {
        if (this.stopped) return;
        this.onStatus?.(`candidate drain: ${err instanceof Error ? err.message : String(err)} — retrying`);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  async connect(pc: RTCPeerConnection): Promise<void> {
    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.toJSON();
      if (candidate) {
        void this.signal({ type: "candidates", payload: { candidates: [candidate] } }).catch(() => {});
      }
    };
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") this.onStatus?.("peer connection up");
    });
    if (this.ownSide() === "offerer") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.signal({ type: "offer", payload: { sdp: pc.localDescription!.sdp, type: "offer" } });
      const remote = await this.awaitPeerSdp("answer");
      await pc.setRemoteDescription({ sdp: remote.sdp, type: "answer" });
      await this.flushPending(pc);
      void this.drainCandidates(pc, remote.cursor);
    } else {
      const remote = await this.awaitPeerSdp("offer");
      await pc.setRemoteDescription({ sdp: remote.sdp, type: "offer" });
      await this.flushPending(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.signal({ type: "answer", payload: { sdp: pc.localDescription!.sdp, type: "answer" } });
      void this.drainCandidates(pc, remote.cursor);
    }
  }

  close(): void {
    this.stopped = true;
  }
}


/**
 * Wire the data channel + signaling into a SyncPeer.
 *
 * Only the OFFER side creates the channel (it is negotiated in the offer's
 * SDP); the joiner attaches to the peer's channel via `ondatachannel` — both
 * ends calling `createDataChannel` for the same stream collides during
 * negotiation.
 */
export async function rtcPeer(
  provider: SignalingProvider,
  engineId: string,
  opts: { createChannel?: boolean; iceServers?: RTCIceServer[]; onState?: (text: string) => void } = {},
): Promise<{ peer: SyncPeer; phrase: string }> {
  // `undefined` → the public STUN fallback; an explicit empty array means
  // "no ICE servers" (loopback/self-hosted peers).
  const iceServers = opts.iceServers !== undefined ? opts.iceServers : STUN;
  const pc = new RTCPeerConnection({ iceServers });
  const awaitOpen = (channel: RTCDataChannel): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("data channel never opened")), 20_000);
      if (channel.readyState === "open") {
        clearTimeout(timer);
        resolve();
        return;
      }
      channel.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      channel.onerror = () => {
        clearTimeout(timer);
        reject(new Error("data channel failed"));
      };
    });
  opts.onState?.("signaling…");
  let channel: RTCDataChannel;
  if (opts.createChannel === false) {
    // Joiner: the channel arrives inside the offer/answer negotiation. The
    // handler must be registered before the signaling transport touches the
    // remote description.
    channel = await new Promise<RTCDataChannel>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the other side never opened a data channel")), 20_000);
      pc.ondatachannel = (event) => {
        clearTimeout(timer);
        resolve(event.channel);
      };
      void provider.connect(pc).catch(reject);
    });
  } else {
    channel = pc.createDataChannel("bob-sync", { ordered: true });
    await provider.connect(pc);
  }
  await awaitOpen(channel);
  const peer: SyncPeer = {
    id: engineId,
    send(envelope: SyncEnvelope): void {
      if (channel.readyState !== "open") return;
      channel.send(JSON.stringify(envelope));
    },
    connected: () => channel.readyState === "open" && pc.connectionState !== "closed",
    onMessage(cb) {
      channel.onmessage = (event) => {
        try {
          cb(JSON.parse(String(event.data)) as SyncEnvelope);
        } catch {
          /* skip a torn frame */
        }
      };
    },
    onClosed(cb) {
      const fire = (): void => cb();
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") fire();
      });
      channel.addEventListener("close", fire);
    },
    close(): void {
      try {
        channel.close();
        pc.close();
      } catch {
        /* already closed */
      }
    },
  };
  // Every RTC data channel is frame-limited; chunk transparently so file
  // contents (base64 in `ops`/`file-req` replies) never exceed the wire limit.
  return { peer: chunkedPeer(peer), phrase: verifyPhrase(pc) };
}
