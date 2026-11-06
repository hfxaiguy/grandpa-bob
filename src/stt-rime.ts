import WebSocket from "ws";

/**
 * Rime STT over its streaming WebSocket (`wss://stt.api.rime.ai/ws`).
 *
 * Rime documents this endpoint for backends only: the API key must ride the
 * `Authorization` header of the upgrade request, and a browser's `WebSocket`
 * cannot set headers. So this adapter always runs on the Node channel (the
 * tab sends the key per request over the authenticated peer channel) — see
 * `stt-run` in src/bridge/peer.ts.
 *
 * Protocol: one session per utterance. Send `start`, wait for `started`,
 * stream headerless 16 kHz mono PCM16 as base64 `audio` messages, then `end`;
 * the final `done.text` is the transcript.
 */
export const RIME_STT_URL = "wss://stt.api.rime.ai/ws";

/** Rime's documented ceiling for one utterance (decoded audio). */
export const RIME_MAX_AUDIO_BYTES = 16 * 1024 * 1024;

export interface RimeOptions {
  apiKey: string;
  /** "en" or "es" — Rime does not detect the language. */
  language?: string;
  timeoutMs?: number;
}

export function transcribeRimePcm(pcm: Buffer, opts: RimeOptions): Promise<string> {
  const language = (opts.language ?? "en").toLowerCase();
  if (language !== "en" && language !== "es") {
    throw new Error(`Rime STT supports "en" and "es" (got "${opts.language}")`);
  }
  if (!opts.apiKey) throw new Error("no Rime key — add it in Settings → Speech");
  if (!pcm.length) throw new Error("no audio to transcribe");
  if (pcm.length > RIME_MAX_AUDIO_BYTES) {
    throw new Error(
      `audio is too long for one Rime request (${(pcm.length / 1024 / 1024).toFixed(1)} MB, max 16 MB)`,
    );
  }

  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(RIME_STT_URL, "rime.v1.json", {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      handshakeTimeout: 15_000,
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      settle();
    };
    timer = setTimeout(() => {
      finish(() => reject(new Error("Rime STT timed out")));
    }, opts.timeoutMs ?? 130_000);

    ws.on("unexpected-response", (_req, res) => {
      const detail = res.statusCode === 401 ? "key rejected" : `HTTP ${res.statusCode}`;
      finish(() => reject(new Error(`Rime STT ${detail}`)));
    });

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          start: {
            outputContract: "STREAMING_OUTPUT_CONTRACT_REVISED_HYPOTHESES",
            language,
          },
        }),
      );
    });

    ws.on("message", (data) => {
      let event: {
        started?: unknown;
        done?: { text?: string };
        error?: { kind?: string; message?: string };
        cancelled?: unknown;
      };
      try {
        event = JSON.parse(String(data)) as typeof event;
      } catch {
        return;
      }
      if (event.started) {
        void sendAudio().catch((err) =>
          finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
        );
      } else if (event.done) {
        finish(() => resolve(String(event.done?.text ?? "").trim()));
      } else if (event.error) {
        finish(() =>
          reject(new Error(`Rime STT ${event.error?.kind ?? "error"}: ${event.error?.message ?? ""}`)),
        );
      } else if (event.cancelled) {
        finish(() => reject(new Error("Rime STT cancelled")));
      }
    });

    ws.on("error", (err) => {
      finish(() => reject(new Error(`Rime STT connection failed: ${err.message}`)));
    });

    ws.on("close", () => {
      // No terminal event: the session is incomplete (Rime's own contract).
      finish(() => reject(new Error("Rime STT closed before a transcript arrived")));
    });

    async function sendAudio(): Promise<void> {
      const CHUNK = 3_200; // 100 ms of PCM16 mono at 16 kHz
      for (let offset = 0; offset < pcm.length; offset += CHUNK) {
        const chunk = pcm.subarray(offset, Math.min(offset + CHUNK, pcm.length));
        ws.send(JSON.stringify({ audio: chunk.toString("base64") }));
      }
      ws.send(JSON.stringify({ end: {} }));
    }
  });
}
