/**
 * Relay reconnect generations: a newer reconnect request must not sit behind
 * an older offer.
 *
 * A tab that reloads twice (or retries after a failed handshake) sends a fresh
 * reconnect nonce. The desktop's watcher used to answer the first nonce and then
 * wait up to 60 seconds for its answer — meanwhile the newer request was either
 * ignored by the outstanding offer or skipped because the watcher advanced its
 * cursor to the end of the feed. Both sides then looked "paired but lost" until
 * a minute passed (and a third retry could repeat the same delay).
 *
 * This fake relay proves the outstanding offer gives up as soon as a newer
 * nonce appears, and that the watcher answers the newest request.
 *
 * Run: npm run test:relay-reconnect
 */
import assert from "node:assert/strict";
import http from "node:http";
import { RelayTransport } from "../src/bridge/relay.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let phase = 0;
let feedCalls = 0;
const offers: Array<{ nonce?: string }> = [];

const server = http.createServer((req, res) => {
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (req.method === "GET" && url.startsWith("/api/v1/sync/channels/ch_1/signal")) {
    feedCalls += 1;
    const messages: unknown[] = [
      {
        seq: 1,
        from: "joiner",
        type: "candidates",
        payload: { reconnect: "nonce-1", profile: "phone" },
        created_at: "2026-11-07T00:00:00Z",
      },
    ];
    if (phase >= 1) {
      messages.push({
        seq: 2,
        from: "joiner",
        type: "candidates",
        payload: { reconnect: "nonce-2", profile: "phone" },
        created_at: "2026-11-07T00:00:02Z",
      });
    }
    send(200, { messages, cursor: phase >= 1 ? 2 : 1 });
    return;
  }
  if (req.method === "PUT" && url === "/api/v1/sync/channels/ch_1/signal") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { type?: string; payload?: { nonce?: string } };
      if (parsed.type === "offer") {
        const nonce = parsed.payload?.nonce;
        offers.push({ nonce });
        if (nonce === "nonce-1") {
          // The tab retried while this offer was outstanding.
          phase = 1;
          send(201, { seq: 3, cursor: 3 });
          return;
        }
        if (nonce === "nonce-2") {
          send(201, { seq: 4, cursor: 4 });
          assert.deepEqual(offers.map((offer) => offer.nonce), ["nonce-1", "nonce-2"]);
          assert.ok(feedCalls >= 2, "the watcher polled again for the newer nonce");
          console.log("relay-reconnect: ok");
          process.exit(0);
        }
        send(400, { error: `unexpected nonce ${nonce}` });
        return;
      }
      send(201, { seq: 4, cursor: 4 });
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

transport.waitForReconnect().catch((err: unknown) => {
  console.error("relay-reconnect: watcher rejected", err);
  process.exit(1);
});

setTimeout(async () => {
  // Give a correct implementation a moment to finish the second offer.
  await sleep(1000);
  console.error(
    `relay-reconnect: timed out (offers: ${JSON.stringify(offers)}, feed calls: ${feedCalls})`,
  );
  process.exit(1);
}, 15_000).unref();
