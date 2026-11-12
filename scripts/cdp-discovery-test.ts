/**
 * The loopback CDP discovery route.
 *
 * Chrome's /json/version is CORS-gated, so the worker cannot read it. The
 * bridge route probes it server-side and returns the current browser websocket
 * to an allowed app origin. Deterministic: a fake Chrome and the real handler
 * on loopback, no network.
 *
 * Run: `npm run test:cdp-discovery`.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { handleCdpDiscovery } from "../src/cdp-discovery.ts";

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
      else reject(new Error("no server port"));
    });
  });

const close = (server: http.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const FRESH = "ws://127.0.0.1:9222/devtools/browser/fresh-after-restart";
const fakeChrome = http.createServer((req, res) => {
  if (req.url !== "/json/version") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ Browser: "Chrome/test", webSocketDebuggerUrl: FRESH }));
});
const chromePort = await listen(fakeChrome);

const bridge = http.createServer((req, res) => {
  void handleCdpDiscovery(req, res, {
    allowedOrigins: ["https://app.example"],
    port: chromePort,
    timeoutMs: 500,
  });
});
const bridgePort = await listen(bridge);
const url = `http://127.0.0.1:${bridgePort}/api/browser/cdp`;

try {
  // Allowed origin: current websocket + CORS + no-store.
  const ok = await fetch(url, { headers: { Origin: "https://app.example" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example");
  assert.match(ok.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await ok.json(), {
    ok: true,
    webSocketDebuggerUrl: FRESH,
    browser: "Chrome/test",
  });

  // Preflight: allowed origin gets the CORS headers and no body.
  const preflight = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example");
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

  // A foreign origin is refused before the probe.
  const denied = await fetch(url, { headers: { Origin: "https://evil.example" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  // No Chrome listening: a clear 503, still with CORS so the page can read it.
  await close(fakeChrome);
  const down = await fetch(url, { headers: { Origin: "https://app.example" } });
  assert.equal(down.status, 503);
  assert.equal(down.headers.get("access-control-allow-origin"), "https://app.example");
  const body = (await down.json()) as { ok: boolean; error?: string };
  assert.equal(body.ok, false);
  assert.ok(body.error);
} finally {
  await close(bridge);
  try {
    await close(fakeChrome);
  } catch {
    // already closed
  }
}

console.log("cdp-discovery: allowed origin, preflight, denied origin and Chrome-down all OK");
