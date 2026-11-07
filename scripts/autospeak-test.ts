/**
 * Unit test: auto-speak scope.
 *
 * Regression: with **Trunk only** the ambient voice stayed silent whenever the
 * trunk handed the turn to an app. The app's reply is still the trunk
 * conversation's reply — it renders inside the trunk's app-call card — but the
 * filter only matched emits tagged `trunk`, so a person typing in the trunk
 * heard nothing while talking through an app.
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
(globalThis as any).__bobServer = {
  synthesize: async (text: string) => {
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

const { handleSSE, setState } = await import("../ui/src/store.ts");

setState({ active: "web:t", turns: [], apps: [], ready: true });

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

// ── trunk only: an app's reply in a trunk-started turn (the regression) ───
synthesized.length = 0;
start("t2", "trunk");
emit("t2", "reply written by the called app", "substack");
await settle();
assert.deepEqual(
  synthesized,
  ["reply written by the called app"],
  "an app's bubble in the trunk's turn is the trunk conversation",
);

// ── trunk only: machine-level notes stay silent ───────────────────────────
synthesized.length = 0;
start("t3", "trunk");
emit("t3", "[app] handed back", "trunk", "machine");
await settle();
assert.deepEqual(synthesized, [], "machine notes are narration, not replies");

// ── trunk only: a turn started inside an app is that app's chat ───────────
synthesized.length = 0;
start("t4", "substack");
emit("t4", "app-only reply", "substack");
await settle();
assert.deepEqual(synthesized, [], "an app-started turn is not the trunk conversation");

// ...but a trunk emit in that turn is still visible in the trunk chat.
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
emit("t8", "legacy config reply", "substack");
await settle();
assert.deepEqual(synthesized, ["legacy config reply"]);

console.log("autospeak: ok");
