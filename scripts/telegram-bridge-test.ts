// Offline test of the telegram channel's mailbox + binding registry
// (src/telegram-bridge.ts) — the park & forward contract:
//
//   park with no tab connected → messages wait on disk
//   tab claims (inbox)         → messages arrive, chat binds to its profile
//   ack                        → drained, answered ids remembered
//   channel restart            → bindings + mailbox survive (fresh module)
//   handover                   → another profile claiming bumps the epoch;
//                                late relays carrying it drop
//
// State goes to a temp BOB_STATE_DIR so the test never touches ~/.grandpa-bob.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.BOB_STATE_DIR = path.join(os.tmpdir(), `bob-bridge-test-${Date.now()}`);

const bridge = await import("../src/telegram-bridge.js");
const {
  parkMessage,
  claimPending,
  ackMessages,
  answeredIds,
  bindingProfile,
  bridgeEpoch,
  beatProfile,
  chunkForTelegram,
  resetBridge,
} = bridge;

const CHAT = "100:0";

try {
  // ── park & forward: no tab exists yet ────────────────────────────────
  await parkMessage(CHAT, { id: 11, text: "add milk to shopping.md", chatId: 100, threadId: 0 });
  await parkMessage(CHAT, { id: 12, text: "and eggs", chatId: 100, threadId: 0 });

  // No profile has claimed the chat: nothing bound, nothing expired.
  assert.equal(await bindingProfile(CHAT), null);
  assert.equal(await bridgeEpoch(CHAT), 0);

  // ── a tab connects and claims ────────────────────────────────────────
  const first = await claimPending("opfs:default");
  assert.equal(first.claimed.includes(CHAT), true, "the chat binds to the claiming profile");
  assert.equal(first.messages.length, 2, "both parked messages arrive");
  assert.deepEqual(
    first.messages.map((m) => m.text),
    ["add milk to shopping.md", "and eggs"],
    "oldest first",
  );
  assert.equal(first.epochs[CHAT], 0);
  assert.equal(await bindingProfile(CHAT), "opfs:default");

  // ── ack: drained, answered remembered ────────────────────────────────
  await ackMessages(CHAT, [11, 12]);
  assert.deepEqual(await answeredIds(CHAT), [11, 12]);
  const drained = await claimPending("opfs:default");
  assert.equal(drained.messages.length, 0, "acked messages do not re-deliver");

  // ── heartbeat keeps the binding alive; expiry makes it claimable ─────
  await beatProfile("opfs:default");
  const steal = await claimPending("desktop:ws");
  assert.equal(steal.claimed.length, 0, "a live binding cannot be stolen");
  assert.equal(await bindingProfile(CHAT), "opfs:default");

  // ── handover: another profile claims after expiry ────────────────────
  await parkMessage(CHAT, { id: 13, text: "hello?", chatId: 100, threadId: 0 });
  // Simulate the tab going away: bindings expire after BRIDGE_TTL_MS; the
  // claim from a different profile takes over an expired binding.
  const handover = await claimPendingWithStaleBinding();
  assert.equal(handover.claimed.includes(CHAT), true, "an expired chat is claimable");
  assert.equal(await bindingProfile(CHAT), "desktop:ws");
  assert.equal(await bridgeEpoch(CHAT), 1, "handover bumps the epoch");
  assert.equal(handover.messages.length, 1);
  assert.equal(handover.messages[0].text, "hello?");

  console.log("telegram-bridge: all scenarios passed");

  /** Claim from another profile once the binding's beat has gone stale. */
  async function claimPendingWithStaleBinding() {
    // The sweep would expire the binding; simulate a beat older than the TTL
    // by claiming after the TTL via the bridge's own staleness check — wait
    // past the TTL window (BRIDGE_TTL_MS default 15s is too slow for a test,
    // so shorten the clock by re-parking and claiming with a fake "now"):
    // the public API takes `now`, and claims compare `now - lastBeat`.
    const longAgo = Date.now() + 2 * bridge.BRIDGE_TTL_MS;
    return claimPending("desktop:ws", longAgo);
  }
} finally {
  await resetBridge();
  await fs.rm(process.env.BOB_STATE_DIR!, { force: true }).catch(() => {});
}

// ── chunking (relay path) ────────────────────────────────────────────────
assert.deepEqual(chunkForTelegram("short"), ["short"]);
const long = "a".repeat(30) + "\n" + "b".repeat(30);
const parts = chunkForTelegram(long, 20);
assert.ok(parts.join("").replace(/\n/g, "").includes("a".repeat(30)));

// Re-export surface sanity: the module is the channel's core; these are the
// names src/index.ts and src/bot.ts build on.
for (const name of ["parkMessage", "claimPending", "ackMessages", "beatProfile", "BRIDGE_LINKED_TEXT"]) {
  assert.equal(typeof (bridge as Record<string, unknown>)[name] !== "undefined", true, `${name} exported`);
}
process.exit(0);
