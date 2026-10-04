/**
 * Reverse follow — "send to telegram" makes Telegram adopt a web session.
 *
 *   1. Sending the active web session to Telegram binds that Telegram chat to
 *      the web key, posts the transcript, and turns off web-follows-telegram.
 *   2. A later web turn is mirrored to the following Telegram chat.
 *   3. A Telegram-origin turn recorded under the web key lands in the web
 *      session's transcript (remoteTurn* now accepts web keys).
 *   4. Deleting the web session clears the binding.
 *
 * Mock agent + spy telegramNotify, no network. Run: npm run test:telegram-follow
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-tg-follow-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const sent: Array<{ key: string; text: string }> = [];
const usedKeys: string[] = [];
// Streaming checks for the mirrored "again" turn (bug fix: the phone must get
// the user line at turn start and each emit as it is produced, not one batch
// at turn end).
let userLineMirroredBeforeRun: boolean | null = null;
let emitMirroredDuringRun = false;
const mockAgent = () =>
  ({
    sessionKeys: () => ["12345:0"],
    sessionMeta: () => [{ key: "12345:0", updatedAt: Date.now() }],
    hasContinuation: () => false,
    consumesInputDirectly: async () => false,
    sessionRef: () => undefined,
    pinnedVersions: () => [],
    clear() {},
    async run(key: string, content: unknown, onEmit?: (v: unknown) => void) {
      usedKeys.push(key);
      const c = String(content);
      if (c === "again") {
        userLineMirroredBeforeRun = sent.some(
          (s) => s.key === "12345:0" && s.text.includes("\ud83d\udcbb") && s.text.includes("again"),
        );
      }
      if (onEmit) onEmit({ text: "echo:" + c });
      // Let the mirror chain's microtask run before the turn ends.
      await new Promise((r) => setImmediate(r));
      if (c === "again") {
        emitMirroredDuringRun = sent.some((s) => s.key === "12345:0" && s.text.includes("echo:again"));
      }
      return { status: "waiting", continuation: "mock:1" };
    },
  }) as any;

const mod = await import("../src/admin.ts");
const port = await freePort();
const server = mod.startAdmin({
  port,
  workspaceDir: ws,
  agent: mockAgent(),
  telegramNotify: async (key: string, text: string) => {
    sent.push({ key, text });
  },
});
await events.once(server, "listening");

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function waitDone(turnId: string) {
  for (let i = 0; i < 100; i++) {
    const s = await api("GET", "/api/session");
    const t = (s.json.turns || []).find((x: any) => x.turnId === turnId);
    if (t && t.status !== "running") return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("turn never finished");
}

try {
  // Private web chat (turns web-follows-telegram off and mints a web key).
  const fresh = await api("POST", "/api/session", { new: true });
  const webKey: string = fresh.json.active;
  assert.match(webKey, /^web:/, "a web session owns a web: key");

  const chat = await api("POST", "/api/chat", { text: "hi" });
  await waitDone(chat.json.turnId);
  assert.equal(usedKeys.at(-1), webKey, "the web turn ran under its own key");
  assert.ok(!sent.some((s) => s.key === "12345:0"), "no mirror before a binding exists");

  // Send to telegram → bind.
  const send = await api("POST", "/api/send-to-telegram");
  assert.equal(send.status, 200);
  assert.equal(send.json.followWeb, webKey);
  assert.ok(sent.some((s) => s.key === "12345:0" && s.text.includes("transcript")), "transcript posted");
  assert.ok(
    sent.some((s) => s.key === "12345:0" && s.text.includes("follows the web session")),
    "follow notice posted",
  );
  assert.equal(mod.telegramFollowKey("12345:0"), webKey, "telegram adopts the web key");
  assert.equal(mod.webFollowTarget(webKey), "12345:0", "reverse lookup works");

  const s1 = await api("GET", "/api/session");
  assert.equal(s1.json.follow, false, "web-follows-telegram turned off");
  assert.equal(s1.json.active, webKey, "the page stays on its own web session");

  // A later web turn mirrors to the following Telegram chat.
  const before = sent.length;
  const chat2 = await api("POST", "/api/chat", { text: "again" });
  await waitDone(chat2.json.turnId);
  const mirrored = sent.slice(before).filter((s) => s.key === "12345:0");
  assert.ok(mirrored.some((s) => s.text.includes("again")), "web turn mirrored to the phone");
  assert.ok(mirrored.some((s) => s.text.includes("echo:again")), "web reply mirrored too");
  assert.equal(userLineMirroredBeforeRun, true, "user line reached the phone before the run body");
  assert.equal(emitMirroredDuringRun, true, "emit reached the phone before the turn ended (live, not batched)");

  // A Telegram-origin turn recorded under the web key lands in its transcript.
  mod.remoteTurnStart(webKey, "from phone");
  mod.remoteTurnEnd(webKey, "phone reply");
  const s2 = await api("GET", "/api/session");
  const webTurns = s2.json.turns || [];
  assert.equal(webTurns.length, 3, "phone turn recorded in the web session");
  assert.equal(webTurns.at(-1).input, "from phone");
  assert.equal(webTurns.at(-1).output, "phone reply");

  // Deleting the web session drops the binding.
  await api("POST", "/api/session", { delete: webKey });
  assert.equal(mod.telegramFollowKey("12345:0"), undefined, "binding cleared with the session");
  assert.equal(mod.webFollowTarget(webKey), undefined);

  console.log("telegram-follow-test: all assertions passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(ws, { recursive: true, force: true });
}
