// Standalone static server for the browser target: no admin, no bridge, no
// grandpa-bob process. It serves the built app (web/dist) over loopback so
// OPFS and module workers get a secure context; everything else — storage,
// SQL, git, models — lives in the tab.
//
//   npm run build:web        # once, after source changes
//   npm run web:standalone   # http://localhost:8080
//
// PORT and HOST are overridable. The default port is the familiar :8080; if
// the admin is running it already owns that port, so this exits with a hint
// instead of silently picking a different origin (CORS and localStorage are
// origin-scoped).
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "dist");
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), {
    "content-type": "application/json; charset=utf-8",
  });
}

async function readFileOrNull(abs) {
  try {
    const stat = await fs.stat(abs);
    return stat.isFile() ? await fs.readFile(abs) : null;
  } catch {
    return null;
  }
}

async function indexHtml() {
  return readFileOrNull(path.join(root, "index.html"));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method not allowed" });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return sendJson(res, 400, { error: "bad request path" });
  }

  // No admin API in standalone mode. Answer JSON (not the SPA fallback) so the
  // UI shim's native-fetch fallthrough gets an honest 404 instead of HTML.
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return sendJson(res, 404, {
      error: `standalone mode: ${pathname} needs the grandpa-bob admin`,
    });
  }

  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const abs = path.resolve(root, rel);
  // Contain every read to web/dist.
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  const file = await readFileOrNull(abs);
  if (file) {
    const headers = {
      "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      // No stale bundles: a rebuild is picked up on the next reload.
      "cache-control": "no-cache",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "content-length": file.byteLength });
      return res.end();
    }
    return send(res, 200, file, headers);
  }

  // SPA routes (/settings) fall back to index.html. Missing assets stay 404 so
  // a bad bundle reference is visible instead of masquerading as the app.
  const wantsHtml =
    !path.extname(rel) || (req.headers.accept ?? "").includes("text/html");
  if (wantsHtml) {
    const html = await indexHtml();
    if (html) {
      return send(res, 200, html, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      });
    }
  }
  return sendJson(res, 404, { error: `not found: ${pathname}` });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`standalone: port ${port} is already in use.`);
    console.error("  Is the grandpa-bob admin running? Stop it, or use another origin:");
    console.error(`    PORT=${port + 1} npm run web:standalone`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, host, async () => {
  if (!(await indexHtml())) {
    console.error(`standalone: ${path.join(root, "index.html")} is missing.`);
    console.error("  Build the browser target first: npm run build:web");
    server.close();
    process.exit(1);
  }
  console.log(`standalone: http://localhost:${port} (admin API off)`);
  console.log("  models come from this browser's Settings; keys never leave the tab");
});
