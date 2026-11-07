/**
 * Unit test: auto-speak scope.
 *
 * Trunk only is literal: it reads emits the trunk itself wrote. An app's
 * bubbles belong to the app's tile, even when the trunk called that app during
 * the turn. "All apps" is the scope that reads those.
 *
 * Regression: when a direct trunk reply is not spoken, the ambient voice used
 * to fail silently (an unpaired desktop, an offline link, an autoplay policy).
 * The first distinct failure is now surfaced as a toast so the person can tell
 * why the setting seems to do nothing.
 *
 * No browser audio: `Audio`, `URL.createObjectURL`, and the paired desktop's
 * `synthesize` are stubbed; the test counts synthesis requests.
 * Run: npm run test:autospeak
 */
import assert from "node:assert/strict";

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
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

const storage = new MemoryStorage();
storage.setItem(
  "bob:services",
  JSON.stringify({
    tts: { provider: "rime", autoSpeak: "trunk", keys: { rime: "test-key" } },
  }),
);
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const synthesized: string[] = [];
let synthError: string | null = null;
(globalThis as any).__bobServer = {
  synthesize: async (text: string) => {
    if (synthError) throw new Error(synthError);
    synthesized.push(text);
    return { bytes: new Uint8Array([1, 2]), ext: ".wav" };
  },
};

class FakeAudio {
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
  addEventListener(): void {}
  set src(_value: string) {}
  get src(): string {
    return "";
  }
}
(globalThis as any).Audio = FakeAudio;
(globalThis as any).URL.createObjectURL = () => "blob:test";
(globalThis as any).URL.revokeObjectURL = () => {};

const { handleSSE, setState, state } = await import("../ui/src/store.ts");

setState({ active: "web:t", turns: [], apps: [], ready: true, toast: "" });

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function start(turnId: string, inputApp: string): void {
  handleSSE({
    type: "turn_start",
    session: "web:t",
    turnId,
    input: "hi",
    inputApp,
    ts: Date.now(),
  });
}

function emit(turnId: string, text: string, app: string, level?: string): void {
  handleSSE({ type: "emit", turnId, text, app, ...(level ? { level } : {}) });
}

function scope(value: "trunk" | "all" | undefined): void {
  storage.setItem(
    "bob:services",
    JSON.stringify({ tts: { provider: "rime", autoSpeak: value, keys: { rime: "test-key" } } }),
  );
}

// ── trunk only: the trunk's own emit ──────────────────────────────────────
start("t1", "trunk");
emit("t1", "direct trunk reply", "trunk");
await settle();
assert.deepEqual(synthesized, ["direct trunk reply"]);

// ── trunk only: an app's bubble is that app's, even in a trunk turn ───────
synthesized.length = 0;
start("t2", "trunk");
emit("t2", "reply written by the called app", "substack");
await settle();
assert.deepEqual(synthesized, [], "trunk only never reads app bubbles");

// ── trunk only: machine-level notes stay silent ───────────────────────────
synthesized.length = 0;
start("t3", "trunk");
emit("t3", "[app] handed back", "trunk", "machine");
await settle();
assert.deepEqual(synthesized, [], "machine notes are narration, not replies");

// ── trunk only: a turn started inside an app is not the trunk's chat ──────
synthesized.length = 0;
start("t4", "substack");
emit("t4", "app-only reply", "substack");
await settle();
assert.deepEqual(synthesized, [], "an app-started turn is not the trunk conversation");

// ...but the trunk's own emit in that turn is still a trunk reply.
synthesized.length = 0;
start("t5", "substack");
emit("t5", "trunk aside", "trunk");
await settle();
assert.deepEqual(synthesized, ["trunk aside"]);

// ── all apps: every app's emits are read ──────────────────────────────────
scope("all");
synthesized.length = 0;
start("t6", "substack");
emit("t6", "app reply under all", "substack");
await settle();
assert.deepEqual(synthesized, ["app reply under all"]);

// ── off / absent: nothing is read ─────────────────────────────────────────
scope(undefined);
synthesized.length = 0;
start("t7", "trunk");
emit("t7", "off means quiet", "trunk");
await settle();
assert.deepEqual(synthesized, [], "no scope = no auto-speak");

// ── the old boolean spelling still means trunk only ───────────────────────
storage.setItem(
  "bob:services",
  JSON.stringify({ tts: { provider: "rime", autoSpeak: true, keys: { rime: "test-key" } } }),
);
synthesized.length = 0;
start("t8", "trunk");
emit("t8", "legacy trunk reply", "trunk");
await settle();
assert.deepEqual(synthesized, ["legacy trunk reply"]);

synthesized.length = 0;
start("t9", "trunk");
emit("t9", "legacy app raw", "substack");
await settle();
assert.deepEqual(synthesized, [], "legacy true is trunk only, not all apps");

// ── the global enable switch applies without a page reload ────────────────
storage.setItem(
  "bob:services",
  JSON.stringify({
    tts: { provider: "rime", autoSpeak: "trunk", enabled: false, keys: { rime: "test-key" } },
  }),
);
synthesized.length = 0;
start("t9b", "trunk");
emit("t9b", "muted reply", "trunk");
await settle();
assert.deepEqual(synthesized, [], "the enable switch stops auto-speak immediately");

storage.setItem(
  "bob:services",
  JSON.stringify({ tts: { provider: "rime", autoSpeak: "trunk", keys: { rime: "test-key" } } }),
);

// ── a silent failure is surfaced once, not mistaken for the setting ───────
synthError = "this device is not paired with a desktop";
setState({ toast: "" });
start("t10", "trunk");
emit("t10", "unheard reply", "trunk");
await settle();
assert.match(state.toast, /auto-speak failed: this device is not paired/);
assert.equal(state.toastErr, true);

// The same failure across the next bubbles is not repeated.
setState({ toast: "" });
start("t11", "trunk");
emit("t11", "another unheard reply", "trunk");
await settle();
assert.equal(state.toast, "", "one toast per distinct failure");

// A success clears the dedupe, so a later recurrence is reported again.
synthError = null;
synthesized.length = 0;
start("t12", "trunk");
emit("t12", "spoken again", "trunk");
await settle();
assert.deepEqual(synthesized, ["spoken again"]);

synthError = "the browser blocked playback";
setState({ toast: "" });
start("t13", "trunk");
emit("t13", "blocked reply", "trunk");
await settle();
assert.match(state.toast, /auto-speak failed: the browser blocked playback/);

console.log("autospeak: ok");
