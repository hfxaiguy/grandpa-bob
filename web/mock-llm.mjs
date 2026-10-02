// Minimal OpenAI-compatible mock LLM with CORS, for the browser smoke test.
// Enforces `Authorization: Bearer test-key` so the smoke proves models.json
// `${ENV}` interpolation reached the request.
import http from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8787);
const KEY = "test-key";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cross-origin-resource-policy": "cross-origin",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.url === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model" }] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad api key" } }));
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const last = parsed.messages?.at?.(-1)?.content ?? "";
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: `llm-says: ${last}` }, finish_reason: "stop" }],
        }),
      );
    });
    return;
  }
  res.writeHead(404, cors);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock-llm on http://127.0.0.1:${PORT}`));
