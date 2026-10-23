/**
 * Two-way Telegram bridge — the server half.
 *
 * The browser tab owns the conversation (OPFS); the admin only relays. This
 * test drives the relay protocol over HTTP with a mock agent + spy notify:
 *
 *   1. A heartbeat links the chat and announces it exactly once.
 *   2. Messages are deferred to the browser (pending) instead of running the
 *      tree; they show up in the inbox.
 *   3. A relay answers one message and clears it from pending.
 *   4. A stale heartbeat (tab closed) falls back to the bot's own session:
 *      one away marker, then the deferred text runs.
 *   5. A late relay from a resumed tab (old epoch) is dropped, not duplicated.
 *   6. The bridge is memory-only: no settings file, no session adoption.
 *
 * Run: npm run test:telegram-bridge
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";

// Short timings for the test — the bridge module reads these at import time.
process.env.BRIDGE_TTL_MS = "120";
process.env.BRIDGE_SWEEP_MS = "30";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-tg-bridge-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const sent: Array<{ key: string; text: string }> = [];
const mockAgent = () =>
  ({
    // A rotated "/new" session key: the bridge must still target the chat.
    sessionKeys: () => ["12345:0:abc123"],
    sessionMeta: () => [{ key: "12345:0:abc123", updatedAt: Date.now() }],
    hasContinuation: () => false,
    consumesInputDirectly: async () => false,
    clear() {},
    async run() {
      return { status: "waiting", continuation: "mock:1" };
    },
  }) as any;

const mod = await import("../src/admin.ts");
const bridge = await import("../src/telegram-bridge.ts");
const port = await freePort();
const server = mod.startAdmin({
  port,
  workspaceDir: ws,
  agent: mockAgent(),
  telegramNotify: async (key: string, text: string) => {
    sent.push({ key, text });
  },
});
await events.once(server, "listening");

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function waitFor(check: () => boolean, what: string, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  // 1. Beat links the chat and announces it once.
  const beat1 = await api("POST", "/api/telegram/bridge", {});
  assert.equal(beat1.status, 200);
  assert.equal(beat1.json.target, "12345:0", "the live Telegram chat is the target");
  assert.ok(
    sent.some((s) => s.key === "12345:0" && s.text.includes("bridged")),
    "the linked marker reached the phone",
  );
  const before = sent.length;
  const beat2 = await api("POST", "/api/telegram/bridge", {});
  assert.equal(beat2.status, 200);
  assert.equal(bridge.bridgeEpoch("12345:0"), beat1.json.epoch, "no fallback yet");
  assert.equal(sent.length, before, "a repeat beat does not repeat the marker");

  // 2. Deferral: text is held for the browser, not run here.
  let fallbackRuns = 0;
  let awayMarkers = 0;
  const deferred = bridge.deferToBridge(
    "12345:0",
    { id: 7, text: "hello from the phone", chatId: 12345, threadId: 0 },
    () => {
      fallbackRuns += 1;
    },
    () => {
      awayMarkers += 1;
    },
  );
  assert.equal(deferred, true, "a fresh bridge defers the message");
  const inbox1 = await api("GET", "/api/telegram/inbox");
  assert.equal(inbox1.status, 200);
  assert.equal(inbox1.json.bridged, true);
  assert.deepEqual(
    inbox1.json.pending.map((m: any) => [m.id, m.text]),
    [[7, "hello from the phone"]],
    "the message is waiting for the browser",
  );
  assert.equal(fallbackRuns, 0, "nothing ran server-side while the tab is alive");

  // 3. The browser relays its answer; the pending entry clears.
  const relay = await api("POST", "/api/telegram/relay", {
    text: "browser answer",
    replyTo: 7,
    epoch: inbox1.json.epoch,
  });
  assert.equal(relay.status, 200);
  assert.equal(relay.json.parts, 1);
  assert.ok(
    sent.some((s) => s.key === "12345:0" && s.text === "browser answer"),
    "the browser's answer reached the phone",
  );
  const inbox2 = await api("GET", "/api/telegram/inbox");
  assert.equal(inbox2.json.pending.length, 0, "answered message is no longer pending");

  // 4. Stale heartbeat → fallback in the bot's own session, away marker once.
  bridge.deferToBridge(
    "12345:0",
    { id: 8, text: "answer this after the tab died", chatId: 12345, threadId: 0 },
    () => {
      fallbackRuns += 1;
    },
    () => {
      awayMarkers += 1;
    },
  );
  const staleEpoch = bridge.bridgeEpoch("12345:0");
  await waitFor(() => fallbackRuns === 1, "the fallback run");
  assert.equal(awayMarkers, 1, "the away marker preceded the fallback answer");
  const inbox3 = await api("GET", "/api/telegram/inbox");
  assert.equal(inbox3.json.pending.length, 0, "the fallback consumed the message");
  assert.ok(
    (inbox3.json.answeredIds as number[]).includes(8),
    "the inbox reports the server-answered id",
  );

  // 5. A resumed tab's late relay (old epoch) is dropped, not duplicated.
  const late = await api("POST", "/api/telegram/relay", {
    text: "late browser answer",
    replyTo: 8,
    epoch: staleEpoch,
  });
  assert.equal(late.status, 200);
  assert.equal(late.json.dropped, true, "a pre-fallback relay is dropped");
  assert.ok(
    !sent.some((s) => s.text === "late browser answer"),
    "the phone does not get the duplicate",
  );

  // 6. Long replies chunk like the phone path.
  const long = "x".repeat(4500);
  const chunked = await api("POST", "/api/telegram/relay", { text: long });
  assert.equal(chunked.status, 200);
  assert.equal(chunked.json.parts, 2, "4500 chars split into two Telegram parts");

  // 7. Turning the bridge off clears the chat at once.
  bridge.deferToBridge(
    "12345:0",
    { id: 9, text: "dropped", chatId: 12345, threadId: 0 },
    () => {},
    () => {},
  );
  const off = await api("POST", "/api/telegram/bridge", { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.bridged, false);
  assert.equal(bridge.bridgePending("12345:0").length, 0, "off drops pending messages");
  assert.equal(
    bridge.deferToBridge(
      "12345:0",
      { id: 10, text: "nope", chatId: 12345, threadId: 0 },
      () => {},
      () => {},
    ),
    false,
    "an off bridge lets the bot answer normally",
  );

  // 8. The bridge is memory-only: no settings/binding file was written and
  //    the Telegram session was never adopted into the web log.
  const files = await fs.readdir(path.join(ws, "logs")).catch(() => [] as string[]);
  assert.ok(!files.includes("web-settings.json"), "no follow settings written by the bridge");
  assert.equal(mod.telegramFollowKey("12345:0"), undefined, "no reverse-follow binding");
  const inbox4 = await api("GET", "/api/telegram/inbox");
  assert.deepEqual(inbox4.json.turns, [], "no turn markers were written for the bridge");

  console.log("telegram-bridge-test: all assertions passed");
} finally {
  bridge.resetBridge();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(ws, { recursive: true, force: true });
}
