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
  constructor(
    private service: { baseUrl: string; readKey?: string },
    private channel: { id: string; roleToken: string; role: "offerer" | "answerer" },
    private onStatus?: (text: string) => void,
  ) {}

  private url(pathname: string): string {
    return `${this.service.baseUrl.replace(/\/$/, "")}${pathname}`;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.service.readKey ? { authorization: `Bearer ${this.service.readKey}` } : {}),
    };
  }

  private async post(pathname: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(this.url(pathname), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `BobSwap ${pathname}: HTTP ${res.status}`);
    return data;
  }

  /** Poll the signal feed until the peer's offer/answer arrives. */
  private async pollSignal(after: number): Promise<{ type: string; payload: Record<string, unknown> }> {
    for (;;) {
      const res = await fetch(
        this.url(`/api/v1/sync/channels/${this.channel.id}/signal?after=${after}`),
        { headers: this.headers() },
      );
      if (!res.ok) throw new Error(`BobSwap signal poll: HTTP ${res.status}`);
      const data = (await res.json()) as {
        messages?: Array<{ seq: number; from: string; type: string; payload: Record<string, unknown> }>;
        cursor?: number;
      };
      after = data.cursor ?? after;
      const hit = (data.messages ?? []).find((m) => m.from !== this.channel.role);
      if (hit) return { type: hit.type, payload: hit.payload };
      this.onStatus?.("waiting for the peer's signal…");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async connect(pc: RTCPeerConnection): Promise<void> {
    const candidates: RTCIceCandidateInit[] = [];
    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.toJSON();
      if (candidate) {
        candidates.push(candidate);
        // Trickle: push each candidate as it arrives (small messages).
        void this.post(`/api/v1/sync/channels/${this.channel.id}/signal`, {
          type: "candidates",
          payload: { candidates: [candidate] },
        }).catch(() => {});
      }
    };
    if (this.channel.role === "offerer") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.post(`/api/v1/sync/channels/${this.channel.id}/signal`, {
        type: "offer",
        payload: { sdp: pc.localDescription!.sdp, type: "offer" },
      });
      const answer = await this.pollSignal(0);
      await pc.setRemoteDescription({ type: "answer", sdp: String(answer.payload.sdp) });
    } else {
      const offer = await this.pollSignal(0);
      await pc.setRemoteDescription({ type: "offer", sdp: String(offer.payload.sdp) });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.post(`/api/v1/sync/channels/${this.channel.id}/signal`, {
        type: "answer",
        payload: { sdp: pc.localDescription!.sdp, type: "answer" },
      });
    }
  }

  close(): void {}
}

/** The 6-word verification phrase from the DTLS fingerprints (both sides show it). */
export function verifyPhrase(pc: RTCPeerConnection): string {
  const fp = (pc.localDescription?.sdp ?? "")
    .split("\n")
    .filter((line) => line.startsWith("a=fingerprint:"))
    .map((line) => line.replace("a=fingerprint:", "").trim());
  const words = ["anchor", "basil", "cedar", "delta", "ember", "fjord", "granite", "harbor", "igloo", "jasper"];
  const seed = fp.join("|");
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out.push(words[Math.abs(h) % words.length]);
  }
  return out.join("-");
}

/** Wire the data channel + signaling into a SyncPeer. */
export async function rtcPeer(
  provider: SignalingProvider,
  engineId: string,
  opts: { iceServers?: RTCIceServer[]; onState?: (text: string) => void } = {},
): Promise<{ peer: SyncPeer; phrase: string }> {
  const iceServers = opts.iceServers && opts.iceServers.length > 0 ? opts.iceServers : STUN;
  const pc = new RTCPeerConnection({ iceServers });
  const channel = pc.createDataChannel("bob-sync", { ordered: true });
  opts.onState?.("signaling…");
  await provider.connect(pc);
  await new Promise<void>((resolve, reject) => {
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
  return { peer, phrase: verifyPhrase(pc) };
}
