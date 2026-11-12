/**
 * Loopback CDP discovery for the browser worker.
 *
 * The worker cannot read Chrome's `/json/version`: that endpoint is CORS-gated.
 * After Chrome restarts, the browser websocket UUID in `?cdp=` is stale, so the
 * page asks this route for the current one. The probe runs server-side.
 *
 * Only app origins in `BOB_APP_ORIGINS` may read it; a browser request from
 * another origin gets a 403 without CORS headers. A non-browser client (curl,
 * tests) carries no Origin and may read it for debugging.
 */
import http from "node:http";

export interface CdpDiscoveryOptions {
  /** Origins allowed to call the route (already normalized, no trailing /). */
  allowedOrigins: string[];
  /** Chrome's remote-debugging HTTP port. Defaults to 9222. */
  port?: number;
  /** Per-probe timeout. Defaults to 2.5s. */
  timeoutMs?: number;
}

export async function handleCdpDiscovery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: CdpDiscoveryOptions,
): Promise<void> {
  const origin = String(req.headers.origin ?? "").replace(/\/$/, "");
  if (origin && !options.allowedOrigins.includes(origin)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "origin not allowed; add it to BOB_APP_ORIGINS" }));
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  // Chrome's Private Network Access preflight for a public page fetching a
  // loopback route. Loopback is already a trustworthy origin, but the header
  // keeps the fetch allowed when PNA enforcement is on.
  if (String(req.headers["access-control-request-private-network"] ?? "") === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "GET only" }));
    return;
  }
  const port = options.port ?? 9222;
  const timeoutMs = options.timeoutMs ?? 2_500;
  try {
    const info = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!info.ok) throw new Error(`Chrome answered HTTP ${info.status}`);
    const body = (await info.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
    const ws = typeof body.webSocketDebuggerUrl === "string" ? body.webSocketDebuggerUrl.trim() : "";
    if (!ws) throw new Error("Chrome reported no webSocketDebuggerUrl");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, webSocketDebuggerUrl: ws, browser: body.Browser ?? null }));
  } catch (err) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  }
}
