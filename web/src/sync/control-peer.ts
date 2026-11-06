/**
 * Control-plane multiplexer: a SyncPeer whose stream also carries application
 * control frames (`kind: "control"`). The engine sees only its envelopes; the
 * link layer handles hello/auth/capabilities/ops without replacing the
 * engine's message handler.
 */
import type { SyncEnvelope, SyncPeer } from "./engine";

export type ControlHandler = (
  control: Record<string, unknown>,
  envelope: SyncEnvelope,
) => void;

export function controlPeer(inner: SyncPeer, onControl: ControlHandler): SyncPeer {
  let engineHandler: ((envelope: SyncEnvelope) => void) | null = null;
  // A transport can have more than one control consumer: the handshake/ops
  // layer and the ProfileLink multiplexer both need catalog/consent frames.
  const controlHandlers = new Set<ControlHandler>();
  controlHandlers.add(onControl);
  // The handshake and the engine attach happen in separate ticks; a hashmap
  // that arrives between `ready` and `engine.attach()` must not be dropped.
  const buffered: SyncEnvelope[] = [];
  inner.onMessage((envelope) => {
    if (envelope.kind === "control") {
      for (const handler of controlHandlers) handler(envelope.control ?? {}, envelope);
      return;
    }
    if (engineHandler) engineHandler(envelope);
    else if (buffered.length < 200) buffered.push(envelope);
  });
  return {
    id: inner.id,
    send: (envelope) => inner.send(envelope),
    connected: () => inner.connected(),
    onMessage(cb) {
      engineHandler = cb;
      for (const envelope of buffered.splice(0)) cb(envelope);
    },
    onControl(cb) {
      controlHandlers.add(cb);
      return () => controlHandlers.delete(cb);
    },
    onClosed: (cb) => inner.onClosed(cb),
    close: () => inner.close(),
  };
}

export function controlEnvelope(
  from: string,
  control: Record<string, unknown>,
): SyncEnvelope {
  return { v: 1, kind: "control", from, control };
}
