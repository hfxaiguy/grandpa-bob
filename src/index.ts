/**
 * BOB's combined channel process — `npm run bob`.
 *
 * One loopback process hosts everything that is not the browser app:
 *   :8080  the built app (web/dist) — static, no admin API
 *   :8795  storage bridge (desktop folders, /fs, /git, /sql, opt-in /stt)
 *          + telegram mailbox/bindings API (shared port, disjoint routes)
 *
 * The Telegram bot is optional: with no TELEGRAM_BOT_TOKEN the process still
 * serves the app, the bridge and the (file-backed) mailbox API; only the bot
 * stays off. A bot loop that dies is retried, never taking the servers down.
 *
 * Node never runs the agent. The browser tab is the host; the telegram API
 * parks messages until a tab claims the chat (src/telegram-bridge.ts):
 *   GET  /healthz                 {ok, bot}
 *   POST /api/host/beat           {profile, chats}    → refresh liveness
 *   GET  /api/inbox?profile=P     parked messages for P's chats (+ answered ids)
 *   POST /api/ack                 {conv, ids}         → drained
 *   POST /api/relay               {key, text, epoch}  → phone
 *   POST /api/typing              {key}               → chat action
 *
 * The storage bridge routes live in web/scripts/storage-server.mjs; the
 * static app server in web/scripts/serve.mjs. Both are mountable modules and
 * keep their own standalone CLIs (`npm run storage-server`, `web:standalone`).
 */
import http, { type OutgoingHttpHeaders } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Bot } from "grammy";
import { config } from "./config.js";
import { createBot, sendChannelText } from "./bot.js";
import { checkStt } from "./stt.js";
import {
  BRIDGE_LINKED_TEXT,
  beatProfile,
  bindingProfile,
  bindingsFor,
  bridgeEpoch,
  claimPending,
  startSweep,
  ackMessages,
} from "./telegram-bridge.js";
/** The plain-ESM channel modules live under web/scripts (node-runnable). */
interface BridgeModule {
  configureStorageBridge(root?: string): string;
  handleStorageRequest(req: http.IncomingMessage, res: http.ServerResponse): void;
}
interface StaticModule {
  staticIndexAvailable(): Promise<boolean>;
  startStaticServer(options?: { port?: number; host?: string }): Promise<{ server: http.Server }>;
}

/**
 * Locate the repo root by walking up from this module. The same file runs as
 * `src/index.ts` (tsx) and `dist/src/index.js` (built), which sit at different
 * depths — a literal relative import can only be right for one of them.
 */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, "web", "scripts", "storage-server.mjs"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cannot locate the repository root (web/scripts is missing)");
}

async function channelModules(): Promise<{ bridge: BridgeModule; serve: StaticModule }> {
  const root = repoRoot();
  const load = <T>(rel: string): Promise<T> =>
    import(pathToFileURL(path.join(root, rel)).href) as Promise<T>;
  return {
    bridge: await load<BridgeModule>(path.join("web", "scripts", "storage-server.mjs")),
    serve: await load<StaticModule>(path.join("web", "scripts", "serve.mjs")),
  };
}

const HOST = "127.0.0.1";
/** One port for both channel APIs (telegram moved here; the bridge never moves). */
const CHANNEL_PORT = Number(process.env.BOB_CHANNEL_PORT ?? process.env.STORAGE_PORT ?? "8795");
const APP_PORT = Number(process.env.PORT ?? "8080");
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

/** Telegram mailbox + relay routes. `bot` is null when no token is configured. */
async function handleTelegram(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  bot: Bot | null,
): Promise<void> {
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
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/healthz") {
      let botName: string | null = null;
      if (bot) {
        try {
          const me = await bot.api.getMe();
          botName = `@${me.username}`;
        } catch {
          botName = null; // Telegram down or token invalid; the channel still serves
        }
      }
      return finish(200, { ok: true, bot: botName });
    }

    if (req.method === "GET" && pathname === "/api/inbox") {
      const profile = asString(url.searchParams.get("profile"));
      if (!profile) return fail(400, "profile required");
      const claim = await claimPending(profile);
      // Tell the phone once per newly claimed chat that the tab took over.
      if (bot) {
        for (const conv of claim.claimed) {
          const parts = parseConvKey(conv);
          if (!parts) continue;
          await sendChannelText(bot, parts.chatId, parts.threadId, BRIDGE_LINKED_TEXT).catch(() => {});
        }
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
      if (!bot) return finish(200, { ok: false, skipped: "telegram bot not configured" });
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
      if (!bot) return finish(200, { ok: true, skipped: "telegram bot not configured" });
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
}

/** Start the bot, retrying forever with a backoff; never crashes the process. */
function startBot(bot: Bot): void {
  const run = async (): Promise<void> => {
    try {
      await bot.start({
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[channel] telegram bot stopped (${msg}) — retrying in 15s`);
      setTimeout(() => void run(), 15_000).unref();
    }
  };
  void run();
}

async function main(): Promise<void> {
  const { bridge, serve } = await channelModules();
  const bot = config.telegramToken
    ? createBot({
        token: config.telegramToken,
        allowedUserIds: config.allowedUserIds,
        tmpDir: config.tmpDir,
        sttBackend: config.sttBackend,
        whisperUrl: config.whisperUrl,
        sherpaUrl: config.sherpaUrl,
        sttLanguage: config.sttLanguage,
      })
    : null;

  const bridgeRoot = bridge.configureStorageBridge(process.env.WORKSPACE_DIR ?? process.cwd());

  // ── everything on one channel port: telegram routes first (disjoint), then
  //    the storage bridge (owns OPTIONS + /stt itself) ──────────────────────
  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${HOST}:${CHANNEL_PORT}`);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad request path" }));
      return;
    }
    const pathname = url.pathname;
    if (pathname === "/healthz" || pathname.startsWith("/api/")) {
      void handleTelegram(req, res, url, bot);
      return;
    }
    bridge.handleStorageRequest(req, res);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[channel] port ${CHANNEL_PORT} is already in use — stop the other BOB or set BOB_CHANNEL_PORT`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(CHANNEL_PORT, HOST, () => {
    console.log(`[channel] http://${HOST}:${CHANNEL_PORT} — storage bridge + telegram mailbox (loopback only)`);
    console.log(`[channel] bridge root: ${bridgeRoot}`);
    console.log(`[channel] allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  });

  startSweep();

  let staticServer: http.Server | null = null;
  void (async () => {
    try {
      const started = await serve.startStaticServer({ port: APP_PORT, host: HOST });
      staticServer = started.server;
      if (await serve.staticIndexAvailable()) {
        console.log(`[app] http://localhost:${APP_PORT} — the browser app (web/dist)`);
      } else {
        console.warn(`[app] web/dist/index.html is missing — run npm run build:web`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.warn(`[app] port ${APP_PORT} is busy — serving channels only (app already running?)`);
      } else {
        console.warn(`[app] not served: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  })();

  if (bot) {
    startBot(bot);
  } else {
    console.log("[channel] telegram off — no TELEGRAM_BOT_TOKEN; mailbox API still serving");
  }

  const shutdown = (): void => {
    bot?.stop();
    server.close();
    staticServer?.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main();
