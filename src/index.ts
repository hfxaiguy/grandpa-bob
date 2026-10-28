/**
 * Telegram channel — the standalone-only entry point.
 *
 * Two jobs, no brain:
 *   1. grammY long-polls Telegram (auth gate, forum topics), transcribes
 *      voice channel-side, and *parks* every message in the mailbox file
 *      (src/telegram-bridge.ts). Node never runs the agent.
 *   2. A loopback HTTP API for the browser tab: the tab announces which
 *      profile owns which chats, heartbeats, drains parked messages, and
 *      relays completed turn text back to the phone.
 *
 * With no tab connected, messages wait in the mailbox — they survive channel
 * restarts. The relay drops text carrying a stale epoch, so a suspended old
 * tab cannot answer after another profile claimed the chat.
 *
 * Endpoints (loopback only; CORS is an origin allow-list):
 *   GET  /healthz                 {ok, bot}
 *   POST /api/host/announce       {profile, chats}    → claim chats
 *   POST /api/host/beat           {profile, chats}    → refresh liveness
 *   GET  /api/inbox?profile=P     parked messages for P's chats (+ answered ids)
 *   POST /api/ack                 {conv, ids}         → drained
 *   POST /api/relay               {key, text, epoch}  → phone
 *   POST /api/typing              {key}               → chat action
 */
import http, { type OutgoingHttpHeaders } from "node:http";
import { config } from "./config.js";
import { createBot, sendChannelText } from "./bot.js";
import { checkStt } from "./stt.js";
import { telegramHtml, telegramRichHtml } from "./util/telegram-text.js";
import {
  BRIDGE_LINKED_TEXT,
  beatProfile,
  bindingProfile,
  bindingsFor,
  bridgeEpoch,
  claimPending,
  startSweep,
  ackMessages,
  answeredIds,
} from "./telegram-bridge.js";

const PORT = Number(process.env.BOB_TELEGRAM_PORT || "8091");
const HOST = "127.0.0.1";
/** Browser origins allowed to call the channel API (comma-separated). */
const ALLOWED_ORIGINS = (process.env.BOB_APP_ORIGINS ?? "http://localhost:8080,http://127.0.0.1:8080")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

const MAX_BODY = 1024 * 1024;

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
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new Error("invalid JSON body");
}

/** Split "chatId:threadId" (thread optional). */
function parseConvKey(key: string): { chatId: number; threadId: number } | null {
  const m = /^(-?\d+)(?::(\d+))?$/.exec(key.trim());
  if (!m) return null;
  return { chatId: Number(m[1]), threadId: m[2] ? Number(m[2]) : 0 };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

function main(): void {
  const bot = createBot({
    token: config.telegramToken,
    allowedUserIds: config.allowedUserIds,
    tmpDir: config.tmpDir,
    sttBackend: config.sttBackend,
    whisperUrl: config.whisperUrl,
    sherpaUrl: config.sherpaUrl,
    sttLanguage: config.sttLanguage,
  });

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin ?? "";
    const allowed = ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""));
    const headers: OutgoingHttpHeaders = {
      "content-type": "application/json",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (allowed) headers["access-control-allow-origin"] = origin;
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const finish = (status: number, body: unknown): void => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, error: string): void => finish(status, { error });

    try {
      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/healthz") {
        let botName: string | null = null;
        try {
          const me = await bot.api.getMe();
          botName = `@${me.username}`;
        } catch {
          botName = null; // Telegram down or token invalid; channel still serves
        }
        return finish(200, { ok: true, bot: botName });
      }

      if (req.method === "GET" && pathname === "/api/inbox") {
        const profile = asString(url.searchParams.get("profile"));
        if (!profile) return fail(400, "profile required");
        const claim = await claimPending(profile);
        // Tell the phone once per newly claimed chat that the tab took over.
        for (const conv of claim.claimed) {
          const parts = parseConvKey(conv);
          if (!parts) continue;
          await sendChannelText(bot, parts.chatId, parts.threadId, BRIDGE_LINKED_TEXT).catch(() => {});
        }
        return finish(200, claim);
      }

      if (req.method === "POST" && pathname === "/api/host/beat") {
        const body = parseJson(await readBody(req));
        const profile = asString(body.profile);
        if (!profile) return fail(400, "profile required");
        await beatProfile(profile);
        return finish(200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/bindings") {
        const profile = asString(url.searchParams.get("profile"));
        if (!profile) return fail(400, "profile required");
        return finish(200, { bindings: await bindingsFor(profile) });
      }

      if (req.method === "POST" && pathname === "/api/ack") {
        const body = parseJson(await readBody(req));
        const conv = asString(body.conv);
        const ids = asNumberArray(body.ids);
        if (!conv) return fail(400, "conv required");
        await ackMessages(conv, ids);
        return finish(200, { ok: true });
      }

      if (req.method === "POST" && pathname === "/api/relay") {
        const body = parseJson(await readBody(req));
        const key = asString(body.key);
        const text = asString(body.text);
        const epoch = typeof body.epoch === "number" ? body.epoch : null;
        const profile = asString(body.profile);
        if (!key) return fail(400, "key required");
        if (text == null) return fail(400, "text required");
        const parts = parseConvKey(key);
        if (!parts) return fail(400, "key must be chatId:threadId");
        // Ownership + epoch guards: a chat re-claimed by a different profile
        // bumps its epoch; a suspended old tab relaying late would duplicate
        // answers the new owner already gave.
        if (profile) {
          const owner = await bindingProfile(key);
          if (owner && owner !== profile) {
            return finish(200, { ok: false, dropped: "chat moved to another profile" });
          }
        }
        if (epoch !== null && epoch < (await bridgeEpoch(key))) {
          return finish(200, { ok: false, dropped: "stale epoch" });
        }
        await sendChannelText(bot, parts.chatId, parts.threadId, text);
        return finish(200, { ok: true });
      }

      if (req.method === "POST" && pathname === "/api/typing") {
        const body = parseJson(await readBody(req));
        const key = asString(body.key);
        if (!key) return fail(400, "key required");
        const parts = parseConvKey(key);
        if (!parts) return fail(400, "key must be chatId:threadId");
        const opts = parts.threadId ? { message_thread_id: parts.threadId } : {};
        await bot.api.sendChatAction(parts.chatId, "typing", opts).catch(() => {});
        return finish(200, { ok: true });
      }

      return fail(404, "not found");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        console.warn("[channel] request failed after headers:", msg);
        res.end();
        return;
      }
      return fail(400, msg);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[channel] telegram API on http://${HOST}:${PORT} (loopback only)`);
    console.log(`[channel] allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  });

  startSweep();

  process.once("SIGINT", () => {
    bot.stop();
    server.close();
  });
  process.once("SIGTERM", () => {
    bot.stop();
    server.close();
  });

  void bot.start({
    onStart: (me) => {
      console.log(`[channel] telegram up as @${me.username} — parking messages, no agent`);
      void checkStt(config.sttBackend, config.whisperUrl, config.sherpaUrl).then((ok) => {
        if (!ok) {
          console.warn(
            `[channel] ${config.sttBackend}-server not reachable at ${config.whisperUrl} — voice messages will fail`,
          );
        }
      });
    },
  });
}

main();
