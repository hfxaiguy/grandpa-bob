import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import path from "node:path";
import type { Agent } from "./agent.js";
import type { ModelRegistry } from "./models.js";
import { transcribeVoice, type SttBackend } from "./stt.js";
import { git } from "./tools/git.js";
import { attachmentPrompt, saveAttachment } from "./attachments.js";
import { emitText } from "./util/emit-text.js";
import { telegramHtml } from "./util/telegram-text.js";
import { getSelectedPattern, listTreeSources, setSelectedPattern, writeEnv } from "./admin.js";
import { loadPattern } from "./pattern-loader.js";

export interface BotDeps {
  token: string;
  allowedUserIds: Set<number>;
  workspace: string;
  /** Project .env path — the tree switch persists TREE_PATTERN here. */
  envPath: string;
  tmpDir: string;
  sttBackend: SttBackend;
  whisperUrl: string;
  sherpaUrl: string;
  sttLanguage: string;
  /** Named model registry; the bot's /status command shows all entries. */
  models: ModelRegistry;
  agent: Agent;
}

const MAX_TG_MESSAGE = 4000;
// Telegram's hard cap is 4096. Replies go out as HTML (escaping can grow the
// text and tel: links add ~30 chars each), so chunk the plain text below the
// cap before converting.
const MAX_TG_HTML = 3600;
/** Ignore messages older than this (e.g. delivered while the bot was down). */
const MAX_MESSAGE_AGE_S = 120;

function chunk(text: string, size = MAX_TG_MESSAGE): string[] {
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

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token);
  // Keep the Telegram command menu in sync with the handlers below.
  // setMyCommands without a scope only touches the default scope, so stale
  // commands set earlier (BotFather, old versions) survive in the other
  // scopes and keep showing in the "/" menu. Wipe every scope first, then
  // install the real command list on the default scope.
  void (async () => {
    const scopes: Array<{ type: "default" | "all_private_chats" | "all_group_chats" | "all_chat_administrators" }> = [
      { type: "default" },
      { type: "all_private_chats" },
      { type: "all_group_chats" },
      { type: "all_chat_administrators" },
    ];
    for (const scope of scopes) {
      await bot.api.setMyCommands([], { scope }).catch((err) => console.error("[commands]", err));
    }
    await bot.api
      .setMyCommands(
        [
          { command: "tree", description: "Switch the active tree" },
          { command: "clear", description: "Clear conversation context for this topic" },
          { command: "status", description: "Show workspace, git, model and STT status" },
        ],
        { scope: { type: "default" } },
      )
      .catch((err) => console.error("[commands]", err));
  })();
  // Serialize work per conversation so parallel voice notes don't interleave agent runs.
  const queues = new Map<string, Promise<void>>();

  const convKey = (ctx: Context): string =>
    `${ctx.chat?.id}:${ctx.message?.message_thread_id ?? 0}`;

  const threadOpts = (ctx: Context): { message_thread_id?: number } => {
    const id = ctx.message?.message_thread_id;
    return id !== undefined ? { message_thread_id: id } : {};
  };

  const reply = async (ctx: Context, text: string): Promise<void> => {
    for (const part of chunk(text, MAX_TG_HTML)) {
      const html = telegramHtml(part);
      // Rich messages (Bot API 10.1+) render tel: links as real phone links;
      // classic messages only link http(s)/tg, so the numbers would be dead
      // text. Try rich first, fall back to a classic HTML send if the API
      // rejects the payload.
      try {
        await ctx.api.sendRichMessage(ctx.chat!.id, { html }, threadOpts(ctx));
      } catch (err) {
        console.warn(
          "[telegram] rich message failed, sending classic:",
          err instanceof Error ? err.message : err,
        );
        await ctx.reply(html, { ...threadOpts(ctx), parse_mode: "HTML" });
      }
    }
  };

  const enqueue = (key: string, job: () => Promise<void>): void => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(job).catch((err) => console.error("[queue]", err));
    queues.set(key, next);
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

  bot.command("clear", async (ctx) => {
    deps.agent.clear(convKey(ctx));
    await reply(ctx, "Conversation context cleared for this topic.");
  });

  bot.command("status", async (ctx) => {
    let gitLine = "(git unavailable)";
    try {
      const status = (await git(deps.workspace, ["status", "--short"])).trim();
      const branch = (await git(deps.workspace, ["branch", "--show-current"])).trim();
      const last = (await git(deps.workspace, ["log", "-1", "--oneline"])).trim();
      gitLine = `branch ${branch || "(unborn)"}, last commit: ${last || "none"}` +
        (status ? `\nuncommitted:\n${status}` : "\nworking tree clean");
    } catch { /* ignore */ }
    await reply(
      ctx,
      [
        `workspace: ${deps.workspace}`,
        `git: ${gitLine}`,
        `llm models:`,
        ...Object.entries(deps.models).map(([name, m]) => `  ${name}: ${m.model} @ ${m.baseURL}`),
        `stt: ${deps.sttBackend}${deps.sttBackend === "sherpa" ? ` @ ${deps.sherpaUrl}` : ` @ ${deps.whisperUrl}`}`,
      ].join("\n"),
    );
  });

  /**
   * Switch the active tree; the caller's conversation is dropped. Loads the
   * tree first so a module that isn't runnable (e.g. patterns/shared.mjs)
   * fails here with a clear message instead of on the next turn.
   */
  const switchTree = async (ctx: Context, name: string): Promise<string | null> => {
    try {
      await loadPattern(deps.workspace, name);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    setSelectedPattern(name);
    try {
      await writeEnv(deps.envPath, { TREE_PATTERN: name });
    } catch { /* persist best-effort */ }
    deps.agent.clear(convKey(ctx));
    return null;
  };

  // /tree — switch the active tree without the web UI. The command autofills
  // from Telegram's command menu; `/tree <name>` switches directly, bare
  // `/tree` offers one inline button per tree (patterns + app trees).
  bot.command("tree", async (ctx) => {
    const sources = await listTreeSources(deps.workspace);
    const arg = (ctx.match ?? "").trim();
    if (arg) {
      const hit = sources.find((p) => p.name === arg);
      if (!hit) {
        await reply(
          ctx,
          `No tree named "${arg}".\nAvailable: ${sources.map((p) => p.name).join(", ") || "(none)"}`,
        );
        return;
      }
      const err = await switchTree(ctx, hit.name);
      if (err) {
        await reply(ctx, `Can't switch to "${hit.name}": ${err}`);
        return;
      }
      await reply(ctx, `Active tree: ${hit.name}\nConversation cleared — send a request to start it.`);
      return;
    }
    if (!sources.length) {
      await reply(ctx, "No trees found in the workspace.");
      return;
    }
    const current = getSelectedPattern();
    const keyboard = new InlineKeyboard();
    for (const p of sources) {
      keyboard.text(`${p.name === current ? "\u2713 " : ""}${p.name}`, `tree:${p.name}`).row();
    }
    await ctx.reply(`Active tree: ${current}\nPick a tree:`, {
      ...threadOpts(ctx),
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^tree:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    const sources = await listTreeSources(deps.workspace);
    const hit = sources.find((p) => p.name === name);
    if (!hit) {
      await ctx.answerCallbackQuery({ text: `No tree named "${name}"`, show_alert: true });
      return;
    }
    const err = await switchTree(ctx, hit.name);
    if (err) {
      await ctx.answerCallbackQuery({ text: `Can't switch: ${err}`, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Active tree: ${hit.name}` });
    await ctx
      .editMessageText(`Active tree: ${hit.name}\nConversation cleared — send a request to start it.`)
      .catch(() => {});
  });

  /**
   * Run the agent tree for one turn. The tree emits responses via
   * `onEmit` (which sends them to Telegram) and pauses at `.human()`
   * for the next message. The continuation is stored automatically.
   */
  const handleUserContent = async (ctx: Context, content: unknown): Promise<void> => {
    const key = convKey(ctx);
    // First message from this conversation: initialize the tree.
    // It pauses at .human() immediately. Without this, the user's
    // first message would be consumed by tree setup with no response.
    // Trunk-style trees grow to their first .human(); input-driven app
    // trees (they declare `input`) consume the message directly.
    if (!deps.agent.hasContinuation(key) && !(await deps.agent.consumesInputDirectly())) {
      await deps.agent.run(key, "", async () => {});
    }
    // keep the "typing…" indicator alive while the agent works
    const typing = setInterval(() => {
      ctx.api.sendChatAction(ctx.chat!.id, "typing", threadOpts(ctx)).catch(() => {});
    }, 4500);
    await ctx.api.sendChatAction(ctx.chat!.id, "typing", threadOpts(ctx)).catch(() => {});
    try {
      let emitted = false;
      const res = await deps.agent.run(key, content, async (value) => {
        // onEmit: send each emitted value to Telegram immediately. Trees emit
        // { text } objects; show the text, never the JSON wrapper.
        const text = emitText(value);
        if (text) { emitted = true; await reply(ctx, text); }
      });
      // Non-looping trees complete instead of pausing at .human() — send
      // their final result as the reply when nothing was emitted.
      if (res.status === "done" && !emitted && res.result != null) {
        const text = emitText(res.result);
        if (text) await reply(ctx, text);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[agent]", err);
      const backendList = Object.entries(deps.models)
        .map(([n, m]) => `${n}=${m.baseURL}`)
        .join(", ");
      await reply(ctx, `Something went wrong: ${msg}\n(llm backends: ${backendList})`);
    } finally {
      clearInterval(typing);
    }
  };

  /** Download a Telegram file as a base64 data URL. */
  const downloadAsDataUrl = async (fileId: string): Promise<string> => {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  };

  bot.on("message:text", async (ctx) => {
    if (Math.floor(Date.now() / 1000) - ctx.message.date > MAX_MESSAGE_AGE_S) return;
    const key = convKey(ctx);
    enqueue(key, () => handleUserContent(ctx, ctx.message.text));
  });

  bot.on("message:photo", async (ctx) => {
    if (Math.floor(Date.now() / 1000) - ctx.message.date > MAX_MESSAGE_AGE_S) return;
    const key = convKey(ctx);
    enqueue(key, async () => {
      let dataUrl: string;
      try {
        // Telegram sends several sizes; the last is the largest
        const biggest = ctx.message.photo[ctx.message.photo.length - 1];
        dataUrl = await downloadAsDataUrl(biggest.file_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[photo]", err);
        await reply(ctx, `Could not download that photo: ${msg}`);
        return;
      }
      // Gemma 4 best practice: image before text
      await handleUserContent(ctx, [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: ctx.message.caption ?? "What is in this image?" },
      ]);
    });
  });

  bot.on("message:voice", async (ctx) => {
    if (Math.floor(Date.now() / 1000) - ctx.message.date > MAX_MESSAGE_AGE_S) return;
    const key = convKey(ctx);
    enqueue(key, async () => {
      let text: string;
      try {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        if (!file.file_path) throw new Error("Telegram returned no file_path");
        const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`;
        text = await transcribeVoice({
          fileUrl: url,
          backend: deps.sttBackend,
          whisperUrl: deps.whisperUrl,
          sherpaUrl: deps.sherpaUrl,
          tmpDir: deps.tmpDir,
          language: deps.sttLanguage || undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[stt]", err);
        await reply(ctx, `Could not transcribe that voice message: ${msg}`);
        return;
      }
      await reply(ctx, `heard: "${text}"`);
      await handleUserContent(ctx, text);
    });
  });

  bot.on("message:document", async (ctx) => {
    if (Math.floor(Date.now() / 1000) - ctx.message.date > MAX_MESSAGE_AGE_S) return;
    const key = convKey(ctx);
    enqueue(key, async () => {
      try {
        const file = await ctx.api.getFile(ctx.message.document.file_id);
        if (!file.file_path) throw new Error("Telegram returned no file_path");
        const response = await fetch(`https://api.telegram.org/file/bot${deps.token}/${file.file_path}`);
        if (!response.ok) throw new Error(`file download failed: HTTP ${response.status}`);
        const attachment = await saveAttachment(
          deps.workspace,
          ctx.message.document.file_name || path.basename(file.file_path),
          Buffer.from(await response.arrayBuffer()),
          ctx.message.document.mime_type || "application/octet-stream",
        );
        await handleUserContent(ctx, attachmentPrompt(attachment, ctx.message.caption || ""));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[document]", err);
        await reply(ctx, `Could not save that file: ${msg}`);
      }
    });
  });

  bot.catch((err) => console.error("[bot]", err));
  return bot;
}
