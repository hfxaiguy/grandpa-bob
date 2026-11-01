/**
 * Browser side of the desktop/server peer link.
 *
 * First pairing: a mailbox channel created by `npm run pair` on the server;
 * the tab joins with the code, creates the RTC offer, verifies the SAS with
 * the operator, receives the per-profile client key + pinned server key, and
 * attaches the same SyncEngine peer as any other replica.
 *
 * Reconnect: the tab asks the mailbox for a channel with its client key,
 * proves possession of it, verifies the server's proof, and attaches again —
 * no human step. Credentials are stored per browser profile.
 */
import { BobSwapSignaling, rtcPeer, toIceServers } from "./sync/transport-webrtc";
import { controlEnvelope, controlPeer } from "./sync/control-peer";
import type { SyncPeer } from "./sync/engine";
import { sha256hex } from "./platform/sha256";

export interface ServerLinkInfo {
  url: string;
  profile: string;
  clientKey: string;
  /** Per-profile server proof key (pinned; not the server master key). */
  serverKey: string;
  fingerprint: string;
  mirror: string;
  exec: string[];
  pairedAt: string;
}

export interface ServerOpResult {
  output?: string;
  error?: string;
  changed?: string[];
  changedCount?: number;
}

export interface ServerConnection {
  peer: SyncPeer;
  info: ServerLinkInfo;
  /** Run an allowlisted executable on the desktop/server. */
  run(binary: string, args: string[], timeoutMs?: number): Promise<ServerOpResult>;
  close(): void;
}

interface JoinResponse {
  channel_id: string;
  role_token: string;
  role?: string;
  ice_servers?: unknown[];
}

type Control = Record<string, unknown>;

const LINK_KEY = (profile: string): string => `bob:server:${profile}`;

/** First pairing with a non-empty server folder replaces the tab's copy. */
async function clearProfileWorkspace(profile: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const profiles = await root.getDirectoryHandle("profiles");
    const dir = await profiles.getDirectoryHandle(profile);
    await dir.removeEntry("workspace", { recursive: true });
  } catch {
    /* empty/new profile: nothing to replace */
  }
}

export function loadServerLink(profile: string): ServerLinkInfo | null {
  try {
    const raw = localStorage.getItem(LINK_KEY(profile));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ServerLinkInfo>;
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.clientKey !== "string" ||
      typeof parsed.serverKey !== "string" ||
      typeof parsed.fingerprint !== "string"
    ) {
      return null;
    }
    return {
      url: parsed.url,
      profile,
      clientKey: parsed.clientKey,
      serverKey: parsed.serverKey,
      fingerprint: parsed.fingerprint,
      mirror: typeof parsed.mirror === "string" ? parsed.mirror : profile,
      exec: Array.isArray(parsed.exec) ? parsed.exec.filter((x): x is string => typeof x === "string") : [],
      pairedAt: typeof parsed.pairedAt === "string" ? parsed.pairedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveServerLink(link: ServerLinkInfo): void {
  try {
    localStorage.setItem(LINK_KEY(link.profile), JSON.stringify(link));
  } catch {
    /* private mode */
  }
}

export function clearServerLink(profile: string): void {
  try {
    localStorage.removeItem(LINK_KEY(profile));
  } catch {
    /* ignore */
  }
}

function normalizeUrl(url: string): string {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) throw new Error("server URL is required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  } catch {
    throw new Error(`invalid server URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("server URL must be http(s)");
  }
  return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
}

/** Firefox reports connection and CORS failures with the same bare TypeError. */
function failedToFetch(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && /networkerror|failed to fetch|load failed|fetch failed/i.test(err.message))
  );
}

/**
 * Turn a browser-level fetch failure into something the operator can act on.
 * The mailbox binds loopback and only accepts loopback page origins, so the
 * old bare "NetworkError when attempting to fetch resource" hid both the URL
 * and the two realistic causes.
 */
function unreachable(base: string, err: unknown): Error {
  const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
  return new Error(
    `cannot reach ${base}${detail} — is \`npm run bob\` running on this machine? ` +
      "The desktop mailbox is loopback-only; if the browser asks for Local Network Access, " +
      "allow it for this site (Chrome blocks public pages from reaching 127.0.0.1), " +
      "or open the app at http://localhost:8080 or http://127.0.0.1:8080 and check " +
      "http://127.0.0.1:8795/health.",
  );
}

/** The desktop mailbox is code-only too; its join response carries the channel. */
function normalizeRole(role: string | undefined): "offerer" | "answerer" {
  return role === "answerer" || role === "joiner" ? "answerer" : "offerer";
}

async function joinServerChannel(base: string, code: string): Promise<JoinResponse> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/sync/channels/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    throw unreachable(base, err);
  }
  const data = (await res.json().catch(() => ({}))) as JoinResponse & { error?: string };
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `single-code join is not available at ${base} — restart \`npm run bob\`, or use manual pairing`,
      );
    }
    throw new Error(data.error ?? `join failed: HTTP ${res.status}`);
  }
  if (!data.channel_id || !data.role_token) throw new Error("the server did not return a channel or role token");
  return data;
}

async function createReconnectChannel(
  base: string,
  profile: string,
  clientKey: string,
): Promise<{ channel_id: string; role_token: string; role?: string; ice_servers?: unknown[] }> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/sync/channels`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${clientKey}`,
        "x-bob-profile": profile,
      },
      body: "{}",
    });
  } catch (err) {
    throw unreachable(base, err);
  }
  const data = (await res.json().catch(() => ({}))) as {
    channel_id?: string;
    role_token?: string;
    role?: string;
    ice_servers?: unknown[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `reconnect failed: HTTP ${res.status}`);
  if (!data.channel_id || !data.role_token) throw new Error("reconnect answered without a channel");
  return {
    channel_id: data.channel_id,
    role_token: data.role_token,
    role: data.role,
    ice_servers: data.ice_servers,
  };
}

async function hmacHex(keyText: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  let out = "";
  for (const byte of new Uint8Array(signature)) out += byte.toString(16).padStart(2, "0");
  return out;
}

interface Opened {
  peer: SyncPeer;
  phrase: string;
  send: (control: Control) => void;
  setControl: (cb: (control: Control) => void) => void;
  close: () => void;
}

async function openLink(
  url: string,
  channelId: string,
  roleToken: string,
  role: "offerer" | "answerer",
  localId: string,
  onSas: (phrase: string) => void,
  iceServers?: unknown[],
): Promise<Opened> {
  const provider = new BobSwapSignaling({ baseUrl: url }, { id: channelId, roleToken, role });
  const servers = toIceServers(iceServers);
  const { peer, phrase } = await rtcPeer(provider, localId, {
    createChannel: role === "offerer",
    // Loopback/self-hosted: none. A remote mailbox may advertise STUN/TURN.
    iceServers: servers,
  });
  onSas(phrase);
  let controlListener: ((control: Control) => void) | null = null;
  const queued: Control[] = [];
  const link = controlPeer(peer, (control) => {
    if (controlListener) controlListener(control);
    else if (queued.length < 50) queued.push(control);
  });
  return {
    peer: link,
    phrase,
    send: (control) => link.send(controlEnvelope(localId, control)),
    setControl: (cb) => {
      controlListener = cb;
      for (const control of queued.splice(0)) cb(control);
    },
    close: () => {
      controlListener = null;
      link.close();
    },
  };
}

interface HandshakeOptions {
  opened: Opened;
  mode: "pairing" | "resume";
  url: string;
  profile: string;
  info?: ServerLinkInfo;
  onStatus: (text: string) => void;
}

function finishHandshake(opts: HandshakeOptions, info: ServerLinkInfo): ServerConnection {
  const { opened } = opts;
  const pendingOps = new Map<string, (result: ServerOpResult) => void>();
  opts.opened.setControl((control) => {
    if (control.op !== "ops-result") return;
    const id = String(control.id ?? "");
    const resolve = pendingOps.get(id);
    if (!resolve) return;
    pendingOps.delete(id);
    resolve({
      output: typeof control.output === "string" ? control.output : undefined,
      error: typeof control.error === "string" ? control.error : undefined,
      changed: Array.isArray(control.changed) ? control.changed.map(String) : undefined,
      changedCount: typeof control.changedCount === "number" ? control.changedCount : undefined,
    });
  });
  opened.send({ op: "ready" });
  saveServerLink(info);
  return {
    peer: opened.peer,
    info,
    run(binary, args, timeoutMs) {
      const id = crypto.randomUUID();
      const result = new Promise<ServerOpResult>((resolve) => {
        pendingOps.set(id, resolve);
        setTimeout(() => {
          if (!pendingOps.delete(id)) return;
          resolve({ error: "the desktop did not answer the op" });
        }, (timeoutMs ?? 600_000) + 15_000);
      });
      opened.send({ op: "ops-run", id, binary, args, timeoutMs });
      return result;
    },
    close: () => opened.close(),
  };
}

function negotiate(
  opts: HandshakeOptions,
  resolve: (connection: ServerConnection) => void,
  reject: (err: Error) => void,
): void {
  let settled = false;
  let serverNonce = "";
  let clientNonce = "";
  const timer = setTimeout(() => {
    if (!settled) reject(new Error("the server did not finish pairing in time"));
  }, 5 * 60_000);

  const done = (info: ServerLinkInfo): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(finishHandshake(opts, info));
  };

  opts.opened.setControl((control) => {
    const op = String(control.op ?? "");
    if (op === "server") {
      serverNonce = String(control.nonce ?? "");
      const serverProfile = String(control.profile ?? "");
      if (serverProfile && serverProfile !== opts.profile) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `this desktop pairing is for browser profile "${serverProfile}", but this tab is "${opts.profile}" — ` +
              `switch profiles, or rerun \`npm run pair -- --profile ${opts.profile}\``,
          ),
        );
        return;
      }
      const pairing = control.pairing === true;
      if (pairing) {
        const capabilities = (control.capabilities ?? {}) as { mirror?: string; exec?: string[] };
        const exec = Array.isArray(capabilities.exec)
          ? capabilities.exec.filter((x): x is string => typeof x === "string")
          : [];
        opts.onStatus(
          `waiting for approval on the desktop console — mirror ${capabilities.mirror ?? "?"} · exec: ${exec.join(", ") || "none"}`,
        );
      } else {
        void (async () => {
          if (!opts.info) {
            reject(new Error("the server asked to resume but this profile is not paired"));
            return;
          }
          clientNonce = crypto.randomUUID();
          const proof = await hmacHex(sha256hex(opts.info.clientKey), serverNonce);
          opts.opened.send({ op: "resume", profile: opts.profile, proof, clientNonce });
        })().catch(reject);
      }
      return;
    }
    if (op === "paired") {
      const capabilities = (control.capabilities ?? {}) as { mirror?: string; exec?: string[] };
      void (async () => {
        const existing = Number(control.bootstrap ?? 0);
        if (existing > 0) {
          opts.onStatus(`replacing this workspace with the desktop copy (${existing} files)…`);
          await clearProfileWorkspace(opts.profile);
        }
        done({
          url: opts.url,
          profile: opts.profile,
          clientKey: String(control.clientKey ?? ""),
          serverKey: String(control.serverKey ?? ""),
          fingerprint: String(control.fingerprint ?? ""),
          mirror: capabilities.mirror ?? opts.profile,
          exec: Array.isArray(capabilities.exec) ? capabilities.exec.filter((x): x is string => typeof x === "string") : [],
          pairedAt: new Date().toISOString(),
        });
      })().catch(reject);
      return;
    }
    if (op === "resumed") {
      void (async () => {
        if (!opts.info) {
          reject(new Error("unexpected resume success"));
          return;
        }
        const expected = await hmacHex(opts.info.serverKey, clientNonce);
        if (String(control.proof ?? "") !== expected) {
          reject(new Error("server identity check failed"));
          return;
        }
        const capabilities = (control.capabilities ?? {}) as { mirror?: string; exec?: string[] };
        opts.onStatus("reconnected");
        done({
          ...opts.info,
          mirror: capabilities.mirror ?? opts.info.mirror,
          exec: Array.isArray(capabilities.exec)
            ? capabilities.exec.filter((x): x is string => typeof x === "string")
            : opts.info.exec,
        });
      })().catch(reject);
      return;
    }
    if (op === "error") {
      reject(new Error(String(control.message ?? "server error")));
    }
  });

  if (opts.mode === "pairing") {
    opts.opened.send({ op: "hello", profile: opts.profile });
  }
  // Resume waits for the server's `server` frame (it carries the nonce).
}

export async function pairWithServer(opts: {
  url: string;
  code: string;
  profile: string;
  localId: string;
  onSas: (phrase: string) => void;
  onStatus: (text: string) => void;
}): Promise<ServerConnection> {
  const base = normalizeUrl(opts.url);
  opts.onStatus("joining with the code…");
  const joined = await joinServerChannel(base, opts.code);
  opts.onStatus("connecting…");
  let opened: Opened;
  try {
    opened = await openLink(
      base,
      joined.channel_id,
      joined.role_token,
      normalizeRole(joined.role),
      opts.localId,
      opts.onSas,
      joined.ice_servers,
    );
  } catch (err) {
    if (failedToFetch(err)) throw unreachable(base, err);
    if (err instanceof Error && /HTTP 404|session is gone|unknown channel/i.test(err.message)) {
      throw new Error(
        "the desktop pairing session closed — `npm run bob` may have restarted; " +
          "rerun `npm run pair` and use the new code",
      );
    }
    throw err;
  }
  return new Promise<ServerConnection>((resolve, reject) => {
    negotiate(
      { opened, mode: "pairing", url: base, profile: opts.profile, onStatus: opts.onStatus },
      resolve,
      reject,
    );
  });
}

export async function resumeServer(opts: {
  info: ServerLinkInfo;
  localId: string;
  onSas?: (phrase: string) => void;
  onStatus?: (text: string) => void;
}): Promise<ServerConnection> {
  const base = normalizeUrl(opts.info.url);
  opts.onStatus?.("finding the server…");
  const channel = await createReconnectChannel(base, opts.info.profile, opts.info.clientKey);
  let opened: Opened;
  try {
    opened = await openLink(
      base,
      channel.channel_id,
      channel.role_token,
      normalizeRole(channel.role),
      opts.localId,
      opts.onSas ?? (() => {}),
      channel.ice_servers,
    );
  } catch (err) {
    throw failedToFetch(err) ? unreachable(base, err) : err;
  }
  return new Promise<ServerConnection>((resolve, reject) => {
    negotiate(
      {
        opened,
        mode: "resume",
        url: base,
        profile: opts.info.profile,
        info: opts.info,
        onStatus: opts.onStatus ?? (() => {}),
      },
      resolve,
      reject,
    );
  });
}
