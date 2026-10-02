// CORS-enabled smart-HTTP git server for the browser target.
//
//   node scripts/git-server.mjs [projectRoot] 
//
// Fronts `git http-backend` so a browser (isomorphic-git) can clone/fetch a
// local bare repo — which `git daemon` (git://) cannot serve to a browser.
//
//   git-server.mjs /home/love
//   -> http://127.0.0.1:8790/grandma-workspace.git
//
// Enable push for a repo with:  git -C <repo>.git config http.receivepack true
// (loopback-only; add auth before exposing it).
import http from "node:http";
import { spawn } from "node:child_process";

const ROOT = process.argv[2] ?? process.env.GIT_PROJECT_ROOT ?? process.cwd();
const PORT = Number(process.env.GIT_PORT ?? 8790);

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-expose-headers": "content-type",
};

function parseCgi(head) {
  let status = 200;
  const headers = {};
  for (const line of head.split("\r\n")) {
    if (!line) continue;
    const statusMatch = line.match(/^Status:\s*(\d+)/i);
    if (statusMatch) {
      status = Number(statusMatch[1]);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers };
}

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const [pathname, query = ""] = (req.url ?? "/").split("?");
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: pathname,
      QUERY_STRING: query,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: req.headers["content-length"] ?? "",
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
    };
    const child = spawn("git", ["http-backend"], { env });
    let buffer = Buffer.alloc(0);
    let parsed = false;
    child.stdout.on("data", (chunk) => {
      if (parsed) {
        res.write(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      parsed = true;
      const { status, headers } = parseCgi(buffer.slice(0, split).toString("utf8"));
      res.writeHead(status, { ...headers, ...cors });
      const rest = buffer.slice(split + 4);
      if (rest.length) res.write(rest);
    });
    req.pipe(child.stdin);
    child.on("close", () => res.end());
    child.stderr.on("data", (d) => process.stderr.write(d));
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`git-http (CORS) on http://127.0.0.1:${PORT}/  root=${ROOT}`);
  });
