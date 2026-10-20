import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import path from "node:path";
import type { Agent } from "./agent.js";
import type { ModelRegistry } from "./models.js";
import { transcribeAudioBytes, type SttBackend } from "./stt.js";
import { git } from "./tools/git.js";
import { createNodePlatform } from "./platform/node.js";
import { attachmentPrompt, saveAttachment } from "./attachments.js";
import { emitValue, type EmitButton } from "./util/emit-text.js";
import { isQuotaError, quotaRole } from "./util/quota-error.js";
import { ButtonStore } from "./buttons.js";
import { telegramHtml, telegramRichHtml } from "./util/telegram-text.js";
import {
  getSelectedPattern,
  getSelectedRef,
  listTreeSources,
  notifyTreesChanged,
  setSelectedPattern,
  setSelectedRef,
  writeEnv,
} from "./admin.js";
import { loadPattern } from "./pattern-loader.js";
import { promoteDraft, scanTreeVersions } from "./tree-versions.js";

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
  /**
   * Live mirror of handled turns into the web session store (admin's
   * remoteTurn* trio): start on receipt, event per tree step, end on
   * completion. A followed browser then shows bubbles AND tree steps.
   */
  turnRecorder?: {
    start: (key: string, input: string) => void;
    event: (key: string, event: unknown) => void;
    end: (key: string, output: string, ok?: boolean, paused?: boolean) => void;
  };
  /** Named model registry; the bot's /status command shows all entries. */
  models: ModelRegistry;
  agent: Agent;
  /**
   * Reverse-follow lookup: when a Telegram chat has adopted a web session
   * (via the webui's "send to telegram"), return that session's `web:` key so
   * the turn runs the same tree. Absent / no binding -> the chat's own key.
   */
  telegramFollowKey?: (tgKey: string) => string | undefined;
  /** The chat's own rotated session key (from "/new"), if any. */
  telegramChatKey?: (tgKey: string) => string | undefined;
  /** Start a fresh session for this chat ("/new"); returns the new key. */
  newTelegramSession?: (tgKey: string) => string;
}

const MAX_TG_MESSAGE = 4000;
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
  const platform = createNodePlatform(deps.workspace);

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
      await retrying(() => bot.api.setMyCommands([], { scope })).catch((err) =>
        console.error("[commands]", err),
      );
    }
    await retrying(() =>
      bot.api.setMyCommands(
        [
          { command: "tree", description: "Switch the active tree" },
          { command: "model", description: "Show or switch the model for this topic" },
          { command: "clear", description: "Clear conversation context for this topic" },
          { command: "new", description: "Start a new session for this chat" },
          { command: "status", description: "Show workspace, git, model and STT status" },
        ],
        { scope: { type: "default" } },
      ),
    ).catch((err) => console.error("[commands]", err));
  })();
  // Serialize work per conversation so parallel voice notes don't interleave agent runs.
  const queues = new Map<string, Promise<void>>();

  // Button values live server-side (Telegram caps callback_data at 64 bytes);
  // a keyboard carries only "btn:<id>".
  const buttonStore = new ButtonStore();

  // ctx.msg also follows callbackQuery.message, so a button tap keeps the
  // conversation key and topic of the message the keyboard hangs under.
  const convKey = (ctx: Context): string =>
    `${ctx.chat?.id}:${ctx.msg?.message_thread_id ?? 0}`;

  // The key a turn actually runs under: the chat's own, or the web session it
  // reverse-follows (send to telegram). Replies and buttons stay keyed by
  // convKey, so the keyboard round-trips through this chat.
  // The agent-session key for a chat: a web reverse-follow wins, else the
  // chat's own "/new" rotation, else the chat key itself. The chat key (the
  // transport) is unchanged — only the session the turn runs under moves.
  const followKey = (ctx: Context): string => {
    const conv = convKey(ctx);
    return deps.telegramFollowKey?.(conv) ?? deps.telegramChatKey?.(conv) ?? conv;
  };

  const threadOpts = (ctx: Context): { message_thread_id?: number } => {
    const id = ctx.msg?.message_thread_id;
    return id !== undefined ? { message_thread_id: id } : {};
  };

  /**
   * Inline keyboard for an emitted button list: one row side by side, a new
   * row every 8 (Telegram's per-row cap). Each callback carries a registered
   * id, never the value itself.
   */
  const keyboardFor = (key: string, list: EmitButton[]): InlineKeyboard => {
    const kb = new InlineKeyboard();
    list.forEach((b, i) => {
      kb.text(b.label, "btn:" + buttonStore.register(key, b.value));
      if (i % 8 === 7 && i !== list.length - 1) kb.row();
    });
    return kb;
  };

  /**
   * Inline keyboard of model slots for a quota fallback. Unlike emitted
   * buttons (whose tap feeds a value into the paused tree), a tap here
   * retargets the conversation's failed model role and re-runs the killed
   * turn — so it carries the slot name directly, under an "fb:" prefix.
   */
  const fallbackKeyboard = (): InlineKeyboard => {
    const kb = new InlineKeyboard();
    deps.agent.modelSlots().forEach((s, i) => {
      kb.text(s.name, "fb:" + s.name);
      if (i % 3 === 2) kb.row();
    });
    return kb;
  };

  const reply = async (ctx: Context, text: string, buttons?: EmitButton[]): Promise<void> => {
    const parts = chunk(text, MAX_TG_HTML);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // Buttons attach to the last chunk — the keyboard belongs under the
      // message the user reads, not under an overflow fragment.
      const markup =
        i === parts.length - 1 && buttons?.length
          ? { reply_markup: keyboardFor(convKey(ctx), buttons) }
          : {};
      // Rich messages (Bot API 10.1+) render tel: links as real phone links;
      // classic messages only link http(s)/tg, so the numbers would be dead
      // text. Try rich first, fall back to a classic HTML send if the API
      // rejects the payload.
      try {
        // Rich HTML collapses raw newlines; <br> keeps the line structure.
        await ctx.api.sendRichMessage(
          ctx.chat!.id,
          { html: telegramRichHtml(part) },
          { ...threadOpts(ctx), ...markup },
        );
      } catch (err) {
        console.warn(
          "[telegram] rich message failed, sending classic:",
          err instanceof Error ? err.message : err,
        );
        await ctx.reply(telegramHtml(part), { ...threadOpts(ctx), parse_mode: "HTML", ...markup });
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
    deps.agent.clear(followKey(ctx));
    await reply(ctx, "Conversation context cleared for this topic.");
  });

  // /new — start a fresh session for this chat. Drops any web reverse-follow
  // (the chat is no longer pinned to a web session), mints a chat-scoped
  // session key, and routes future turns to it. The session is shared: it
  // appears in the web UI's session list and can be typed into there too — a
  // web turn runs the same tree and mirrors back to this chat. The previous
  // session keeps its history.
  bot.command("new", async (ctx) => {
    const key = deps.newTelegramSession?.(convKey(ctx));
    if (!key) {
      await reply(ctx, "Couldn't start a new session.");
      return;
    }
    await reply(
      ctx,
      "Started a new session for this chat. Pick it in the web UI to keep going there — it's the same conversation.",
    );
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

  // /model — retarget this conversation's per-role model slots (models.json).
  //   /model                          list each role's current choice + slots
  //   /model <strong|cheap> <slot>    use that slot for the role
  //   /model <slot>                   shorthand for the strong role
  //   /model reset [strong|cheap]     back to the tree's own slot(s)
  bot.command("model", async (ctx) => {
    const key = followKey(ctx);
    const slots = deps.agent.modelSlots();
    const current = deps.agent.sessionModelMap(key);
    const words = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);

    const roleLine = (role: string): string => {
      const target = current[role];
      const hit = target ? slots.find((s) => s.name === target) : undefined;
      return `  ${role}: ${target ? `${target}${hit ? ` (${hit.model} @ ${hit.baseURL})` : ""}` : "(default)"}`;
    };

    if (!words.length) {
      await reply(
        ctx,
        [
          "This conversation's models:",
          roleLine("cheap"),
          roleLine("strong"),
          "",
          slots.length ? "Available slots:" : "No model slots configured (edit models.json in /settings).",
          ...slots.map((s) => `  ${s.name} \u2014 ${s.model} @ ${s.baseURL}`),
          "",
          "Usage: /model <strong|cheap> <slot>  \u00b7  /model <slot> (strong)  \u00b7  /model reset",
        ].join("\n"),
      );
      return;
    }

    if (words[0] === "reset" || words[0] === "default") {
      if (words[1] === "strong" || words[1] === "cheap") {
        deps.agent.clearSessionModel(key, words[1]);
        await reply(ctx, `Cleared the ${words[1]} model override.`);
      } else {
        deps.agent.clearSessionModel(key);
        await reply(ctx, "Cleared model overrides \u2014 the tree's own slots are in use again.");
      }
      return;
    }

    let role = "strong";
    let slotArg = words[0];
    if (words[0] === "strong" || words[0] === "cheap") {
      role = words[0];
      slotArg = words[1];
    }
    if (!slotArg) {
      await reply(ctx, `Usage: /model ${role} <slot>`);
      return;
    }

    const hit = slots.find((s) => s.name === slotArg);
    if (!hit) {
      await reply(
        ctx,
        `No model slot named "${slotArg}".\nAvailable: ${slots.map((s) => s.name).join(", ") || "(none)"}`,
      );
      return;
    }
    if (!deps.agent.setSessionModel(key, role, slotArg)) {
      await reply(ctx, `Couldn't switch the ${role} slot to "${slotArg}".`);
      return;
    }
    await reply(ctx, `${role} model for this conversation: ${slotArg} \u2014 ${hit.model} @ ${hit.baseURL}`);
  });

  /**
   * Switch the active tree; the caller's conversation is dropped. Loads the
   * tree first so a module that isn't runnable (e.g. patterns/shared.mjs)
   * fails here with a clear message instead of on the next turn.
   */
  const switchTree = async (ctx: Context, name: string, ref?: string): Promise<string | null> => {
    const target = ref ? `${name}@${ref}` : name;
    try {
      await loadPattern(deps.workspace, target);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    setSelectedPattern(name);
    setSelectedRef(ref ?? "");
    try {
      await writeEnv(deps.envPath, {
        TREE_PATTERN: name,
        TREE_REF: ref && ref !== "prod" ? ref : null,
      });
    } catch { /* persist best-effort */ }
    notifyTreesChanged(name);
    // The caller starts a fresh session on the chosen tree+version; sessions
    // in other topics keep their own pinned version.
    deps.agent.clear(followKey(ctx));
    return null;
  };

  // /tree — switch the active tree/version without the web UI. Commands:
  //   /tree                      one inline button per logical tree
  //   /tree <name>               switch tree (new sessions use its prod)
  //   /tree <name>@<vN|prod|draft>  switch tree + active version
  //   /tree versions <name>      list prod, draft and any legacy snapshots
  //   /tree promote <name>       promote the draft to production
  bot.command("tree", async (ctx) => {
    const sources = await listTreeSources(deps.workspace);
    const arg = (ctx.match ?? "").trim();
    const words = arg.split(/\s+/).filter(Boolean);

    if (words[0] === "versions") {
      const name = words[1];
      if (!name) {
        await reply(ctx, "Usage: /tree versions <name>");
        return;
      }
      const catalog = (await scanTreeVersions(deps.workspace)).find((c) => c.logical === name);
      if (!catalog) {
        await reply(ctx, `No tree named "${name}".`);
        return;
      }
      const active = getSelectedRef() ?? "";
      const activeLabel = getSelectedPattern() === name ? (active || "prod") : "(inactive tree)";
      const withSpec = (label: string, v: string | null) =>
        v && catalog.specVersions.includes(v) ? `${label} · spec` : label;
      const lines = [
        `${name} — active ref for new sessions: ${activeLabel}`,
        ...(catalog.hasProd
          ? [`  prod: ${withSpec(catalog.prodVersion ?? "prod", catalog.prodVersion)}`]
          : ["  prod: (none)"]),
        ...catalog.versions
          .filter((v) => !(catalog.hasProd && catalog.prodVersion === v))
          .map((v) => `  ${withSpec(v, v)}`),
        `  draft${catalog.draft ? "" : " (missing)"}${catalog.draftSpec ? " · spec" : ""}`,
      ];
      await reply(ctx, lines.join("\n"));
      return;
    }

    if (words[0] === "promote") {
      const name = words[1];
      if (!name) {
        await reply(ctx, "Usage: /tree promote <name>");
        return;
      }
      try {
        const promoted = await promoteDraft(deps.workspace, name);
        notifyTreesChanged(name);
        await reply(
          ctx,
          `Promoted ${name} → ${promoted.file}. Live sessions keep the tree they opened on.`,
        );
      } catch (err) {
        await reply(ctx, `Can't promote "${name}": ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (arg) {
      const at = arg.indexOf("@");
      const name = at >= 0 ? arg.slice(0, at) : arg;
      const ref = at >= 0 ? arg.slice(at + 1) : undefined;
      const hit = sources.find((p) => p.name === name);
      if (!hit) {
        await reply(
          ctx,
          `No tree named "${name}".\nAvailable: ${sources.map((p) => p.name).join(", ") || "(none)"}`,
        );
        return;
      }
      const err = await switchTree(ctx, name, ref);
      if (err) {
        await reply(ctx, `Can't switch to "${arg}": ${err}`);
        return;
      }
      await reply(
        ctx,
        `Active tree: ${name}${ref ? `@${ref}` : ""}\nConversation cleared — send a request to start it.`,
      );
      return;
    }
    if (!sources.length) {
      await reply(ctx, "No trees found in the workspace.");
      return;
    }
    const current = getSelectedPattern();
    const currentRef = getSelectedRef() ?? "";
    const keyboard = new InlineKeyboard();
    for (const p of sources) {
      keyboard.text(`${p.name === current ? "\u2713 " : ""}${p.name}`, `tree:${p.name}`).row();
    }
    const label = currentRef && currentRef !== "prod" ? `${current}@${currentRef}` : current;
    await ctx.reply(
      `Active tree: ${label}\nTip: /tree versions <name> · /tree <name>@<vN>\nPick a tree:`,
      {
        ...threadOpts(ctx),
        reply_markup: keyboard,
      },
    );
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

  // Emitted message buttons: a tap resolves the registered value and feeds it
  // in exactly like a typed reply to the paused tree.
  bot.callbackQuery(/^btn:(.+)$/, async (ctx) => {
    const key = convKey(ctx);
    const value = buttonStore.resolve(key, ctx.match[1]);
    if (value === undefined) {
      await ctx.answerCallbackQuery({
        show_alert: true,
        text: "That button expired — type your reply instead.",
      });
      return;
    }
    await ctx.answerCallbackQuery();
    // One-shot: drop the keyboard so the same tap cannot be sent twice.
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    enqueue(key, () => handleUserContent(ctx, value));
  });

  // Quota fallback: a model-slot tap retargets the failed role for this
  // conversation and re-runs the killed turn, exactly as if the user had
  // typed it again on the new model. Keyed by followKey — the key the turn
  // actually ran under (see handleUserContent).
  bot.callbackQuery(/^fb:(.+)$/, async (ctx) => {
    const key = followKey(ctx);
    const slot = ctx.match[1];
    const pending =
      typeof deps.agent.confirmFallback === "function" ? deps.agent.confirmFallback(key, slot) : null;
    if (!pending) {
      await ctx.answerCallbackQuery({
        show_alert: true,
        text: "That fallback is no longer available — use /model to pick one.",
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Falling back to ${slot}` });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    enqueue(key, () => handleUserContent(ctx, pending.input));
  });

  /**
   * Run the agent tree for one turn. The tree emits responses via
   * `onEmit` (which sends them to Telegram) and pauses at `.human()`
   * for the next message. The continuation is stored automatically.
   */
  const handleUserContent = async (ctx: Context, content: unknown): Promise<void> => {
    // Reverse-followed chats run the adopted web session's key; replies still
    // go to this Telegram chat.
    const key = followKey(ctx);
    // A normal turn supersedes any pending quota-fallback prompt: once the user
    // types something else, a stale fallback tap must not re-run the old turn.
    if (typeof deps.agent.clearPendingFallback === "function") deps.agent.clearPendingFallback(key);
    const display = typeof content === "string" ? content : "[attachment]";
    const turnOutput: string[] = [];
    const rec = deps.turnRecorder;
    rec?.start(key, display);
    // First message from this conversation: initialize the tree.
    // It pauses at .human() immediately. Without this, the user's
    // first message would be consumed by tree setup with no response.
    // Trunk-style trees grow to their first .human(); input-driven app
    // trees (they declare `input`) consume the message directly.
    if (!deps.agent.hasContinuation(key) && !(await deps.agent.consumesInputDirectly())) {
      await deps.agent.run(key, "", async () => {}, {
        onEvent: (e) => rec?.event(key, e),
      });
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
        // { text, buttons? } objects; show the text, never the JSON wrapper.
        const { text, buttons } = emitValue(value);
        if (text) { emitted = true; turnOutput.push(text); await reply(ctx, text, buttons); }
      }, {
        onEvent: (e) => rec?.event(key, e),
      });
      // Non-looping trees complete instead of pausing at .human() — send
      // their final result as the reply when nothing was emitted.
      if (res.status === "done" && !emitted && res.result != null) {
        const { text, buttons } = emitValue(res.result);
        if (text) { turnOutput.push(text); await reply(ctx, text, buttons); }
      }
      rec?.end(key, turnOutput.join("\n\n"), true, res.status === "waiting");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[agent]", err);
      rec?.end(key, msg, false);
      if (isQuotaError(err) && typeof deps.agent.setPendingFallback === "function") {
        // A quota wall is not a bug — it needs a decision. Remember the turn,
        // then offer the registry's model slots; a tap retargets the failed
        // role and re-runs it (see the fb: callback).
        const role = quotaRole(err);
        deps.agent.setPendingFallback(key, role, content);
        const slots = deps.agent.modelSlots();
        const text =
          `The ${role} model hit its plan limit (402 — out of credit or quota).\n` +
          (slots.length
            ? "Pick a model to fall back to for this conversation:"
            : "No model slots are configured — edit models.json in /settings.");
        if (slots.length) {
          await ctx.reply(text, { ...threadOpts(ctx), reply_markup: fallbackKeyboard() });
        } else {
          await reply(ctx, text);
        }
      } else {
        const backendList = Object.entries(deps.models)
          .map(([n, m]) => `${n}=${m.baseURL}`)
          .join(", ");
        await reply(ctx, `Something went wrong: ${msg}\n(llm backends: ${backendList})`);
      }
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
   * echo the transcript, then run the agent turn on the text — identical to
   * typing, so a paused tree resumes from a spoken reply. Serialized per
   * conversation so parallel notes don't interleave agent runs.
   */
  const handleAudio = (ctx: Context, what: string): void => {
    const message = ctx.message;
    if (!message) return;
    // A message delivered long after it was sent (the bot was down, or a long
    // queue) is dropped — but say so instead of going silent on a voice user.
    if (Math.floor(Date.now() / 1000) - message.date > MAX_MESSAGE_AGE_S) {
      void reply(ctx, "That message arrived while I was busy — please send it again.").catch(() => {});
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
      await handleUserContent(ctx, transcript);
    });
  };

  bot.on("message:voice", (ctx) => handleAudio(ctx, "voice message"));
  // Forwarded voice notes and uploaded recordings arrive as `audio`; round
  // video messages as `video_note`. Both are speech — transcribe them too.
  bot.on("message:audio", (ctx) => handleAudio(ctx, "audio file"));
  bot.on("message:video_note", (ctx) => handleAudio(ctx, "video message"));

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
          platform,
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
