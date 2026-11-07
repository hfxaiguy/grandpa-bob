/**
 * The chat UI's bridge to the paired desktop/server for speech.
 *
 * The web target publishes its live `ServerConnection` on `window.__bobServer`
 * and a live getter on `window.__bobGetServer`. The getter is authoritative:
 * a closed connection may delete the global, and a boot-time reconnect may
 * publish late — neither should make a working link look offline.
 */

export interface DesktopTranscriber {
  transcribe(
    audio: Uint8Array,
    ext: string,
    provider?: string,
    apiKey?: string,
    language?: string,
  ): Promise<string>;
}

export interface DesktopSpeaker {
  synthesize(
    text: string,
    voice?: string,
    apiKey?: string,
    provider?: string,
  ): Promise<{ bytes: Uint8Array; ext: string }>;
}

interface BobGlobals {
  __bobServer?: unknown;
  __bobGetServer?: () => unknown;
  __bobConnect?: () => Promise<boolean>;
}

/**
 * The live desktop handle. The web app's getter is authoritative (it reads the
 * module state, so a stale `window.__bobServer` cannot shadow a reconnected
 * peer); a standalone UI page without a getter falls back to the global.
 */
export function serverHandle(): Record<string, unknown> | null {
  const globals = globalThis as unknown as BobGlobals;
  if (typeof globals.__bobGetServer === "function") {
    try {
      const live = globals.__bobGetServer();
      return live && typeof live === "object" ? (live as Record<string, unknown>) : null;
    } catch {
      /* fall through to the global */
    }
  }
  const server = globals.__bobServer;
  return server && typeof server === "object" ? (server as Record<string, unknown>) : null;
}

export function desktopTranscriber(): DesktopTranscriber | null {
  const server = serverHandle();
  return server && typeof server.transcribe === "function"
    ? (server as unknown as DesktopTranscriber)
    : null;
}

export function desktopSpeaker(): DesktopSpeaker | null {
  const server = serverHandle();
  return server && typeof server.synthesize === "function"
    ? (server as unknown as DesktopSpeaker)
    : null;
}

/**
 * A live desktop handle, or a reconnected one. The pairing survives a channel
 * restart in localStorage, but the peer handle is only set once resume
 * succeeds — so try the one reconnect the web app exposes before giving up.
 */
export async function liveDesktopPeer<T>(get: () => T | null): Promise<T | null> {
  const existing = get();
  if (existing) return existing;
  const connect = (globalThis as unknown as BobGlobals).__bobConnect;
  if (typeof connect !== "function") return null;
  try {
    await connect();
  } catch {
    /* stays offline; the caller reports it */
  }
  return get();
}

interface StoredServerLink {
  relay: boolean;
}

/** The remembered desktop pairing, if any. Only the error message needs it. */
export function storedServerLink(): StoredServerLink | null {
  try {
    // `saveServerLink` writes the device link for every pairing, so it is the
    // newest; fall back to a profile key for links written before that.
    let raw = localStorage.getItem("bob:server:device");
    if (!raw) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("bob:server:")) continue;
        raw = localStorage.getItem(key);
        if (raw) break;
      }
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { relay?: unknown };
    return { relay: parsed.relay === true };
  } catch {
    /* private mode: treat as unpaired */
  }
  return null;
}

/** Distinguish "never paired" from "paired but the link is down". */
export function desktopOfflineError(purpose: "transcribe audio" | "speak replies"): Error {
  const link = storedServerLink();
  let remote = false;
  try {
    remote = !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
  } catch {
    /* no location (tests) */
  }
  if (link) {
    // A direct mailbox pairing from a phone/laptop is not a relay link: only
    // name the relay when the stored pairing actually used it.
    if (link.relay) {
      return new Error(
        "the relay-paired desktop is offline — the BobSwap session may have ended. On the desktop run `npm run pair -- --relay` for a new code, then pair again here; keep this tab open",
      );
    }
    return new Error(
      remote
        ? "the desktop link is offline — the pairing is stored but the channel is not up. Reconnect in Sync… → Pair… or reload the tab; if the desktop restarted, run `npm run pair` again"
        : "the desktop link is offline — the channel may have restarted. Reconnect in Sync… → Pair… or reload the tab; if another tab is hosting this workspace, take over there first",
    );
  }
  return new Error(
    remote
      ? "this browser is not paired — on a remote page use Sync… → Pair… with the desktop (direct mailbox or BobSwap relay, code from `npm run pair` on the desktop)"
      : `this device is not paired with a desktop — pair one in Sync… → Pair… to ${purpose}`,
  );
}

/** Why the voice surface is unavailable: an offline link, or a live link that
 *  does not expose speech (an older page). Never report "offline" when the
 *  connection is actually there — that is the misleading phone message. */
export function desktopSpeechError(purpose: "transcribe audio" | "speak replies"): Error {
  if (serverHandle()) {
    return new Error(
      "the paired desktop is connected but did not expose speech — reload this tab; if it persists, update the desktop app",
    );
  }
  return desktopOfflineError(purpose);
}
