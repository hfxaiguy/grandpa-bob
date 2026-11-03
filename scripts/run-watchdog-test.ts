/**
 * Run watchdog — the browser host's stuck-turn airbag.
 *
 * grandma-kat bounds every LLM call, but a turn can still go silent (dead
 * worker, an engine deadlock) while its run promise never settles: the chat
 * spinner then stays up forever. The watchdog reports a run once it has shown
 * no engine activity for `staleMs`, and the host settles it as an error.
 *
 * Deterministic: the clock and timers are injected, so no sleeping.
 *
 * Run: npm run test:run-watchdog
 */
import assert from "node:assert/strict";
import { createRunWatchdog, DEFAULT_STALE_MS } from "../web/src/agent/run-watchdog.ts";

let now = 1_000;
const fired: string[] = [];
let intervalFn: (() => void) | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let cleared: ReturnType<typeof setInterval> | null = null;

const wd = createRunWatchdog({
  staleMs: 10_000,
  checkMs: 1_000,
  now: () => now,
  setInterval: (fn) => {
    intervalFn = fn;
    return 42 as unknown as ReturnType<typeof setInterval>;
  },
  clearInterval: (handle) => {
    cleared = handle;
  },
});

// ── 1. nothing is reported before the threshold ─────────────────────────
wd.start({ key: "web:1", turnId: "t1", onStale: () => fired.push("t1") });
assert.notEqual(intervalFn, null, "starting a run arms the sweep interval");

now += 9_999;
wd.check();
assert.deepEqual(fired, [], "a run younger than staleMs is left alone");

now += 1;
wd.check();
assert.deepEqual(fired, ["t1"], "the run is reported at the threshold");

wd.check();
assert.deepEqual(fired, ["t1"], "a reported run is dropped, not reported again");

// ── 2. activity keeps a run alive ───────────────────────────────────────
wd.start({ key: "web:2", turnId: "t2", onStale: () => fired.push("t2") });
now += 8_000;
wd.touch("web:2", "t2");
now += 8_000;
wd.check();
assert.deepEqual(fired, ["t1"], "a touched run is not stale yet");

now += 2_000;
wd.check();
assert.deepEqual(fired, ["t1", "t2"], "silence after the last activity trips it");

// ── 3. a touch for another turn (or session) is ignored ─────────────────
wd.start({ key: "web:3", turnId: "t3", onStale: () => fired.push("t3") });
wd.touch("web:3", "someone-else");
wd.touch("web:miss", "t3");
now += 10_000;
wd.check();
assert.deepEqual(fired, ["t1", "t2", "t3"], "a foreign touch cannot keep a dead run alive");

// ── 4. finish() removes a normally-settled run ──────────────────────────
wd.start({ key: "web:4", turnId: "t4", onStale: () => fired.push("t4") });
wd.finish("web:4", "t4");
now += 60_000;
wd.check();
assert.deepEqual(fired, ["t1", "t2", "t3"], "a finished run is never reported");

// finish with a stale turn id is a no-op
wd.start({ key: "web:5", turnId: "t5", onStale: () => fired.push("t5") });
wd.finish("web:5", "other");
now += 10_000;
wd.check();
assert.deepEqual(fired, ["t1", "t2", "t3", "t5"], "finish only forgets the matching turn");

// ── 5. the interval drives checks, and stop() clears it ─────────────────
wd.start({ key: "web:6", turnId: "t6", onStale: () => fired.push("t6") });
now += 10_000;
assert.notEqual(intervalFn, null, "the sweep function is registered");
intervalFn!();
assert.deepEqual(fired.at(-1), "t6", "the periodic sweep reports stale runs");

wd.stop();
assert.equal(cleared, 42, "stop() clears the interval");
assert.equal(intervalFn !== null, true, "the captured sweep is still callable");
wd.check();
assert.deepEqual(fired.at(-1), "t6", "stop() forgets the runs, so a later check is empty");

// ── 6. a throwing handler cannot block the other runs ───────────────────
const quiet = console.warn;
console.warn = () => {};
try {
  now += 1_000;
  wd.start({ key: "web:7", turnId: "t7", onStale: () => { throw new Error("boom"); } });
  wd.start({ key: "web:8", turnId: "t8", onStale: () => fired.push("t8") });
  now += 10_000;
  wd.check();
  assert.deepEqual(fired.at(-1), "t8", "one broken handler does not stop the sweep");
} finally {
  console.warn = quiet;
  wd.stop();
}

assert.ok(DEFAULT_STALE_MS >= 10 * 60_000, "the default exceeds Ollama's 10-minute call budget");
console.log("run-watchdog: all assertions passed");
