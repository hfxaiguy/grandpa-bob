/**
 * HTTP surface for the peer server: the BobSwap-shaped mailbox plus the
 * loopback admin API used by `npm run pair`. Mounted by the combined channel
 * process before the Telegram/bridge handlers.
 *
 * Only signaling (SDP/ICE) and admin control travel here; workspace data stays
 * on the DTLS datachannel.
 */
import { createHash } from "node:crypto";
import type http from "node:http";
import { adminKey, readPeers, sameSecret, type PeerCapabilities } from "./store.js";
import { Mailbox, sha256 } from "./mailbox.js";
import { PeerManager } from "./peer.js";

const MAX_BODY = 2 * 1024 * 1024;
const PROFILE_RE = /^[a-z0-9._-]{1,64}$/;

export interface PeerServerOptions {
  /** Extra origins allowed to use the mailbox (default: loopback any port). */
  allowedOrigins?: string[];
  /** STUN/TURN servers advertised to browsers (remote deployments). */
  iceServers?: unknown[];
}

export interface PeerServer {
  manager: PeerManager;
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean;
  close(): void;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new Error("invalid JSON body");
}

function bearer(req: http.IncomingMessage): string {
  const auth = String(req.headers.authorization ?? "");
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function originAllowed(origin: string, extra: string[]): boolean {
  if (!origin) return true;
  if (extra.includes(origin.replace(/\/$/, ""))) return true;
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function configurePeerServer(options: PeerServerOptions = {}): Promise<PeerServer> {
  const mailbox = new Mailbox();
  const iceServers = Array.isArray(options.iceServers) ? options.iceServers : [];
  const manager = new PeerManager(mailbox, iceServers);
  const extraOrigins = (options.allowedOrigins ?? []).map((o) => o.replace(/\/$/, ""));
  // Ensure the secrets exist before the CLI tries to read them.
  await adminKey();

  const headersFor = (
    req: http.IncomingMessage,
    options: { allowRejectedOrigin?: boolean } = {},
  ): Record<string, string> => {
    const origin = String(req.headers.origin ?? "");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-bob-profile,x-bob-admin",
      "cache-control": "no-store",
    };
    if (origin) {
      headers.vary = "origin";
      if (options.allowRejectedOrigin || originAllowed(origin, extraOrigins)) {
        headers["access-control-allow-origin"] = origin;
      }
    }
    return headers;
  };

  const send = (req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, headersFor(req));
    res.end(JSON.stringify(body));
  };

  const loopbackRequest = (req: http.IncomingMessage): boolean => {
    const addr = req.socket.remoteAddress ?? "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  };
  const adminAuth = async (req: http.IncomingMessage): Promise<boolean> => {
    if (!loopbackRequest(req)) return false;
    const provided = String(req.headers["x-bob-admin"] ?? bearer(req));
    if (!provided) return false;
    return sameSecret(provided, await adminKey());
  };

  const handle = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean => {
    const pathname = url.pathname;
    const isMailbox = pathname === "/api/v1/sync/channels" || pathname.startsWith("/api/v1/sync/channels/");
    const isAdmin = pathname === "/admin/pairing" || pathname.startsWith("/admin/pairing/") ||
      pathname === "/admin/peers" || pathname.startsWith("/admin/peers/");
    if (!isMailbox && !isAdmin) return false;

    const origin = String(req.headers.origin ?? "");
    if (isMailbox && !originAllowed(origin, extraOrigins) && req.method !== "OPTIONS") {
      // Answer the preflight (below) and reflect this origin on the rejection
      // so the page can show "origin not allowed" instead of Firefox's opaque
      // CORS `NetworkError`. No mailbox data is served to a rejected origin.
      console.warn(
        `[peer] mailbox origin rejected: ${origin || "(none)"} — ` +
          "open the app from localhost/127.0.0.1 or add it to BOB_APP_ORIGINS",
      );
      res.writeHead(403, headersFor(req, { allowRejectedOrigin: true }));
      res.end(
        JSON.stringify({
          error:
            `origin ${origin || "(none)"} is not allowed — open the app at ` +
            "http://localhost:8080 or http://127.0.0.1:8080, or add it to BOB_APP_ORIGINS",
        }),
      );
      return true;
    }
    if (isAdmin && origin) {
      // The CLI sends no Origin. A browser page must never reach the admin API.
      send(req, res, 403, { error: "admin API is CLI-only" });
      return true;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, headersFor(req, { allowRejectedOrigin: true }));
      res.end();
      return true;
    }

    void (async () => {
      try {
        const body = ["POST", "PUT"].includes(req.method ?? "") ? parseJson(await readBody(req)) : {};

        // ── admin: pairing sessions ───────────────────────────────────────
        if (isAdmin) {
          if (!(await adminAuth(req))) return send(req, res, 401, { error: "admin key required" });
          const parts = pathname.split("/").filter(Boolean); // admin, pairing|peers, id, action
          if (parts[1] === "pairing" && req.method === "POST" && !parts[2]) {
            const profile = String(body.profile ?? "").trim();
            if (!PROFILE_RE.test(profile)) return send(req, res, 400, { error: "invalid profile name" });
            const capabilities: Partial<PeerCapabilities> = {
              mirror: typeof body.mirror === "string" ? body.mirror : undefined,
              mirrorPath: typeof body.mirrorPath === "string" ? body.mirrorPath : undefined,
              exec: Array.isArray(body.exec) ? body.exec.map(String) : [],
            };
            const info = await manager.createPairing(profile, capabilities);
            return send(req, res, 200, info);
          }
          if (parts[1] === "pairing" && parts[2] && parts[3] === "events" && req.method === "GET") {
            const view = manager.view(parts[2]);
            if (!view) return send(req, res, 404, { error: "unknown pairing session" });
            const after = Number(url.searchParams.get("after") ?? "-1");
            return send(req, res, 200, { ...view, events: view.events.filter((e) => e.seq > after) });
          }
          if (parts[1] === "pairing" && parts[2] && parts[3] === "approve" && req.method === "POST") {
            manager.approve(parts[2], body.approve !== false);
            return send(req, res, 200, { ok: true });
          }
          if (parts[1] === "pairing" && parts[2] && parts[3] === "deny" && req.method === "POST") {
            manager.approve(parts[2], false);
            return send(req, res, 200, { ok: true });
          }
          if (parts[1] === "peers" && req.method === "GET" && !parts[2]) {
            const peers = await manager.peers();
            return send(req, res, 200, { peers });
          }
          if (parts[1] === "peers" && parts[2] && parts[3] === "revoke" && req.method === "POST") {
            await manager.revoke(parts[2]);
            return send(req, res, 200, { ok: true });
          }
          return send(req, res, 404, { error: "not found" });
        }

        // ── mailbox ───────────────────────────────────────────────────────
        if (pathname === "/api/v1/sync/channels" && req.method === "POST") {
          const profile = String(req.headers["x-bob-profile"] ?? "").trim();
          const clientKey = bearer(req);
          if (!PROFILE_RE.test(profile) || !clientKey) {
            return send(req, res, 401, { error: "profile and client key required" });
          }
          const record = (await readPeers()).peers[profile];
          if (!record || !sameSecret(sha256(clientKey), record.keyHash)) {
            return send(req, res, 401, { error: "client key rejected" });
          }
          const reconnect = manager.createReconnect(profile, record);
          return send(req, res, 200, {
            channel_id: reconnect.channelId,
            role_token: reconnect.roleToken,
            role: "offerer",
            ice_servers: iceServers,
          });
        }

        // Single-code join: the browser sends only the 8-digit code; the
        // channel id stays on the server until the response.
        if (pathname === "/api/v1/sync/channels/join" && req.method === "POST") {
          const joined = mailbox.joinByCode(String(body.code ?? ""));
          return send(req, res, 200, {
            channel_id: joined.channel.id,
            role_token: joined.roleToken,
            role: "offerer",
            ice_servers: iceServers,
          });
        }

        // Deprecated for one release: channel-id + code (old clients).
        const join = /^\/api\/v1\/sync\/channels\/([^/]+)\/join$/.exec(pathname);
        if (join && req.method === "POST") {
          const code = String(body.code ?? "");
          const profile = String(body.profile ?? "").trim();
          if (!PROFILE_RE.test(profile)) return send(req, res, 400, { error: "invalid profile name" });
          const joined = mailbox.join(join[1], code, profile);
          return send(req, res, 200, {
            role_token: joined.roleToken,
            role: "offerer",
            ice_servers: iceServers,
          });
        }

        const signal = /^\/api\/v1\/sync\/channels\/([^/]+)\/signal$/.exec(pathname);
        if (signal) {
          const channel = mailbox.get(signal[1]);
          if (!channel) return send(req, res, 404, { error: "unknown channel" });
          const side = mailbox.sideFor(channel, bearer(req));
          if (!side) return send(req, res, 401, { error: "invalid role token" });
          if (req.method === "GET") {
            const after = Number(url.searchParams.get("after") ?? "0");
            return send(req, res, 200, mailbox.feed(channel, Number.isFinite(after) ? after : 0));
          }
          if (req.method === "PUT") {
            const type = String(body.type ?? "");
            if (!type) return send(req, res, 400, { error: "signal type required" });
            const payload =
              body.payload && typeof body.payload === "object"
                ? (body.payload as Record<string, unknown>)
                : {};
            const entry = mailbox.append(channel, side, type, payload);
            return send(req, res, 200, { ok: true, seq: entry.seq });
          }
        }

        return send(req, res, 404, { error: "not found" });
      } catch (err) {
        send(req, res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  };

  return {
    manager,
    handle,
    close() {
      mailbox.closeAll();
    },
  };
}

/** Unused helper kept explicit: sha256 of a client key for auth comparisons. */
export function clientKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
