/**
 * Relay renewal: the client parses `expires_at`, requests a long TTL, derives
 * its next tick from the reported lifetime, and falls back to the fixed
 * lifetime on deployments without TTL support.
 */
import assert from "node:assert/strict";
import http from "node:http";
import {
  RelayTransport,
  createRelayChannel,
  renewalDelayMs,
  renewRelayChannel,
} from "../src/bridge/relay.js";

let renewCalls = 0;
let renewStatus = 200;
let renewExpiry = "2026-11-06T12:00:00Z";
let rejectTtl = false;
let seenAuth = "";
const renewBodies: string[] = [];

const server = http.createServer((req, res) => {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && req.url === "/api/v1/sync/channels") {
    send(201, {
      channel_id: "ch_1",
      pairing_code: "1234-5678",
      role_token: "role-token",
      role: "offerer",
      created_at: "2026-11-06T11:30:00Z",
      expires_at: "2026-11-06T11:40:00Z",
      ice_servers: [],
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/v1/sync/channels/ch_1/renew") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      renewCalls += 1;
      renewBodies.push(body);
      seenAuth = String(req.headers.authorization ?? "");
      if (renewStatus !== 200) {
        send(renewStatus, { error: "not found" });
        return;
      }
      if (rejectTtl && body.includes("ttl_seconds")) {
        send(400, { error: "unknown field ttl_seconds" });
        return;
      }
      send(200, { channel_id: "ch_1", expires_at: renewExpiry });
    });
    return;
  }
  send(404, { error: "not found" });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no test port");
const baseUrl = `http://127.0.0.1:${address.port}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  const channel = await createRelayChannel({ baseUrl, key: "read-key" }, "phone");
  assert.equal(channel.id, "ch_1");
  assert.equal(channel.expiresAt, "2026-11-06T11:40:00Z");

  const renewed = await renewRelayChannel(channel);
  assert.equal(renewed, "2026-11-06T12:00:00Z");
  assert.equal(renewCalls, 1);
  assert.equal(seenAuth, "Bearer role-token");
  assert.deepEqual(JSON.parse(renewBodies[0] ?? "{}"), {}, "a plain renew keeps the default TTL");

  // A requested TTL rides in the body; BobSwap clamps it to its maximum.
  await renewRelayChannel(channel, 604800);
  assert.deepEqual(JSON.parse(renewBodies.at(-1) ?? "{}"), { ttl_seconds: 604800 });

  // Next tick: a third of the remaining lifetime, capped at one day.
  const now = Date.parse("2026-11-09T00:00:00Z");
  const hour = 60 * 60_000;
  const day = 24 * hour;
  assert.equal(
    renewalDelayMs(new Date(now + 7 * day).toISOString(), now),
    day,
    "a week-long channel renews once a day",
  );
  assert.equal(
    renewalDelayMs(new Date(now + day).toISOString(), now),
    8 * hour,
    "a 24-hour operator cap renews every 8 hours",
  );
  assert.equal(
    renewalDelayMs(new Date(now + 30 * 60_000).toISOString(), now),
    10 * 60_000,
    "a fixed 30-minute channel keeps the 10-minute cadence",
  );
  assert.equal(
    renewalDelayMs(undefined, now),
    10 * 60_000,
    "a missing expiry falls back to the legacy cadence",
  );

  // An older deployment answers 404; the error carries the status so the
  // transport can stop trying and keep the fixed lifetime.
  renewStatus = 404;
  await assert.rejects(
    () => renewRelayChannel(channel),
    (err: unknown) => (err as { status?: number }).status === 404,
  );

  // A relay that rejects `ttl_seconds` gets one retry without it; the pairing
  // stays alive on the default lifetime instead of being torn down.
  renewStatus = 200;
  rejectTtl = true;
  renewBodies.length = 0;
  let reportedExpiry: string | undefined;
  let died = false;
  const transport = new RelayTransport(
    { ...channel, expiresAt: "2026-11-06T11:40:00Z" },
    {
      onRenewed: (expiresAt) => (reportedExpiry = expiresAt),
      onDead: () => (died = true),
    },
  );
  transport.renewAhead();
  await waitFor(() => renewBodies.length >= 2, "the TTL fallback retry");
  transport.close();
  assert.deepEqual(JSON.parse(renewBodies[0] ?? "{}"), { ttl_seconds: 604800 });
  assert.deepEqual(JSON.parse(renewBodies[1] ?? "{}"), {}, "the retry omits the TTL field");
  assert.equal(reportedExpiry, renewExpiry);
  assert.equal(died, false, "a rejected TTL field is not a dead channel");

  console.log("relay-renew: ok");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
