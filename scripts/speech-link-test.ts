/**
 * Unit test: the chat UI resolves the paired desktop/server without trusting a
 * stale `window.__bobServer` global, and its offline message names the right
 * transport (direct mailbox vs BobSwap relay).
 *
 * Regression: a phone whose live peer handle had been dropped (or not published
 * yet) kept reporting "the relay link is offline" even though sync was running.
 */
import assert from "node:assert/strict";
import {
  desktopOfflineError,
  desktopSpeechError,
  desktopSpeaker,
  desktopTranscriber,
  liveDesktopPeer,
  serverHandle,
} from "../ui/src/speech-link.js";

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
  clear(): void {
    this.map.clear();
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "location", {
  value: { hostname: "bobkat.hfxaiguy.com" },
  configurable: true,
});

const globals = globalThis as unknown as {
  __bobServer?: unknown;
  __bobGetServer?: () => unknown;
  __bobConnect?: () => Promise<boolean>;
};

/** A paired desktop with both speech surfaces. */
const desktop = {
  synthesize: async () => ({ bytes: new Uint8Array(), ext: ".wav" }),
  transcribe: async () => "hello",
};

// ── the live handle ───────────────────────────────────────────────────────
assert.equal(serverHandle(), null);
assert.equal(desktopSpeaker(), null);
assert.equal(desktopTranscriber(), null);

globals.__bobServer = desktop;
assert.equal(desktopSpeaker(), desktop);
assert.equal(desktopTranscriber(), desktop);

// A transient close deletes the global; the web app's getter still sees the
// live connection. Voice must keep working (the reported phone failure).
delete globals.__bobServer;
globals.__bobGetServer = () => desktop;
assert.equal(serverHandle(), desktop);
assert.equal(desktopSpeaker(), desktop);
assert.equal(desktopTranscriber(), desktop);

// The getter is authoritative even when a stale object is still published.
globals.__bobServer = {};
assert.equal(serverHandle(), desktop);
assert.equal(desktopSpeaker(), desktop);

// ...including when it says there is no live connection at all.
globals.__bobGetServer = () => null;
assert.equal(serverHandle(), null);

// A live link without the speech surface is not "offline".
delete globals.__bobGetServer;
const noSpeech = desktopSpeechError("speak replies").message;
assert.match(noSpeech, /connected but did not expose speech/);
assert.doesNotMatch(noSpeech, /offline/);

// A reconnect publishes a fresh global; the retry returns it.
delete globals.__bobServer;
let connects = 0;
globals.__bobConnect = async () => {
  connects += 1;
  globals.__bobServer = desktop;
  return true;
};
assert.equal(await liveDesktopPeer(desktopSpeaker), desktop);
assert.equal(connects, 1);
assert.equal(await liveDesktopPeer(desktopSpeaker), desktop);
assert.equal(connects, 1); // the live handle skips the retry

// ── offline wording ───────────────────────────────────────────────────────
// A direct mailbox pairing on a remote (phone) page is not a relay link.
storage.setItem("bob:server:default", JSON.stringify({ relay: false }));
const direct = desktopOfflineError("speak replies").message;
assert.match(direct, /desktop link is offline/);
assert.doesNotMatch(direct, /relay link/);

// A real relay pairing keeps the re-pair hint, and no longer claims the relay
// is single-session (it renews now).
storage.setItem("bob:server:default", JSON.stringify({ relay: true }));
const relay = desktopOfflineError("speak replies").message;
assert.match(relay, /relay-paired desktop is offline/);
assert.match(relay, /npm run pair -- --relay/);
assert.doesNotMatch(relay, /single-session/);

// The device link is written with every pairing and wins over profile keys.
storage.setItem("bob:server:default", JSON.stringify({ relay: false }));
storage.setItem("bob:server:device", JSON.stringify({ relay: true }));
assert.match(desktopOfflineError("speak replies").message, /relay-paired desktop/);
storage.removeItem("bob:server:device");

// Unpaired remote pages learn both supported paths.
storage.removeItem("bob:server:default");
delete globals.__bobServer;
delete globals.__bobConnect;
const unpaired = desktopOfflineError("transcribe audio").message;
assert.match(unpaired, /not paired/);
assert.match(unpaired, /direct mailbox/);
assert.match(unpaired, /BobSwap relay/);

console.log("speech-link: ok");
