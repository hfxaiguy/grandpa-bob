/**
 * Same-origin transport: BroadcastChannel between tabs of this browser.
 *
 * The peers are already mutually authenticated by the origin — no pairing,
 * no signaling, no keys. Every message is structured-cloned (objects pass
 * whole), so the envelopes go over as-is. Channels are scoped per workspace
 * (`bob-sync:<storageMode>:<profile>`): tabs on the same workspace converge
 * with nothing to set up, while different profiles — even on one machine —
 * are different workspaces and pair through the WebRTC dialog.
 */
import type { SyncEngine, SyncEnvelope, SyncPeer } from "./engine";

export class BroadcastTransport implements SyncPeer {
  readonly id: string;
  private channel: BroadcastChannel;
  private handler: ((envelope: SyncEnvelope) => void) | null = null;
  private closedCbs: Array<() => void> = [];
  private closed = false;

  constructor(channelName: string, id: string) {
    this.id = id;
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (event) => {
      const envelope = event.data as SyncEnvelope | null;
      if (!envelope || envelope.from === this.id) return;
      this.handler?.(envelope);
    };
    window.addEventListener("pagehide", () => this.close(), { once: true });
  }

  send(envelope: SyncEnvelope): void {
    if (this.closed) return;
    try {
      this.channel.postMessage(envelope);
    } catch (err) {
      console.warn("[sync] broadcast send failed:", err);
    }
  }

  connected(): boolean {
    return !this.closed;
  }

  onMessage(cb: (envelope: SyncEnvelope) => void): void {
    this.handler = cb;
  }

  onClosed(cb: () => void): void {
    this.closedCbs.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    for (const cb of this.closedCbs) cb();
  }
}

/** The engine factory for a same-origin peer. */
export function broadcastPeer(channelName: string, engine: SyncEngine): SyncPeer {
  return new BroadcastTransport(channelName, engine.id);
}
