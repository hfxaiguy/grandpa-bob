/**
 * Relay pairing survives a process restart.
 *
 * A paired BobSwap channel is persisted to `relay-channels.json`; on boot the
 * manager renews it (the stored expiry may be close or stale) and waits for
 * the browser's nonce-tagged reconnect, so no new code is needed inside the
 * remaining TTL. A channel the relay reports as gone is pruned instead of
 * being renewed forever.
 *
 * Run: `npm run test:relay-resume`.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-relay-resume-"));
process.env.BOB_STATE_DIR = stateDir;

let renewStatus = 200;
const renewed: string[] = [];
const signals: string[] = [];

const server = http.createServer((req, res) => {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const renew = /^\/api\/v1\/sync\/channels\/([^/]+)\/renew$/.exec(req.url ?? "");
  if (req.method === "POST" && renew) {
    const id = decodeURIComponent(renew[1]);
    renewed.push(id);
    if (renewStatus !== 200) {
      send(renewStatus, { error: "channel gone" });
      return;
    }
    send(200, { channel_id: id, expires_at: "2026-11-09T12:00:00Z" });
    return;
  }
  const signal = /^\/api\/v1\/sync\/channels\/([^/]+)\/signal/.exec(req.url ?? "");
  if (req.method === "GET" && signal) {
    signals.push(decodeURIComponent(signal[1]));
    send(200, { messages: [], cursor: 0 });
    return;
  }
  send(404, { error: "not found" });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no test port");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const { PeerManager } = await import("../src/bridge/peer.js");
const { Mailbox } = await import("../src/bridge/mailbox.js");
const store = await import("../src/bridge/store.js");

const base = {
  baseUrl,
  roleToken: "role-token",
  profile: "phone",
  authProfile: "phone",
  capabilities: { mirror: "phone", exec: [] },
  iceServers: [],
  savedAt: new Date().toISOString(),
};

try {
  await store.savePeer({
    profile: "phone",
    keyHash: "a".repeat(64),
    capabilities: { mirror: "phone", exec: [] },
    pairedAt: new Date().toISOString(),
    fingerprint: "f".repeat(16),
    proofProfile: "*",
  });

  // ── persistence round-trip ───────────────────────────────────────────────
  await store.saveRelayChannel({ ...base, channelId: "ch_boot", expiresAt: "2026-11-09T10:00:00Z" });
  await store.saveRelayChannel({ ...base, channelId: "ch_boot", expiresAt: "2026-11-09T11:00:00Z" });
  let file = await store.readRelayChannels();
  assert.equal(file.channels.length, 1, "upsert keeps one record per channel");
  assert.equal(file.channels[0].expiresAt, "2026-11-09T11:00:00Z");

  // ── boot resumes: renew at once, then wait for the browser ──────────────
  const manager = new PeerManager(new Mailbox(), []);
  await manager.resumeRelayChannels();
  await waitFor(() => renewed.includes("ch_boot"), "the resumed channel's renewal");
  // The reconnect watcher is polling the same channel for a browser request.
  await waitFor(() => signals.includes("ch_boot"), "the reconnect wait to start");
  assert.equal(renewStatus, 200);

  // ── a channel the relay reports gone is pruned, not renewed forever ─────
  renewStatus = 410;
  await store.saveRelayChannel({ ...base, channelId: "ch_dead", expiresAt: "2026-11-09T10:00:00Z" });
  await manager.resumeRelayChannels();
  await waitFor(
    () => renewed.includes("ch_dead"),
    "the dead channel's renewal attempt",
  );
  await waitFor(
    async () =>
      (await store.readRelayChannels()).channels.every((entry) => entry.channelId !== "ch_dead"),
    "the dead channel to be pruned",
  );
  file = await store.readRelayChannels();
  assert.ok(file.channels.every((entry) => entry.channelId !== "ch_dead"));

  manager.close();

  // ── revoking a profile forgets its relay channels ───────────────────────
  await store.removeRelayChannelsForProfile("phone");
  file = await store.readRelayChannels();
  assert.equal(file.channels.length, 0);

  console.log("relay-resume: ok");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(stateDir, { recursive: true, force: true });
}
