/**
 * Relay renewal: the client parses `expires_at`, calls the renew route with the
 * role token, and surfaces a 404 so the transport can fall back to the fixed
 * lifetime on deployments without the endpoint.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createRelayChannel, renewRelayChannel } from "../src/bridge/relay.js";

let renewCalls = 0;
let renewStatus = 200;
let renewExpiry = "2026-11-06T12:00:00Z";
let seenAuth = "";

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
    renewCalls += 1;
    seenAuth = String(req.headers.authorization ?? "");
    if (renewStatus !== 200) {
      send(renewStatus, { error: "not found" });
      return;
    }
    send(200, { channel_id: "ch_1", expires_at: renewExpiry });
    return;
  }
  send(404, { error: "not found" });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no test port");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const channel = await createRelayChannel({ baseUrl, key: "read-key" }, "phone");
  assert.equal(channel.id, "ch_1");
  assert.equal(channel.expiresAt, "2026-11-06T11:40:00Z");

  const renewed = await renewRelayChannel(channel);
  assert.equal(renewed, "2026-11-06T12:00:00Z");
  assert.equal(renewCalls, 1);
  assert.equal(seenAuth, "Bearer role-token");

  // An older deployment answers 404; the error carries the status so the
  // transport can stop trying and keep the fixed lifetime.
  renewStatus = 404;
  await assert.rejects(
    () => renewRelayChannel(channel),
    (err: unknown) => (err as { status?: number }).status === 404,
  );

  console.log("relay-renew: ok");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
