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
import { SyncEngine, type SyncState } from "./engine";
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
  /** Pair a cross-device peer; resolves when the data channel is open. */
  pairManual(role: "offerer" | "joiner", onOutgoing: (blob: string) => void): Promise<{ phrase: string; accept: (blob: string) => void }>;
  pairBobSwap(service: { baseUrl: string; readKey?: string }, channel: { id: string; roleToken: string; role: "offerer" | "answerer" }): Promise<string>;
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
    async pairManual(role, onOutgoing) {
      const provider = new ManualSignaling(role);
      void provider.outgoing.then(onOutgoing).catch((err) => onOutgoing(`error: ${String(err)}`));
      const accept = (blob: string): void => provider.accept(blob);
      const { peer, phrase } = await rtcPeer(provider, engine.id);
      engine.attach(peer);
      return { phrase, accept };
    },
    async pairBobSwap(service, channel) {
      const provider: SignalingProvider = new BobSwapSignaling(service, channel);
      const { peer, phrase } = await rtcPeer(provider, engine.id);
      engine.attach(peer);
      return phrase;
    },
    unpair() {
      engine.detach();
    },
  };
  return active;
}
