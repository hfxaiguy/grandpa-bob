/**
 * ✈ telegram after a restart.
 *
 * A bot restart drops the in-memory Telegram sessions (`sessions.json` keeps
 * only what was live at the time), but a chat linked by an earlier
 * "send to telegram" is remembered in `logs/web-settings.json`. The button
 * must still find that linked chat instead of refusing with
 * "no telegram chat linked yet — message the bot on Telegram first".
 *
 * Pre-seeds the binding, then starts the admin with a mock agent that knows
 * of NO live Telegram session. No network.
 * Run: npm run test:telegram-follow-restart
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-tg-restart-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
// A previous run's binding survives on disk; no Telegram session is live in
// this process (the agent only ever sees the web session it mints).
await fs.writeFile(
  path.join(ws, "logs", "web-settings.json"),
  JSON.stringify({ followTelegram: false, telegramFollow: { "99999:0": "web:seed" } }),
);

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
const mockAgent = () =>
  ({
    sessionKeys: () => [],
    sessionMeta: () => [], // no live Telegram conversation after the restart
    hasContinuation: () => false,
    consumesInputDirectly: async () => false,
    sessionRef: () => undefined,
    pinnedVersions: () => [],
    clear() {},
    async run(_key: string, content: unknown, onEmit?: (v: unknown) => void) {
      if (onEmit) onEmit({ text: "echo:" + String(content) });
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
  // A fresh web chat with a turn — the state you'd be in after restarting and
  // picking/starting a session before touching Telegram.
  const fresh = await api("POST", "/api/session", { new: true });
  const webKey: string = fresh.json.active;
  assert.match(webKey, /^web:/, "a web session owns a web: key");
  assert.equal(mod.webFollowTarget(webKey), undefined, "this web session is not the bound one");

  const chat = await api("POST", "/api/chat", { text: "after restart" });
  await waitDone(chat.json.turnId);
  assert.equal(sent.length, 0, "nothing is mirrored before an explicit send");

  // Send to telegram → the persisted linked chat is used, not refused.
  const send = await api("POST", "/api/send-to-telegram");
  assert.equal(send.status, 200, "send succeeds with a persisted linked chat and no live telegram session");
  assert.equal(send.json.key, "99999:0", "the persisted chat is the target");
  assert.ok(
    sent.some((s) => s.key === "99999:0" && s.text.includes("after restart")),
    "transcript posted to the persisted chat",
  );
  assert.equal(mod.webFollowTarget(webKey), "99999:0", "the web session adopts the persisted chat");

  console.log("telegram-follow-restart-test: all assertions passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(ws, { recursive: true, force: true });
}
