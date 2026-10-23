/**
 * The web upload / transcription endpoints the tiled UI calls.
 *
 *   1. POST /api/chat/upload saves the file as an attachment (into the
 *      workspace's assets/inbox) and enqueues a turn.
 *   2. POST /api/transcribe and /api/transcribe-stream answer 503 when no STT
 *      backend is configured — the UI surfaces that as a toast.
 *
 * Mock agent + real admin HTTP API. Run: npm run test:upload-endpoint
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { startAdmin } from "../src/admin.js";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-upload-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

const mockAgent = () =>
  ({
    sessionKeys: () => [],
    sessionMeta: () => [],
    hasContinuation: () => false,
    consumesInputDirectly: async () => false,
    clear() {},
    async run() {
      return { status: "waiting", continuation: "mock" };
    },
    modelSlots: () => [],
    sessionModel: () => undefined,
    sessionModelMap: () => ({}),
  }) as any;

const port = await freePort();
const server = startAdmin({
  port,
  workspaceDir: ws,
  projectDir: ws,
  envPath: path.join(ws, "absent.env"),
  agent: mockAgent(),
});
await events.once(server, "listening");

const base = `http://127.0.0.1:${port}`;

// A session must be active for /api/chat/upload to enqueue a turn.
{
  const s = await (await fetch(`${base}/api/session`)).json();
  assert.ok(s.active, "first boot opens a session");
}

// ── 1. upload saves an attachment and returns a turn id ──
{
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/pdf" }), "note.pdf");
  fd.append("caption", "please read this");
  const res = await fetch(`${base}/api/chat/upload`, { method: "POST", body: fd });
  assert.equal(res.status, 200, "upload accepted");
  const j = (await res.json()) as { turnId?: string; attachment?: { path?: string } };
  assert.ok(j.turnId, "a turn id is returned");
  assert.match(String(j.attachment?.path), /^assets\/inbox\//, "the file lands under assets/inbox");
  const saved = await fs.readFile(path.join(ws, String(j.attachment!.path)));
  assert.equal(saved.length, 4, "the uploaded bytes are on disk");
  console.log("1. /api/chat/upload saves an attachment and enqueues a turn");
}

// ── 2. an oversized / missing file is refused ──
{
  const fd = new FormData();
  const res = await fetch(`${base}/api/chat/upload`, { method: "POST", body: fd });
  assert.equal(res.status, 400, "no file → 400");
  console.log("2. an upload with no file is refused");
}

// ── 3. transcription needs an STT backend ──
for (const p of ["/api/transcribe", "/api/transcribe-stream"]) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array([1])], { type: "audio/webm" }), "v.webm");
  const res = await fetch(`${base}${p}`, { method: "POST", body: fd });
  assert.equal(res.status, 503, `${p} → 503 without STT`);
  const j = (await res.json()) as { error?: string };
  assert.match(String(j.error), /STT/, `${p} names the missing backend`);
}
console.log("3. transcribe endpoints report the missing STT backend");

server.close();
console.log("upload-endpoint-test: all assertions passed");
