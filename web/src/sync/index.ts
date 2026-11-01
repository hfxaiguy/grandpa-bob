/**
 * Sync wiring: attach the engine to the platform and start the transports.
 *
 * Mutations are observed at the one seam every file tool commits through —
 * `platform.git.autoCommit` (the browser's isomorphic-git path wraps it;
 * the desktop path goes over the bridge). The wrapper journals the paths and
 * pushes ops to the connected peer.
 *
 * Transports:
 *   - BroadcastChannel (same origin): always on — nothing to pair.
 *   - WebRTC (cross-device): paired explicitly — BobSwap REST mailbox or
 *     manual paste; both reduce to `SignalingProvider`.
 *
 * Excluded from sync by design: `.git/`, `logs/`, `.gpb-*`, `assets/inbox/`
 * (see hashmap.ts) — git history and run logs stay per-replica.
 */
import { SyncEngine, type SyncPeer, type SyncState } from "./engine";
import type { Platform } from "../platform/types";
import { broadcastPeer } from "./transport-broadcast";
import {
  ManualSignaling,
  BobSwapSignaling,
  rtcPeer,
  type SignalingProvider,
} from "./transport-webrtc";

export interface SyncHandle {
  engine: SyncEngine;
  state(): SyncState;
  onState(cb: (state: SyncState) => void): () => void;
  /** Attach another peer (desktop/server) to the same engine. */
  attach(peer: SyncPeer): void;
  detach(peerId?: string): void;
  /**
   * Start a manual (no-service) pairing. `onOutgoing` receives the blob to
   * hand the other side; `accept` feeds the blob the other side produced;
   * `done` resolves with the verification phrase once the channel opens.
   */
  startManualPairing(
    role: "offerer" | "joiner",
    onOutgoing: (blob: string) => void,
  ): { accept: (blob: string) => void; done: Promise<string> };
  /** Pair over the BobSwap REST mailbox (the service must support sync channels). */
  pairBobSwap(channel: {
    baseUrl: string;
    readKey?: string;
    id: string;
    roleToken: string;
    /** `joiner` is the relay's public name for the answerer side. */
    role: "offerer" | "answerer" | "joiner";
    /** ICE servers from the channel create/join response (STUN/TURN). */
    iceServers?: RTCIceServer[];
  }): Promise<string>;
  unpair(): void;
}

let active: SyncHandle | null = null;

export function activeSync(): SyncHandle | null {
  return active;
}

export async function startSync(platform: Platform, opts: { id: string; channelName: string }): Promise<SyncHandle> {
  if (active) active.unpair();
  const engine = new SyncEngine(platform, opts.id);

  // Same-origin peer: always attached.
  const bc = broadcastPeer(opts.channelName, engine);
  engine.attach(bc);

  // Mutation seam: journal + push on every file-tool commit.
  const git = platform.git;
  const original = git.autoCommit?.bind(git);
  if (original) {
    git.autoCommit = async (paths: string[], message: string) => {
      const result = await original(paths, message);
      if (result !== "failed" && result !== "no-changes") {
        void engine.noteMutation([...paths]);
      }
      return result;
    };
  }

  // The cross-device peer is the only one `unpair` may close: same-origin
  // BroadcastChannel and a paired desktop/server must keep running.
  let crossPeer: SyncPeer | null = null;
  const attachCross = (peer: SyncPeer): void => {
    crossPeer?.close();
    crossPeer = peer;
    engine.attach(peer);
  };

  const stateListeners = new Set<(state: SyncState) => void>();
  let state: SyncState = { status: "idle", detail: "", conflicts: [], lastSyncAt: null };
  engine.onState((next) => {
    state = next;
    for (const cb of stateListeners) cb(next);
  });

  active = {
    engine,
    state: () => state,
    onState(cb) {
      stateListeners.add(cb);
      cb(state);
      return () => stateListeners.delete(cb);
    },
    attach(peer) {
      engine.attach(peer);
    },
    detach(peerId) {
      engine.detach(peerId);
    },
    startManualPairing(role, onOutgoing) {
      const provider = new ManualSignaling(role);
      void provider.outgoing.then(onOutgoing).catch((err) => onOutgoing(`error: ${String(err)}`));
      const done = rtcPeer(provider, engine.id, { createChannel: role === "offerer" }).then(({ peer, phrase }) => {
        attachCross(peer);
        return phrase;
      });
      return { accept: (blob: string) => provider.accept(blob), done };
    },
    async pairBobSwap(channel) {
      const provider: SignalingProvider = new BobSwapSignaling(
        { baseUrl: channel.baseUrl, readKey: channel.readKey },
        { id: channel.id, roleToken: channel.roleToken, role: channel.role },
      );
      const { peer, phrase } = await rtcPeer(provider, engine.id, {
        iceServers: channel.iceServers,
        createChannel: channel.role === "offerer",
      });
      attachCross(peer);
      return phrase;
    },
    unpair() {
      crossPeer?.close();
      crossPeer = null;
    },
  };
  return active;
}
