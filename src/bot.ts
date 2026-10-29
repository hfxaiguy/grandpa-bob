/**
 * The Telegram side of the standalone-only channel.
 *
 * Node never runs the agent: every inbound message is *parked* in the mailbox
 * (src/telegram-bridge.ts) for the browser tab to drain, and replies come back
 * through the relay endpoint (src/index.ts). Voice notes are transcribed
 * channel-side (stt.ts) so the mailbox parks transcripts, never audio blobs.
 * Attachments are text-only in v1 — the phone is told to send them in the web
 * chat instead.
 *
 * There are no server-side commands (/new, /model, /tree, /status): text
 * arrives in the web app verbatim, and the app answers — the phone is just
 * another surface on the same conversation.
 */
import { Bot } from "grammy";
import type { Context } from "grammy";
import path from "node:path";
import { transcribeAudioBytes, type SttBackend } from "./stt.js";
import { telegramHtml, telegramRichHtml } from "./util/telegram-text.js";
import {
  BRIDGE_TEXT_ONLY_TEXT,
  parkMessage,
  type BridgeMessage,
} from "./telegram-bridge.js";

export interface BotDeps {
  token: string;
  allowedUserIds: Set<number>;
  tmpDir: string;
  sttBackend: SttBackend;
  whisperUrl: string;
  sherpaUrl: string;
  sttLanguage: string;
}

// Telegram's hard cap is 4096. Replies go out as HTML (escaping can grow the
// text and tel: links add ~30 chars each), so chunk the plain text below the
// cap before converting.
const MAX_TG_HTML = 3600;
/** Ignore messages older than this (e.g. delivered while the bot was down). */
const MAX_MESSAGE_AGE_S = 120;

/** The spoken content a Telegram message carries, if any. */
export interface TelegramAudio {
  /** Which kind of update: a voice note, an audio file, or a round video. */
  kind: "voice" | "audio" | "video_note";
  /** The Bot API file_id to download and transcribe. */
  fileId: string;
}

/**
 * The audio a Telegram message carries, or null. Voice notes arrive as `voice`;
 * a forwarded voice note or an uploaded recording arrives as `audio`; a round
 * video message as `video_note`. All three are speech and all three are
 * transcribed, so the bot is fully talkable-to — not only via fresh voice
 * notes. Exported for the telegram-audio test.
 */
export function telegramAudioOf(message: {
  voice?: { file_id?: string };
  audio?: { file_id?: string };
  video_note?: { file_id?: string };
}): TelegramAudio | null {
  if (message.voice?.file_id) return { kind: "voice", fileId: message.voice.file_id };
  if (message.audio?.file_id) return { kind: "audio", fileId: message.audio.file_id };
  if (message.video_note?.file_id) return { kind: "video_note", fileId: message.video_note.file_id };
  return null;
}

function chunk(text: string, size = MAX_TG_HTML): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/**
 * Send one text message to a chat, chunked, rich-first with a classic HTML
 * fallback. Used both by the (rare) direct replies and by the relay endpoint —
 * the browser posts completed turn text here, so this is the channel's only
 * outbound path.
 */
export async function sendChannelText(
  bot: Bot,
  chatId: number,
  threadId: number,
  text: string,
): Promise<void> {
  const opts: Record<string, unknown> = threadId ? { message_thread_id: threadId } : {};
  for (const part of chunk(text)) {
    try {
      // Rich HTML collapses raw newlines; <br> keeps the line structure.
      await bot.api.sendRichMessage(chatId, { html: telegramRichHtml(part) }, opts);
    } catch (err) {
      console.warn(
        "[telegram] rich message failed, sending classic:",
        err instanceof Error ? err.message : err,
      );
      await bot.api.sendMessage(chatId, telegramHtml(part), { ...opts, parse_mode: "HTML" });
    }
  }
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token);

  /** Telegram startup calls can hit a transient ETIMEDOUT; retry briefly. */
  async function retrying<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw last;
  }

  // No server-side commands anymore (the web app answers text verbatim), so
  // wipe any stale command menu earlier versions installed.
  void (async () => {
    const scopes: Array<{ type: "default" | "all_private_chats" | "all_group_chats" | "all_chat_administrators" }> = [
      { type: "default" },
      { type: "all_private_chats" },
      { type: "all_group_chats" },
      { type: "all_chat_administrators" },
    ];
    for (const scope of scopes) {
      await retrying(() => bot.api.setMyCommands([], { scope })).catch((err) =>
        console.error("[commands]", err),
      );
    }
  })();

  // Serialize per conversation so parallel voice notes park in arrival order.
  const queues = new Map<string, Promise<void>>();
  const enqueue = (key: string, job: () => Promise<void>): void => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(job).catch((err) => console.error("[queue]", err));
    queues.set(key, next);
  };

  // ctx.msg also follows callbackQuery.message, so a stale button tap keeps
  // the conversation key of the message the keyboard hangs under.
  const convKey = (ctx: Context): string =>
    `${ctx.chat?.id}:${ctx.msg?.message_thread_id ?? 0}`;

  const threadOpts = (ctx: Context): { message_thread_id?: number } => {
    const id = ctx.msg?.message_thread_id;
    return id !== undefined ? { message_thread_id: id } : {};
  };

  const reply = async (ctx: Context, text: string): Promise<void> => {
    await sendChannelText(bot, ctx.chat!.id, ctx.msg?.message_thread_id ?? 0, text);
  };

  // ---- auth gate: silently ignore everyone not on the allowlist ----
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id === undefined || !deps.allowedUserIds.has(id)) {
      console.log(`[auth] ignored update from user ${id ?? "unknown"}`);
      return;
    }
    await next();
  });

  const park = (ctx: Context, text: string): void => {
    const msg: BridgeMessage = {
      id: ctx.msg?.message_id ?? 0,
      text,
      chatId: ctx.chat!.id,
      threadId: ctx.msg?.message_thread_id ?? 0,
    };
    void parkMessage(convKey(ctx), msg);
  };

  bot.on("message:text", async (ctx) => {
    if (Math.floor(Date.now() / 1000) - ctx.message.date > MAX_MESSAGE_AGE_S) return;
    park(ctx, ctx.message.text);
  });

  /**
   * Download one Telegram audio file and transcribe it. The container
   * extension comes from the Bot API file_path (voice notes are `.oga`, audio
   * files `.mp3`/`.m4a`, round videos `.mp4`); ffmpeg decodes whatever it is.
   * Throws on a download or STT failure so the caller can report it.
   */
  const transcribeTelegramAudio = async (fileId: string): Promise<string> => {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`voice download failed: HTTP ${res.status}`);
    const ext = path.extname(file.file_path) || ".ogg";
    return transcribeAudioBytes(Buffer.from(await res.arrayBuffer()), {
      ext,
      backend: deps.sttBackend,
      whisperUrl: deps.whisperUrl,
      sherpaUrl: deps.sherpaUrl,
      tmpDir: deps.tmpDir,
      language: deps.sttLanguage || undefined,
    });
  };

  /**
   * One audio message (voice note / audio file / round video): transcribe it,
   * echo the transcript, and park the text — identical to typing, so the web
   * conversation continues from a spoken reply.
   */
  const handleAudio = (ctx: Context, what: string): void => {
    const message = ctx.message;
    if (!message) return;
    // A message delivered long after it was sent (the bot was down) is
    // dropped — but say so instead of going silent on a voice user.
    if (Math.floor(Date.now() / 1000) - message.date > MAX_MESSAGE_AGE_S) {
      void reply(ctx, "That message arrived while I was offline — please send it again.").catch(() => {});
      return;
    }
    const audio = telegramAudioOf(message);
    if (!audio) return;
    const key = convKey(ctx);
    enqueue(key, async () => {
      let text: string;
      try {
        text = await transcribeTelegramAudio(audio.fileId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[stt]", err);
        await reply(ctx, `Could not transcribe that ${what}: ${msg}`);
        return;
      }
      const transcript = text.trim();
      if (!transcript) {
        await reply(ctx, `I couldn't make out any words in that ${what} — please try again.`);
        return;
      }
      await reply(ctx, `heard: "${transcript}"`);
      park(ctx, transcript);
    });
  };

  bot.on("message:voice", (ctx) => handleAudio(ctx, "voice message"));
  // Forwarded voice notes and uploaded recordings arrive as `audio`; round
  // video messages as `video_note`. Both are speech — transcribe them too.
  bot.on("message:audio", (ctx) => handleAudio(ctx, "audio file"));
  bot.on("message:video_note", (ctx) => handleAudio(ctx, "video message"));

  // Attachments are text-only in v1: the workspace the agent writes to lives
  // in the browser (OPFS or the desktop folder), and there is no server-side
  // upload path into it yet.
  const textOnly = async (ctx: Context): Promise<void> => {
    if (Math.floor(Date.now() / 1000) - (ctx.message?.date ?? 0) > MAX_MESSAGE_AGE_S) return;
    await reply(ctx, BRIDGE_TEXT_ONLY_TEXT).catch(() => {});
  };
  bot.on("message:photo", textOnly);
  bot.on("message:document", textOnly);

  bot.catch((err) => console.error("[bot]", err));
  return bot;
}
