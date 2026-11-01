/**
 * Frame chunking for byte-limited transports (WebRTC SCTP, ~256 KiB max
 * message in Chromium; werift's own limit is lower). Wraps a `SyncPeer` and
 * transparently splits large JSON envelopes into ordered chunks, reassembling
 * them on the other side before the engine sees them.
 *
 * Chunking is transport-level: the engine never knows a message was split.
 * Ordered delivery is assumed (the data channel is created with
 * `{ordered:true}`); a gap drops the transfer and the next reconcile retries.
 */
import type { SyncEnvelope, SyncPeer } from "./engine";

/** Safe under Chromium's 256 KiB SCTP limit (base64 + JSON overhead included). */
export const MAX_FRAME_CHARS = 48 * 1024;

interface Reassembly {
  parts: string[];
  next: number;
}

export function chunkedPeer(inner: SyncPeer): SyncPeer {
  let handler: ((envelope: SyncEnvelope) => void) | null = null;
  const transfers = new Map<string, Reassembly>();

  inner.onMessage((envelope) => {
    if (envelope.kind !== "chunk") {
      handler?.(envelope);
      return;
    }
    const transfer = envelope.transfer;
    const seq = envelope.seq;
    if (!transfer || seq === undefined || typeof envelope.data !== "string") return;
    let entry = transfers.get(transfer);
    if (!entry) {
      entry = { parts: [], next: 0 };
      transfers.set(transfer, entry);
    }
    if (seq !== entry.next) {
      transfers.delete(transfer);
      return;
    }
    entry.parts.push(envelope.data);
    entry.next++;
    if (!envelope.last) return;
    transfers.delete(transfer);
    try {
      handler?.(JSON.parse(entry.parts.join("")) as SyncEnvelope);
    } catch {
      /* torn transfer: the next reconcile re-sends */
    }
  });

  return {
    id: inner.id,
    send(envelope: SyncEnvelope): void {
      const text = JSON.stringify(envelope);
      if (text.length <= MAX_FRAME_CHARS) {
        inner.send(envelope);
        return;
      }
      const transfer = crypto.randomUUID();
      const count = Math.ceil(text.length / MAX_FRAME_CHARS);
      for (let i = 0; i < count; i++) {
        inner.send({
          v: 1,
          kind: "chunk",
          from: inner.id,
          transfer,
          seq: i,
          last: i === count - 1,
          data: text.slice(i * MAX_FRAME_CHARS, (i + 1) * MAX_FRAME_CHARS),
        });
      }
    },
    connected: () => inner.connected(),
    onMessage(cb) {
      handler = cb;
    },
    onClosed: (cb) => inner.onClosed(cb),
    close: () => inner.close(),
  };
}
