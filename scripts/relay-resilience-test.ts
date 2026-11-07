/**
 * Relay resilience: a transient relay failure must not end a pairing.
 *
 * A `429`, a `5xx` or a dropped request used to reject the desktop's reconnect
 * watcher, which disposed the session and stopped the 10-minute renewal. The
 * channel then expired, and every browser retry reported "the pairing session
 * is gone" until the operator minted a new code. The watcher now retries
 * transient failures and only fails on a dead channel/token.
 *
 * Also pins the browser-side classifier so a purged channel can stop its
 * 20-second retry loop instead of spamming the toast.
 *
 * Run: npm run test:relay-resilience
 */
import assert from "node:assert/strict";
import http from "node:http";
import { RelayTransport, isTerminalRelayError } from "../src/bridge/relay.js";
import { isRelaySessionGone } from "../web/src/server-link.js";

// ── 1. terminal vs transient ─────────────────────────────────────────────

const status = (code: number): Error => Object.assign(new Error(`HTTP ${code}`), { status: code });

assert.equal(isTerminalRelayError(status(404)), true, "a purged channel is terminal");
assert.equal(isTerminalRelayError(status(410)), true, "an expired channel is terminal");
assert.equal(isTerminalRelayError(status(401)), true, "a rejected token is terminal");
assert.equal(isTerminalRelayError(status(403)), true, "a foreign token is terminal");
assert.equal(isTerminalRelayError(status(429)), false, "a rate limit is transient");
assert.equal(isTerminalRelayError(status(503)), false, "a relay outage is transient");
assert.equal(
  isTerminalRelayError(new Error("the relay did not answer https://relay within 20s")),
  false,
  "a timeout is transient",
);
assert.equal(
  isTerminalRelayError(
    new Error("the relay pairing channel is gone or expired — run `npm run pair -- --relay` again"),
  ),
  true,
  "the desktop's dead-channel message is terminal",
);

assert.equal(
  isRelaySessionGone(
    new Error("the pairing session is gone — the server may have restarted or the code expired"),
  ),
  true,
  "the browser treats a purged channel as terminal",
);
assert.equal(
  isRelaySessionGone(new Error("the other side never opened a data channel")),
  false,
  "a slow handshake stays retryable",
);
assert.equal(
  isRelaySessionGone(new Error("BobSwap signal: HTTP 429")),
  false,
  "a relay rate limit stays retryable",
);
assert.equal(
  isRelaySessionGone(new Error("BobSwap signal: HTTP 403")),
  true,
  "a rejected role token is terminal",
);
assert.equal(
  isRelaySessionGone(
    new Error("this desktop was paired before relay reuse was supported — run `npm run pair -- --relay` again"),
  ),
  true,
  "a pre-renewal pairing needs a fresh code",
);

// ── 2. the desktop watcher survives a transient feed failure ─────────────

let feedCalls = 0;
let offer: { type?: string; payload?: { nonce?: string } } | null = null;

const server = http.createServer((req, res) => {
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (req.method === "GET" && url.startsWith("/api/v1/sync/channels/ch_1/signal")) {
    feedCalls += 1;
    if (feedCalls === 1) {
      send(500, { error: "temporarily unavailable" });
      return;
    }
    if (!offer) {
      send(200, {
        messages: [
          {
            seq: 1,
            from: "joiner",
            type: "candidates",
            payload: { reconnect: "nonce-1", profile: "phone" },
            created_at: "2026-11-07T00:00:00Z",
          },
        ],
        cursor: 1,
      });
      return;
    }
    send(200, { messages: [], cursor: 1 });
    return;
  }
  if (req.method === "PUT" && url === "/api/v1/sync/channels/ch_1/signal") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { type?: string; payload?: { nonce?: string } };
      if (parsed.type === "offer") {
        offer = parsed;
        send(201, { seq: 2, cursor: 2 });
        // Let the offer promise settle before leaving; its poller is still
        // waiting for an answer, so the process exits explicitly below.
        setTimeout(() => {
          assert.ok(offer, "the watcher offered after the transient error");
          assert.equal(offer?.payload?.nonce, "nonce-1", "the offer carries the reconnect nonce");
          assert.ok(feedCalls >= 2, "the feed was polled again after the 500");
          console.log("relay-resilience: ok");
          process.exit(0);
        }, 300);
        return;
      }
      send(201, { seq: 2, cursor: 2 });
    });
    return;
  }
  send(404, { error: "not found" });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no test port");

const transport = new RelayTransport({
  baseUrl: `http://127.0.0.1:${address.port}`,
  profile: "phone",
  id: "ch_1",
  code: "1234-5678",
  roleToken: "role-token",
  role: "offerer",
  iceServers: [],
});

// If the watcher gives up on the 500, this rejects and the test fails.
transport.waitForReconnect().catch((err: unknown) => {
  console.error("relay-resilience: watcher rejected", err);
  process.exit(1);
});

setTimeout(() => {
  console.error("relay-resilience: timed out waiting for the reconnect offer");
  process.exit(1);
}, 15_000).unref();
