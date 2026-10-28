// Offline test of the single-host lease's contention logic
// (`web/src/host-lease.ts`).
//
// The Web Locks path is browser-only; what is unit-testable here is the
// localStorage heartbeat path — and that is where the interesting races live:
// first tab wins, second tab stays secondary, voluntary release promotes,
// a stale (crashed) holder does not block, a fresh takeover demotes the old
// holder, and cooperative takeover through the channel bus.
//
// All timings are real (the module sleeps between verify steps), so the test
// runs for a few seconds; the clocks themselves are injectable and faked.
import assert from "node:assert/strict";

import { createHostLease, type LeaseChannel, type LeaseDeps } from "../web/src/host-lease";

// ── fakes ────────────────────────────────────────────────────────────────

/** Storage-shaped map shared by every "tab" in a scenario. */
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** A BroadcastChannel-like port; a Bus delivers posts to the other ports. */
class FakeChannel implements LeaseChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private bus: FakeBus | null = null;
  attach(bus: FakeBus): void {
    this.bus = bus;
    bus.channels.push(this);
  }
  postMessage(message: unknown): void {
    this.bus?.broadcast(this, message);
  }
}

class FakeBus {
  channels: FakeChannel[] = [];
  broadcast(from: FakeChannel, message: unknown): void {
    for (const channel of this.channels) {
      if (channel === from) continue;
      channel.onmessage?.({ data: message });
    }
  }
}

/** Controllable clock: a fake base plus real elapsed time, plus an offset. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  const startReal = Date.now();
  let offset = 0;
  return {
    now: () => 1_000_000 + offset + (Date.now() - startReal),
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

function deps(
  storage: FakeStorage,
  clock: { now: () => number },
  extra: Partial<LeaseDeps> = {},
): LeaseDeps {
  return { storage, locks: null, now: clock.now, ...extra };
}

async function waitUntil(
  fn: () => boolean,
  what: string,
  timeoutMs = 6_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

const scenarios: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "first tab wins, second stays secondary",
    run: async () => {
      const storage = new FakeStorage();
      const clock = fakeClock();
      const a = createHostLease("ws", deps(storage, clock, { holderId: "a" }));
      assert.equal(await a.whenSettled(), "primary");
      const b = createHostLease("ws", deps(storage, clock, { holderId: "b" }));
      assert.equal(await b.whenSettled(), "secondary");
      a.release();
      b.release();
    },
  },
  {
    name: "voluntary release promotes a waiting tab",
    run: async () => {
      const storage = new FakeStorage();
      const clock = fakeClock();
      const a = createHostLease("ws", deps(storage, clock, { holderId: "a" }));
      await a.whenSettled();
      const b = createHostLease("ws", deps(storage, clock, { holderId: "b" }));
      await b.whenSettled();
      a.release();
      await waitUntil(() => b.status() === "primary", "b promoted after a released");
      b.release();
    },
  },
  {
    name: "a stale (crashed) holder does not block the next tab",
    run: async () => {
      const storage = new FakeStorage();
      const clock = fakeClock();
      // A holder that crashed long ago: its record is far past the window.
      storage.setItem(
        "bob-host-lease:ws",
        JSON.stringify({ holder: "ghost", at: clock.now() - 60_000 }),
      );
      const b = createHostLease("ws", deps(storage, clock, { holderId: "b" }));
      assert.equal(await b.whenSettled(), "primary");
      b.release();
    },
  },
  {
    name: "a fresh foreign record demotes the old holder (bookkeeping race)",
    run: async () => {
      const storage = new FakeStorage();
      const clock = fakeClock();
      const a = createHostLease("ws", deps(storage, clock, { holderId: "a" }));
      await a.whenSettled();
      // Another tab stole the record while a's bookkeeping lagged.
      storage.setItem(
        "bob-host-lease:ws",
        JSON.stringify({ holder: "b", at: clock.now() }),
      );
      await waitUntil(
        () => a.status() === "secondary",
        "a demoted after losing the record",
        8_000,
      );
      a.release();
    },
  },
  {
    name: "cooperative takeover yields the holder and promotes the asker",
    run: async () => {
      const storage = new FakeStorage();
      const clock = fakeClock();
      const bus = new FakeBus();
      const chanA = new FakeChannel();
      const chanB = new FakeChannel();
      chanA.attach(bus);
      chanB.attach(bus);
      const a = createHostLease(
        "ws",
        deps(storage, clock, { holderId: "a", channel: chanA }),
      );
      await a.whenSettled();
      const b = createHostLease(
        "ws",
        deps(storage, clock, { holderId: "b", channel: chanB }),
      );
      await b.whenSettled();
      const taken = await b.takeOver();
      assert.equal(taken, true, "takeover should succeed when the holder cooperates");
      assert.equal(b.status(), "primary");
      assert.equal(a.status(), "secondary");
      a.release();
      b.release();
    },
  },
  {
    name: "takeover fails when the holder does not respond",
    run: async () => {
      const storage = new FakeStorage();
      const clock = fakeClock();
      const a = createHostLease("ws", deps(storage, clock, { holderId: "a" }));
      await a.whenSettled();
      const b = createHostLease("ws", deps(storage, clock, { holderId: "b" }));
      await b.whenSettled();
      // No channels wired: the yield-request never reaches `a`, which keeps
      // heartbeating, so `b` must report failure instead of stealing.
      const taken = await b.takeOver();
      assert.equal(taken, false);
      assert.equal(b.status(), "secondary");
      a.release();
      b.release();
    },
  },
  {
    name: "no storage available → the lease stays none",
    run: async () => {
      const lease = createHostLease("ws", { storage: null, locks: null });
      assert.equal(await lease.whenSettled(), "none");
    },
  },
];

let failures = 0;
console.log("running", scenarios.length, "scenarios");
for (const scenario of scenarios) {
  try {
    await scenario.run();
    console.log(`ok   ${scenario.name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${scenario.name}: ${err instanceof Error ? err.message : err}`);
  }
}
if (failures) {
  console.error(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
console.log("\nhost-lease: all scenarios passed");
process.exit(0);
