/** Tile, memory, per-tile event log, global stream, session panel. */
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { describeEvent, streamLines, type EventLine } from "./describe";
import { copyEventStream, copyText, downloadEventStream } from "./event-dump";
import { JsonView } from "./json-view";
import {
  state,
  send,
  selectSession,
  newSession,
  deleteSession,
  renameSession,
  setFollow,
  toggleMachine,
  setPattern,
  setModel,
  chooseFallback,
  clearConversation,
  sendToTelegram,
  setBridge,
  fetchProvenance,
  fetchRef,
  refView,
  openRef,
  closeRef,
  toggleExpanded,
  toggleWide,
  toggleHidden,
  togglePinned,
  toggleMem,
  moveTile,
  hiddenApps,
  setStreamOpen,
  subApps,
  openSubApps,
  toggleSub,
  toast,
  sendFile,
  transcribeFileStream,
} from "./store";
import type { AppInfo, ProvPiece, ProvWriter, Provenance, RefTarget, Turn, TurnTokens } from "./types";
import { newTurnApps, tagEventApp } from "../../src/app-attribution";
import { Markdown } from "./markdown";

const trunkOf = (a?: string | null) => a || "trunk";

/** One chat bubble; `lastOfTurn` marks the turn's final reply in this tile so
 *  the turn's token totals can print once, right under it. */
interface Bubble {
  turn: Turn;
  text: string;
  kind: "user" | "bot" | "err";
  emitIndex?: number;
  lastOfTurn?: boolean;
}

/** Chat bubbles for one app, across every turn. */
function bubblesFor(app: string): Bubble[] {
  const out: Bubble[] = [];
  for (const t of state.turns) {
    const from = out.length;
    if ((t.inputApp ?? "trunk") === app && t.input) out.push({ turn: t, text: t.input, kind: "user" });
    const emits = t.emits ?? [];
    const apps = t.emitApps ?? [];
    for (let i = 0; i < emits.length; i++) {
      if (trunkOf(apps[i]) !== app) continue;
      // Machine notes are tree narration (input, waiting, hand-offs), not
      // replies. The session drawer/toolbar toggles `showMachine` globally;
      // emitIndex stays the original position so provenance/levels still line
      // up when the note is visible.
      if (t.levels?.[i] === "machine" && !state.showMachine) continue;
      // emitIndex: the bubble's position in the turn's emit list — the anchor
      // the provenance endpoint resolves back to the log's emit row.
      out.push({ turn: t, text: emits[i], kind: "bot", emitIndex: i });
    }
    if (app === "trunk" && (t.status === "done" || t.status === "stopped") && !emits.length && t.output) {
      out.push({ turn: t, text: t.output, kind: "bot" });
    }
    if ((t.inputApp ?? "trunk") === app && t.status === "error" && t.error) {
      out.push({ turn: t, text: t.error, kind: "err" });
    }
    for (let i = out.length - 1; i >= from; i--) {
      if (out[i].kind === "bot") {
        out[i].lastOfTurn = true;
        break;
      }
    }
  }
  return out;
}

/** Compact token count: 987, 1.2k, 12k, 1.3M. */
/** Marks a control that only works when the page talks to the admin server
 *  (BOB_WEB=1): Telegram push/follow, audio transcription. */
function ServerIcon() {
  return (
    <span class="srv" title="Needs the admin server (BOB_WEB=1)">
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <rect x="1.5" y="1.2" width="9" height="3.7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <rect x="1.5" y="7.1" width="9" height="3.7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <circle cx="3.6" cy="3.05" r=".8" fill="currentColor" />
        <circle cx="3.6" cy="8.95" r=".8" fill="currentColor" />
      </svg>
    </span>
  );
}

function fmtTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** The per-turn token line, or null when the turn used no model calls. */
function tokenLine(t: TurnTokens | null | undefined): string | null {
  if (!t || t.calls < 1) return null;
  const calls = t.calls === 1 ? "1 call" : `${t.calls} calls`;
  return `\u21c5 ${fmtTokenCount(t.input)} in \u00b7 ${fmtTokenCount(t.output)} out \u00b7 ${calls}`;
}

function MemoryPanel(props: { app: string }) {
  const [inspect, setInspect] = createSignal<{ path: string; value: unknown } | null>(null);
  const entries = createMemo(() => {
    const m = state.memory[props.app] || {};
    return Object.entries(m)
      .map(([path, value]) => ({ path, value, depth: (path.match(/\//g) || []).length }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
  // Which conversation these values belong to, and whether it was resumed.
  // A fresh chat shows a fresh key; a pick/reload says "resumed". Never a
  // value without a session it can be attributed to.
  const origin = createMemo(() => {
    const key = state.memorySession;
    if (!key) return null;
    const short = key.length > 20 ? `${key.slice(0, 18)}…` : key;
    return `${state.sessionResumed ? "resumed " : ""}${short}`;
  });
  const shown = (v: unknown) => {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return t.length > 200 ? t.slice(0, 200) + "…" : t;
  };
  // Collapsed per tile, persisted in the layout store (tiles remount on every
  // session switch, so a local signal would reset it constantly).
  const memOpen = createMemo(() => !state.layout.memClosed.includes(props.app));
  return (
    <div class="mem">
      <button class="panel-title as-button" onClick={() => toggleMem(props.app)}>
        memory <span class="count">{entries().length}</span>
        <Show when={origin()}>
          {(label) => (
            <span class="prov-dim mem-origin" title={`values belong to ${state.memorySession}`}>
              {" · "}
              {label()}
            </span>
          )}
        </Show>{" "}
        {memOpen() ? "▾" : "▸"}
      </button>
      <Show when={memOpen()}>
        <Show when={entries().length} fallback={<div class="empty">no memory values yet</div>}>
          <ul class="mem-list">
            <For each={entries()}>
              {(e) => (
                <li
                  style={{ "padding-left": `${e.depth * 12}px` }}
                  title={`${e.path} — click to inspect`}
                  onClick={() => setInspect({ path: e.path, value: e.value })}
                >
                  <span class="mem-key">{e.path.split("/").pop()}</span>
                  <span class="mem-val">{shown(e.value)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      {/* The inspector renders through a Portal: `.tile`'s container-type makes it
          the containing block for fixed-position children (and overflow: hidden
          clips them), so a plain fixed modal would be confined to the tile — same
          reason RailCard portals its fixed card. */}
      <Show when={inspect()}>
        {(sel) => (
          <Portal>
            <div class="mem-modal" onClick={(ev) => ev.target === ev.currentTarget && setInspect(null)}>
              <div class="mem-modal-card">
                <div class="mem-modal-head">
                  <span class="mem-modal-path">{sel().path}</span>
                  <span class="spacer" />
                  <button onClick={() => setInspect(null)}>✕</button>
                </div>
                <div class="mem-modal-body"><JsonView value={sel().value} renderRef={refLink} /></div>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}

// ── event inspector ────────────────────────────────────────────────────
// Every row in the event stream (global and per-tile) opens this modal rather
// than expanding inline: the payload gets room, and a re-render of the stream
// can never collapse an open row. One shared signal, so whichever row is
// clicked, the same modal opens.
const [eventView, setEventView] = createSignal<EventLine | null>(null);

function openEvent(line: EventLine): void {
  setEventView(line);
}

function closeEvent(): void {
  setEventView(null);
}

/** The full event payload. The "event" tab is the sanitized live payload; the
 *  "full row" tab fetches the untruncated run-log row (complete messages, no
 *  400-char caps). LLM calls open on the full row automatically — their live
 *  detail only summarizes the (huge) message history. */
export function EventModal() {
  const [full, setFull] = createSignal<{ text: string; chars: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [tab, setTab] = createSignal<"event" | "full">("event");
  const [err, setErr] = createSignal("");

  const copy = async (text: string, label: string): Promise<void> => {
    const ok = await copyText(text);
    toast(ok ? `copied ${label}` : "clipboard blocked", !ok);
  };

  const copyMessages = (text: string): void => {
    try {
      const parsed = JSON.parse(text) as { messages?: unknown };
      if (!Array.isArray(parsed.messages)) {
        toast("this event has no message array", true);
        return;
      }
      void copy(JSON.stringify(parsed.messages, null, 2), `${parsed.messages.length} messages`);
    } catch {
      toast("could not parse the full event", true);
    }
  };

  const loadFull = async (line: EventLine): Promise<void> => {
    const seq = line.seq;
    if (!seq) return;
    setLoading(true);
    setErr("");
    try {
      const target = await fetchRef(seq);
      // A slower fetch must not replace a payload the user has since opened.
      if (eventView() !== line) return;
      setFull({ text: target.value, chars: target.chars, truncated: target.truncated });
      setTab("full");
    } catch (e) {
      if (eventView() === line) setErr(e instanceof Error ? e.message : "could not load the full row");
    } finally {
      if (eventView() === line) setLoading(false);
    }
  };

  // A fresh line resets the modal, then eagerly loads the full row for LLM
  // calls: the exact prompt is the point of inspecting them.
  createEffect(() => {
    const line = eventView();
    if (!line) return;
    setFull(null);
    setErr("");
    setLoading(false);
    setTab("event");
    if (line.kind === "llm_call" && line.seq) void loadFull(line);
  });

  return (
    <Show when={eventView()}>
      {(line) => (
        <div
          class="mem-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`${line().kind} event`}
          onClick={(ev) => ev.target === ev.currentTarget && closeEvent()}
        >
          <div class="mem-modal-card ev-modal-card">
            <div class="mem-modal-head">
              <span class="badge">{line().badge}</span>
              <span class="ev-modal-title">
                {line().app} · {line().kind}
                <span class="prov-dim">
                  {" · "}
                  {new Date(line().ts).toLocaleTimeString()}
                  {line().seq ? ` · seq ${line().seq}` : ""}
                </span>
              </span>
              <span class="spacer" />
              <Show when={loading()}>
                <span class="spinner" />
              </Show>
              <Show when={line().seq}>
                <button
                  type="button"
                  disabled={loading()}
                  title="fetch the untruncated run-log row"
                  onClick={() => void loadFull(line())}
                >
                  {full() ? "reload full" : "full row"}
                </button>
              </Show>
              <button type="button" title="close" onClick={closeEvent}>
                ✕
              </button>
            </div>
            <div class="ev-modal-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab() === "event"}
                classList={{ active: tab() === "event" }}
                onClick={() => setTab("event")}
              >
                event
              </button>
              <Show when={line().seq}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab() === "full"}
                  classList={{ active: tab() === "full" }}
                  onClick={() => {
                    setTab("full");
                    if (!full() && !loading()) void loadFull(line());
                  }}
                >
                  full row
                  {full() ? ` · ${full()!.chars} chars${full()!.truncated ? " · truncated" : ""}` : ""}
                </button>
              </Show>
            </div>
            <Show when={err()}>
              <div class="prov-err">{err()}</div>
            </Show>
            <div class="mem-modal-body ev-modal-body">
              <Show
                when={tab() === "full"}
                fallback={<JsonView text={line().detail} renderRef={refLink} />}
              >
                <Show
                  when={full()}
                  fallback={
                    <div class="empty">
                      {loading()
                        ? "loading the run-log row…"
                        : line().seq
                          ? "the full row is not loaded"
                          : "this event has no run-log row"}
                    </div>
                  }
                >
                  {(value) => <JsonView text={value().text} startDepth={3} renderRef={refLink} />}
                </Show>
              </Show>
            </div>
            <div class="ev-modal-actions">
              <button type="button" onClick={() => void copy(line().detail, "event detail")}>
                copy event
              </button>
              <Show when={full()}>
                {(value) => (
                  <>
                    <button type="button" onClick={() => void copy(value().text, "full row")}>
                      copy full
                    </button>
                    <button type="button" onClick={() => copyMessages(value().text)}>
                      copy messages
                    </button>
                  </>
                )}
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

// A single log line. Clicking it opens the event inspector above; turn
// boundaries are synthetic rows, not events, so they stay plain dividers.
function LogRow(props: { line: EventLine; showApp?: boolean }) {
  if (props.line.kind === "turn") {
    return (
      <div class="log-sep" title={`turn started ${new Date(props.line.ts).toLocaleTimeString()}`}>
        {props.line.text}
      </div>
    );
  }
  return (
    <div
      class="log-row"
      classList={{ emit: props.line.emit, [props.line.cls]: !!props.line.cls }}
      role="button"
      tabindex="0"
      aria-haspopup="dialog"
      title="open the full event"
      onClick={() => openEvent(props.line)}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openEvent(props.line);
        }
      }}
    >
      <Show when={props.showApp}>
        <span class="stream-app">{props.line.app}</span>
      </Show>
      <span class="badge">{props.line.badge}</span>
      <span class="log-text"><RefText text={props.line.text} inline /></span>
    </div>
  );
}

// ── ref:// handles ─────────────────────────────────────────────────────
// A `ref://<seq>`, `ref://<seq>/<path>` or `ref://<label>.<seq>` token in any
// text becomes a link that opens the referenced run-log row in the inspector.
// The token can sit inside markdown (bold, a list item, a table cell, …): the
// renderer hands every running-text leaf to `renderRef`.

/** The row seq and optional `/path` a ref token points at. */
function parseRef(token: string): { seq: number; path: string | null } | null {
  const body = token.slice("ref://".length);
  const [head, ...rest] = body.split("/");
  const m = /(\d+)$/.exec(head); // "146629" or "rows.146629"
  if (!m) return null;
  return { seq: Number(m[1]), path: rest.length ? rest.join("/") : null };
}

/** One `ref://…` handle as a clickable inspect link; a token without a row
 *  number stays plain text. Shared by markdown text and the JSON tree. */
function refLink(token: string): JSX.Element {
  const r = parseRef(token);
  if (!r) return token;
  return (
    <button
      class="ref-link"
      title={`inspect ${token}`}
      onClick={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openRef(r.seq, r.path);
      }}
    >
      {token}
    </button>
  );
}

/** Render text as markdown, with any `ref://…` tokens as clickable inspect
 *  links. `inline` flattens block syntax for one-line surfaces (log rows). */
function RefText(props: { text: string; inline?: boolean }) {
  return <Markdown text={props.text} inline={props.inline} renderRef={refLink} />;
}

/** The ref inspector: the run-log row a `ref://…` handle points at, in full. */
export function RefModal() {
  const [data, setData] = createSignal<RefTarget | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal("");
  createEffect(() => {
    const t = refView();
    if (!t) return;
    setLoading(true);
    setErr("");
    setData(null);
    fetchRef(t.seq, t.path)
      .then((d) => setData(d))
      .catch((e) => setErr(e instanceof Error ? e.message : "ref lookup failed"))
      .finally(() => setLoading(false));
  });
  return (
    <Show when={refView()}>
      {(t) => (
        <div class="mem-modal ref-modal" onClick={(ev) => ev.target === ev.currentTarget && closeRef()}>
          <div class="mem-modal-card">
            <div class="mem-modal-head">
              <span class="mem-modal-path">ref://{t().seq}{t().path ? `/${t().path}` : ""}</span>
              <span class="spacer" />
              <Show when={loading()}>
                <span class="spinner" />
              </Show>
              <button onClick={closeRef}>✕</button>
            </div>
            <div class="prov-body">
              <Show when={err()}>
                <div class="prov-err">{err()}</div>
              </Show>
              <Show when={data()}>
                {(d) => (
                  <>
                    <div class="prov-meta">
                      <span class="prov-slot">{d().child || d().kind}</span>
                      <span class="prov-dim">
                        {` · ${d().kind}${d().op ? ` · ${d().op}` : ""}`}
                        {d().branchPath ? ` · ${d().branchPath}` : ""} · seq {d().seq} · {d().when}
                      </span>
                    </div>
                    <div class="prov-dim">
                      {d().chars} chars{d().truncated ? " — shown truncated" : ""}
                    </div>
                    <div class="prov-value ref-value"><JsonView text={d().value} renderRef={refLink} /></div>
                  </>
                )}
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

/** Lines the log builds per recompute. The display shows the last 200; we build
 *  a little more for a stable window, and never walk the whole history. */
const LOG_WINDOW = 400;

/** How many of a line window are tool calls (kind `tool_call`). */
const toolCallCount = (lines: EventLine[]) => lines.filter((l) => l.kind === "tool_call").length;

/** How many of a line window are prompts (kind `llm_call`, one per round). */
const promptCount = (lines: EventLine[]) => lines.filter((l) => l.kind === "llm_call").length;

/** Sum the reported tokens of a line window. `calls` counts only lines that
 *  carried usage, so an empty sum means "not reported", never a real 0/0. */
const tokenSum = (lines: EventLine[]) => {
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const l of lines) {
    if (!l.usage) continue;
    input += l.usage.input;
    output += l.usage.output;
    calls += 1;
  }
  return { input, output, calls };
};

/** The header segment shared by the per-tile log and the global stream. */
const tokenTitle = (t: { input: number; output: number; calls: number }) =>
  `${t.input} in · ${t.output} out across ${t.calls} model call${t.calls === 1 ? "" : "s"}`;

function EventLog(props: { app: string }) {
  const [open, setOpen] = createSignal(false);
  const lines = createMemo<EventLine[]>(() => {
    const out: EventLine[] = [];
    // Newest-first walk, stopped at the window — O(window), not O(all events).
    // This is what kept the memo from going quadratic during a big run.
    for (let ti = state.turns.length - 1; ti >= 0 && out.length < LOG_WINDOW; ti--) {
      const evs = state.turns[ti].events;
      for (let ei = evs.length - 1; ei >= 0 && out.length < LOG_WINDOW; ei--) {
        const ev = evs[ei];
        if (trunkOf(ev.app) === props.app) out.push(describeEvent(ev));
      }
    }
    out.reverse();
    return out;
  });
  const tools = createMemo(() => toolCallCount(lines()));
  const prompts = createMemo(() => promptCount(lines()));
  const tokens = createMemo(() => tokenSum(lines()));
  return (
    <div class="evlog">
      <button class="panel-title as-button" onClick={() => setOpen(!open())}>
        events <span class="count">{lines().length}</span>
        {" · "}prompts <span class="count prompt">{prompts()}</span>
        {" · "}tool calls <span class="count tool">{tools()}</span>
        <Show when={tokens().calls}>
          {" · "}tokens{" "}
          <span class="count tok" title={tokenTitle(tokens())}>
            {fmtTokenCount(tokens().input)}/{fmtTokenCount(tokens().output)}
          </span>
        </Show>{" "}
        {open() ? "▾" : "▸"}
      </button>
      <Show when={open()}>
        <div class="ev-list">
          <For each={lines().slice(-200)}>{(l) => <LogRow line={l} />}</For>
        </div>
      </Show>
    </div>
  );
}

function Composer(props: { app: string }) {
  const [text, setText] = createSignal("");
  let ta: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  // Grow the textarea with its content (up to a cap); reset when emptied.
  const autosize = () => {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };
  createEffect(() => {
    text();
    autosize();
  });
  const lastButtons = createMemo(() => {
    for (let i = state.turns.length - 1; i >= 0; i--) {
      const t = state.turns[i];
      if (t.status === "running") continue;
      // A quota wall's model choices replace any emitted buttons on that turn.
      if (t.fallback?.length) return [];
      if (t.buttons?.length) return t.buttons;
      break;
    }
    return [];
  });
  // Model fallbacks offered by the LAST turn (a quota wall). Shown only while
  // that turn is still the latest — a new turn clears the prompt, so the user
  // cannot fall back twice.
  const fallback = createMemo(() => {
    const last = state.turns[state.turns.length - 1];
    if (!last || last.status === "running") return [];
    if ((last.inputApp ?? "trunk") !== props.app) return [];
    return last.fallback ?? [];
  });
  // ── file upload: audio streams a transcript; anything else attaches ──
  const AUDIO_RE = /\.(ogg|oga|opus|webm|mp3|m4a|mp4|wav|flac)$/i;
  const [card, setCard] = createSignal<{
    name: string;
    status: string;
    text: string;
    state: "run" | "done" | "err";
  } | null>(null);

  const onPick = async (file: File) => {
    if (!(file.type.startsWith("audio/") || AUDIO_RE.test(file.name))) {
      const caption = text();
      setText("");
      try {
        await sendFile(file, caption);
      } catch {
        /* toasted in the store */
      }
      return;
    }
    // Audio streams a transcript from the admin's STT backend; it is not part
    // of the in-browser backend. Keep the composer honest when no server is up.
    if (!state.adminOnline) {
      setCard({
        name: file.name,
        status: "needs the admin server",
        text: "Audio transcription needs the admin server — start BOB with BOB_WEB=1. Any other file still attaches.",
        state: "err",
      });
      return;
    }
    let duration = 0;
    setCard({ name: file.name, status: "uploading…", text: "", state: "run" });
    try {
      const finalText = await transcribeFileStream(file, {
        onInfo: (d) => {
          duration = d;
          setCard((c) => c && { ...c, status: d ? `0s / ${d}s` : "transcribing…" });
        },
        onPartial: (t, at) => {
          setCard((c) =>
            c && {
              ...c,
              text: t,
              status: duration && at != null ? `${Math.min(at, duration)}s / ${duration}s` : c.status,
            },
          );
        },
      });
      setCard((c) =>
        c && {
          ...c,
          state: "done",
          status: `transcribed${duration ? ` (${duration}s)` : ""}`,
          text: finalText,
        },
      );
      setText(finalText);
      ta?.focus();
    } catch (e) {
      setCard((c) =>
        c && { ...c, state: "err", status: "failed", text: e instanceof Error ? e.message : String(e) },
      );
    }
  };

  const submit = () => {
    const v = text();
    if (!v.trim()) return;
    setText("");
    void send(v);
  };
  return (
    <div class="composer">
      <Show when={card()}>
        {(c) => (
          <div class="file-card" classList={{ done: c().state === "done", err: c().state === "err" }}>
            <div class="fc-head">
              <Show when={c().state === "run"}>
                <span class="spinner" />
              </Show>
              <span class="fc-name">{c().name}</span>
              <span class="fc-status">{c().status}</span>
            </div>
            <Show when={c().text}>
              <div class="fc-text">{c().text}</div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={fallback().length}>
        <div class="buttons fallback-btns">
          <span class="fallback-note">model out of credit — fall back to:</span>
          <For each={fallback()}>
            {(b) => (
              <button class="btn-choice fallback" onClick={() => void chooseFallback(b.value)}>
                {b.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={lastButtons().length}>
        <div class="buttons">
          <For each={lastButtons()}>
            {(b) => (
              <button class="btn-choice" onClick={() => void send(b.value)}>
                {b.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="composer-row">
        <button class="icon-btn" title="attach a file" onClick={() => fileInput?.click()}>
          📎
        </button>
        <input
          ref={(el) => (fileInput = el)}
          class="hidden-input"
          type="file"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) void onPick(f);
          }}
        />
        <textarea
          ref={(el) => (ta = el)}
          rows="1"
          placeholder={props.app === "trunk" ? "reply…" : `reply to ${props.app}…`}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button onClick={submit}>Send</button>
      </div>
    </div>
  );
}

// ── provenance: "what was this message written from" ────────────────────
// The info icon on a bot bubble opens this. The data comes from
// /api/provenance — a walk over the run log from the message's emit row: the
// prompt that produced it, the memory slots it read (and who wrote them),
// ref:// handles, and the ground facts at the bottom of the read-graph.

const resolvedLabel = (p: ProvPiece): string => {
  switch (p.resolved) {
    case "read-link":
      return "written by";
    case "latest-write":
      return "written earlier — latest write";
    case "human":
      return "you said";
    default:
      return "host seed";
  }
};

const writerHead = (w: ProvWriter): string =>
  `${w.kind}${w.op ? ` · ${w.op}` : ""}${w.child ? ` · ${w.child}` : ""}`;

function PieceRow(props: { piece: ProvPiece; depth: number }) {
  const p = () => props.piece;
  const [open, setOpen] = createSignal(false);
  const preview = (w: ProvWriter) => {
    const one = w.text.replace(/\s+/g, " ").trim();
    return one.length > 160 ? one.slice(0, 160) + "…" : one || "(no value)";
  };
  return (
    <div class="prov-piece" style={{ "padding-left": `${Math.min(props.depth, 5) * 14}px` }}>
      <div class="prov-piece-head">
        <span class="prov-slot">{p().name}</span>
        <Show when={p().scopePath}>
          <span class="prov-dim"> @{p().scopePath}</span>
        </Show>
        <span class="spacer" />
        <span class="prov-res">{resolvedLabel(p())}</span>
      </div>
      <Show
        when={p().writer}
        fallback={
          <div class="prov-writer none">
            <span class="prov-val">no write recorded — a host seed or an older run</span>
          </div>
        }
      >
        {(w) => (
          <div class="prov-writer" onClick={() => setOpen(!open())} title="click to expand the full value">
            <div class="prov-writer-line">
              {writerHead(w())}
              <span class="prov-dim"> · seq {w().seq} · {w().when}</span>
            </div>
            <Show when={!open()}>
              <div class="prov-val">{preview(w())}</div>
            </Show>
            <Show when={open()}>
              <div class="prov-value">
                <JsonView text={w().text || "(no value)"} startDepth={1} renderRef={refLink} />
                <Show when={w().truncated}>
                  <div class="jv-note">… ({w().chars} chars total)</div>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={p().reads?.length}>
        <For each={p().reads}>{(sub) => <PieceRow piece={sub} depth={props.depth + 1} />}</For>
      </Show>
    </div>
  );
}

function ProvenanceModal(props: { turnId: string; bubble: number; text: string; onClose: () => void }) {
  const [data, setData] = createSignal<Provenance | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [err, setErr] = createSignal("");
  const load = async (depth: number) => {
    setLoading(true);
    setErr("");
    try {
      setData(await fetchProvenance({ turnId: props.turnId, bubble: props.bubble, text: props.text, depth }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "provenance failed");
    } finally {
      setLoading(false);
    }
  };
  void load(1);

  return (
    <div class="mem-modal" onClick={(ev) => ev.target === ev.currentTarget && props.onClose()}>
      <div class="mem-modal-card prov-card">
        <div class="mem-modal-head">
          <span class="mem-modal-path">written from</span>
          <span class="spacer" />
          <Show when={loading()}>
            <span class="spinner" />
          </Show>
          <Show when={data()?.truncated}>
            <span class="prov-note" title="a breadth cap cut the walk short">trace capped</span>
          </Show>
          <button onClick={props.onClose}>✕</button>
        </div>
        <div class="prov-body">
          <Show when={err()}>
            <div class="prov-err">{err()}</div>
          </Show>
          <Show when={data()}>
            {(d) => (
              <>
                <div class="prov-sec">
                  <div class="prov-title">the message</div>
                  <div class="prov-emit"><RefText text={d().emit.text || "(empty)"} /></div>
                  <div class="prov-dim prov-emit-meta">
                    seq {d().emit.seq}
                    {d().emit.branchPath ? ` · ${d().emit.branchPath}` : ""} · {d().emit.when}
                  </div>
                </div>

                <Show
                  when={d().prompt}
                  fallback={<div class="prov-sec"><div class="prov-title">the prompt</div><div class="empty">no prompt was logged before this message</div></div>}
                >
                  {(p) => (
                    <div class="prov-sec">
                      <div class="prov-title">the prompt that wrote it</div>
                      <div class="prov-meta">
                        <span class="prov-slot">{p().child || "(unnamed)"}</span>
                        <span class="prov-dim"> · {p().model ?? "?"} · round {p().round ?? 1}
                          {p().branchPath ? ` · ${p().branchPath}` : ""} · seq {p().seq} · {p().when}</span>
                      </div>
                      <Show when={d().match === "nearest"}>
                        <div class="prov-warn">
                          no exact text match in the log — showing the closest prompt before this message
                        </div>
                      </Show>
                      <Show when={p().rounds.length > 1}>
                        <div class="prov-dim">
                          rounds: {p().rounds.map((r) => `#${r.round ?? "?"} (seq ${r.seq})`).join(", ")}
                        </div>
                      </Show>
                      <details class="prov-prompt">
                        <summary>
                          view prompt ({p().messageCount} message{p().messageCount === 1 ? "" : "s"}, {p().messageChars} chars)
                        </summary>
                        <div class="prov-msgs">
                          <For each={p().messages}>
                            {(m) => (
                              <div class="prov-msg">
                                <div class="prov-msg-role">
                                  {m.role}
                                  <span class="prov-dim"> · {m.chars} chars{m.truncated ? " · truncated" : ""}</span>
                                </div>
                                <div class="prov-msg-body"><RefText text={m.content} /></div>
                              </div>
                            )}
                          </For>
                        </div>
                      </details>
                    </div>
                  )}
                </Show>

                <div class="prov-sec">
                  <div class="prov-title">memory & slots it read</div>
                  <Show when={d().pieces.length} fallback={<div class="empty">nothing recorded for this prompt</div>}>
                    <For each={d().pieces}>{(piece) => <PieceRow piece={piece} depth={0} />}</For>
                  </Show>
                  <Show when={d().pieces.length && d().depth < d().maxDepth}>
                    <button class="prov-deeper" disabled={loading()} onClick={() => void load(d().depth + 1)}>
                      trace deeper ⤵ — show what those pieces were written from (depth {d().depth + 1})
                    </button>
                  </Show>
                </div>

                <Show when={d().refs.length}>
                  <div class="prov-sec">
                    <div class="prov-title">passed by reference (ref://)</div>
                    <For each={d().refs}>
                      {(r) => (
                        <div class="prov-ref">
                          <span class="prov-slot"><RefText text={`ref://${r.seq}`} inline /></span>
                          <span class="prov-dim"> · {r.kind}{r.child ? ` · ${r.child}` : ""}</span>
                          <div class="prov-val">{r.text.replace(/\s+/g, " ").slice(0, 200)}</div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={d().leaves.length}>
                  <div class="prov-sec">
                    <div class="prov-title">ground facts</div>
                    <For each={d().leaves}>
                      {(l) => (
                        <div class="prov-leaf">
                          <span class="prov-slot">{l.child || l.kind}</span>
                          <span class="prov-dim">
                            {` · ${l.kind}${l.op ? ` · ${l.op}` : ""}`} · seq {l.seq} · {l.when}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

// Tile reordering is pointer-based, not HTML5 drag-and-drop: Firefox (and so
// FireDragon) never starts the native element drag when the press lands on
// text, and once the text is `user-select: none` it starts no drag at all —
// Chromium walks up to the `draggable` ancestor, Firefox does not. A
// pointerdown + movement threshold behaves the same in every engine.
// `dragging` is the tile being moved; `dropTarget` is the tile under the
// pointer — where it will land if released now.
const [dragging, setDragging] = createSignal<string | null>(null);
const [dropTarget, setDropTarget] = createSignal<string | null>(null);

/** The app currently executing: walk the running turn's events through the same
 *  boundary stack the server uses (src/app-attribution.ts). Every app tree opens
 *  its own tile, even nested inside another app (enrich-profile calling
 *  contacts); a non-app tree tool is a capability and stays with the app around
 *  it. Until /api/apps lands, fall back to the legacy outermost rule instead of
 *  tagging a nested run "trunk". */
function currentRunningApp(): string | null {
  const t = state.turns.find((x) => x.status === "running");
  if (!t) return null;
  const st = newTurnApps(state.apps.length ? state.apps.map((a) => a.name) : undefined);
  for (const e of t.events) tagEventApp(st, e);
  return st.current;
}

/** The app a failed last turn was headed to: its tile shows the error and the
 *  composer's retry. */
function erroredApp(): string | null {
  const last = state.turns[state.turns.length - 1];
  return last && last.status === "error" ? (last.inputApp ?? "trunk") : null;
}

export function Tile(props: { app: AppInfo }) {
  const name = () => props.app.name;
  const expanded = () => state.layout.expanded.includes(name());
  const wide = () => state.layout.wide.includes(name());
  // A pinned tile keeps its place and is the only kind that can be dragged; an
  // unpinned tile follows recent activity, so a manual drop would be undone by
  // the next event (moveTile refuses it too).
  const pinned = () => state.layout.pinned.includes(name());
  const paused = () => state.awaiting === name();
  const over = () => dragging() !== null && dragging() !== name() && dropTarget() === name();
  // The trunk is the board's home tile: docked across the bottom row, so it has
  // no pin or drag seat of its own and already spans every column. It keeps the
  // expand toggle (a taller dock) and the park gesture.
  const isTrunk = () => props.app.group === "trunk";
  // This tile's sub-apps: every child is a rail square (board order); the
  // opened ones render side-by-side beside this tile's chat (open order).
  const kids = createMemo(() => subApps(name()));
  const openKids = createMemo(() => openSubApps(name()));
  // The ✕ parks the tile: a board tile into the board's left rail, a parented
  // one into its parent's sub rail — the parent's square list is the seat.
  const park = () => (props.app.parent ? toggleSub(name()) : toggleHidden(name()));
  // Pointer-drag state for this tile: `arm` is set on pointerdown (before the
  // movement threshold), `drag` once the tile is actually being dragged.
  let arm: { id: number; x: number; y: number } | null = null;
  let drag = false;
  let ghost: HTMLDivElement | null = null;
  // The app currently executing (shared with the hidden-tile rail).
  const running = createMemo(() => currentRunningApp() === name());
  const bubbles = createMemo(() => bubblesFor(name()));
  const chatRef = { el: undefined as HTMLDivElement | undefined };
  // The bubble whose provenance panel is open (null = closed).
  const [prov, setProv] = createSignal<{ turnId: string; bubble: number; text: string } | null>(null);

  createEffect(() => {
    bubbles();
    const el = chatRef.el;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // One composer in the whole UI: the tile whose tree the session is parked on
  // (the current Human). A fresh session has no pause yet, so the composer
  // starts on the trunk (matching the server's `inputApp ?? "trunk"`); while a
  // turn runs the store nulls `awaiting`, so nothing is shown — a message sent
  // mid-run would land on the trunk anyway. A failed turn keeps a retry
  // composer on the app it was headed to.
  const retryApp = createMemo(() => erroredApp());
  const parkedApp = createMemo(() => {
    if (state.awaiting != null) return state.awaiting;
    if (state.turns.some((t) => t.status === "running")) return null;
    return "trunk";
  });
  const showInput = () => parkedApp() === name() || retryApp() === name();

  const errored = createMemo(() => erroredApp() === name());
  const statusText = () => (paused() ? "waiting" : running() ? "running" : errored() ? "error" : "idle");

  // Pointer-based drag: press, move past a small threshold, release on the
  // target tile. A small label follows the cursor; `elementFromPoint` decides
  // the landing tile (the ghost is pointer-events: none, so it never
  // hit-tests). Only controls and selectable text opt out (see pointerdown).
  const ghostAt = (x: number, y: number) => {
    if (ghost) {
      ghost.style.left = `${x}px`;
      ghost.style.top = `${y}px`;
    }
  };
  const beginDrag = (x: number, y: number) => {
    drag = true;
    setDragging(name());
    setDropTarget(null);
    document.body.classList.add("dragging-tile");
    window.getSelection()?.removeAllRanges();
    ghost = document.createElement("div");
    ghost.className = "tile-ghost";
    ghost.textContent = name();
    document.body.appendChild(ghost);
    ghostAt(x, y);
  };
  const finishDrag = () => {
    arm = null;
    drag = false;
    setDragging(null);
    setDropTarget(null);
    document.body.classList.remove("dragging-tile");
    ghost?.remove();
    ghost = null;
  };

  return (
    <section
      class="tile"
      classList={{
        expanded: expanded(),
        wide: wide(),
        paused: paused(),
        errored: errored(),
        pinned: pinned(),
        "drop-target": over(),
        // The trunk docks across the grid's bottom row, outside the drag order.
        "trunk-dock": isTrunk(),
      }}
      data-tile={name()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // The trunk dock has no seat in the grid's manual order.
        if (isTrunk()) return;
        // Only pinned tiles are manually ordered (see moveTile): unpinned tiles
        // follow recent activity, so arming a drag on one would promise a move
        // the next event takes back.
        if (!pinned()) return;
        // Presses on controls and selectable text keep their native behavior
        // (buttons, the composer, links, chat bubbles, token lines, the
        // memory/event panels); everything else on the tile arms a drag.
        const t = e.target as HTMLElement;
        if (t.closest("button, input, textarea, select, a, label, .bubble, .turn-tokens, .tile-panels, .mem-modal")) return;
        // A press inside a nested tile is that tile's business, never this
        // tile's drag arm.
        const inner = (t.closest(".tile") as HTMLElement | null) ?? null;
        if (inner && inner !== e.currentTarget) return;
        arm = { id: e.pointerId, x: e.clientX, y: e.clientY };
        // Keep receiving moves after the pointer leaves the tile. Synthetic
        // pointers (tests) have nothing to capture; that is fine.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}
      }}
      onPointerMove={(e) => {
        if (!arm || e.pointerId !== arm.id) return;
        if (!drag) {
          if (Math.hypot(e.clientX - arm.x, e.clientY - arm.y) < 5) return;
          beginDrag(e.clientX, e.clientY);
        }
        e.preventDefault();
        ghostAt(e.clientX, e.clientY);
        const selfEl = e.currentTarget as HTMLElement;
        const overEl = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest(".tile") as HTMLElement | null;
        const overName = overEl?.getAttribute("data-tile") ?? null;
        // Land only on another pinned tile: the unpinned block has no manual
        // order to land in. Not on the trunk dock (it has no grid seat), and
        // not across the frame edge: into one's own sub-app strip, or onto an
        // ancestor while dragging a nested tile — those are layout frames, not
        // board seats.
        const valid =
          !!overName &&
          overName !== name() &&
          state.layout.pinned.includes(overName) &&
          !!overEl &&
          !overEl.classList.contains("trunk-dock") &&
          !overEl.contains(selfEl) &&
          !selfEl.contains(overEl);
        setDropTarget(valid ? overName : null);
      }}
      onPointerUp={(e) => {
        if (!arm || e.pointerId !== arm.id) return;
        const to = drag ? dropTarget() : null;
        finishDrag();
        if (to) moveTile(name(), to);
      }}
      onPointerCancel={() => finishDrag()}
      // Capture also ends when the pointer is released outside the window; a
      // drag that never ended would leave the ghost behind.
      onLostPointerCapture={() => {
        if (drag) finishDrag();
      }}
    >
      {/* The fractal frame: this tile's own rail of parked sub-apps on the left,
          the tile's chat full height in the middle, opened sub-app tiles
          side-by-side on the right. A tile without sub-apps renders the main
          column alone — same look as before. */}
      <div class="tile-frame">
        <Show when={kids().length}>
          <SubRail parent={name()} />
        </Show>
        <div class="tile-main">
          <header class="tile-head">
            <span class="dot" classList={{ run: running(), wait: paused(), err: errored() }} />
            <span class="tile-name">{name()}</span>
            <span class="tile-status">{statusText()}</span>
            <span class="spacer" />
            <Show when={!isTrunk()}>
              <button
                class="tile-pin"
                classList={{ active: pinned() }}
                aria-pressed={pinned()}
                title={pinned() ? "unpin — let this tile move with recent activity" : "pin — keep this tile in place"}
                onClick={() => togglePinned(name())}
              >
                📌
              </button>
              <button title={wide() ? "stop spanning two columns" : "wide — span two columns"} onClick={() => toggleWide(name())}>
                ↔
              </button>
            </Show>
            {/* The trunk dock expands too: its height is a user choice like
                every tile's. Pin and wide stay hidden there — the dock has no
                grid seat to pin and already spans every column. */}
            <button title={expanded() ? "restore" : "expand"} onClick={() => toggleExpanded(name())}>
              {expanded() ? "⤡" : "⤢"}
            </button>
            <Show
              when={!isTrunk()}
              fallback={
                <button title="hide — parks it in the board rail" onClick={() => toggleHidden(name())}>
                  ✕
                </button>
              }
            >
              <button title={props.app.parent ? "park into the parent's rail" : "hide — parks it in the board rail"} onClick={park}>
                ✕
              </button>
            </Show>
          </header>
          <Show when={props.app.description}>
            <div class="tile-desc" title={props.app.guide || props.app.description}>
              {props.app.description}
            </div>
          </Show>
          <div class="chat" ref={(el) => (chatRef.el = el)}>
            <Show when={bubbles().length} fallback={<div class="empty">no messages yet</div>}>
              <For each={bubbles()}>
                {(b) => (
                  <>
                    <div
                      class="bubble"
                      classList={{
                        user: b.kind === "user",
                        bot: b.kind === "bot",
                        err: b.kind === "err",
                        machine:
                          b.kind === "bot" &&
                          b.emitIndex != null &&
                          b.turn.levels?.[b.emitIndex] === "machine",
                        "has-info":
                          b.kind === "bot" &&
                          b.emitIndex != null &&
                          b.emitIndex >= 0 &&
                          !!b.turn.runId &&
                          b.turn.levels?.[b.emitIndex] !== "machine",
                      }}
                    >
                      <RefText text={b.text} />
                      <Show
                        when={
                          b.kind === "bot" &&
                          b.emitIndex != null &&
                          b.emitIndex >= 0 &&
                          !!b.turn.runId &&
                          b.turn.levels?.[b.emitIndex] !== "machine"
                        }
                      >
                        <button
                          class="bubble-info"
                          title="what was this written from?"
                          onClick={() => setProv({ turnId: b.turn.turnId, bubble: b.emitIndex!, text: b.text })}
                        >
                          ⓘ
                        </button>
                      </Show>
                    </div>
                    <Show when={b.lastOfTurn ? tokenLine(b.turn.tokens) : null}>
                      {(line) => (
                        <div class="turn-tokens" title="tokens this turn used (input counts the full prompt on every model call)">
                          {line()}
                        </div>
                      )}
                    </Show>
                  </>
                )}
              </For>
            </Show>
          </div>
          <Show when={showInput()}>
            <Composer app={name()} />
          </Show>
          <div class="tile-panels">
            <MemoryPanel app={name()} />
            <EventLog app={name()} />
          </div>
          {/* Portaled like the memory inspector above: fixed positioning must
              escape `.tile`'s containment or the modal is clipped to the tile. */}
          <Show when={prov()}>
            {(p) => (
              <Portal>
                <ProvenanceModal turnId={p().turnId} bubble={p().bubble} text={p().text} onClose={() => setProv(null)} />
              </Portal>
            )}
          </Show>
        </div>
        <Show when={openKids().length}>
          <div class="tile-subs-area">
            <For each={openKids()}>{(a) => <Tile app={a} />}</For>
          </div>
        </Show>
      </div>
    </section>
  );
}

/** The flyout card a rail square reveals on hover/focus: one shared signal and
 *  one `<RailCard/>` (mount it once per screen). Two rails can never both
 *  reveal at once, so a single card cannot collide; fixed-positioned, since a
 *  rail with many squares scrolls and an absolutely-positioned card would be
 *  clipped by that scroll box. */
const [railCard, setRailCard] = createSignal<{ app: AppInfo; top: number; left: number } | null>(null);

function revealRailCard(app: AppInfo, el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  setRailCard({ app, top: Math.max(8, Math.min(r.top, window.innerHeight - 150)), left: r.right + 8 });
}

function hideRailCard(): void {
  setRailCard(null);
}

export function RailCard() {
  const running = createMemo(() => currentRunningApp());
  const failed = createMemo(() => erroredApp());
  const statusOf = (name: string): string =>
    state.awaiting === name ? "waiting" : running() === name ? "running" : failed() === name ? "error" : "idle";
  return (
    <Show when={railCard()}>
      {(cur) => (
        <Portal>
          <div class="hidden-info" style={{ top: `${cur().top}px`, left: `${cur().left}px` }} role="tooltip">
            <div class="hidden-info-head">
              <span class="hidden-info-name">{cur().app.name}</span>
              <span class="hidden-info-status">{statusOf(cur().app.name)}</span>
            </div>
            <Show when={cur().app.description}>
              <div class="hidden-info-desc">{cur().app.description}</div>
            </Show>
            <div class="hidden-info-hint">click to {state.layout.subsOpen.includes(cur().app.name) ? "park" : "open"}</div>
          </div>
        </Portal>
      )}
    </Show>
  );
}

/** One rail square: status-tinted while its app runs/waits/fails; hover or
 *  keyboard focus reveals the shared flyout card. Both the board's hidden rail
 *  and a parent tile's sub-app rail use this. */
function RailSquare(props: { app: AppInfo; label: string; open?: boolean; onClick: () => void }) {
  const running = createMemo(() => currentRunningApp() === props.app.name);
  const failed = createMemo(() => erroredApp() === props.app.name);
  return (
    <button
      type="button"
      class="hidden-app"
      classList={{
        run: running(),
        wait: state.awaiting === props.app.name,
        err: failed(),
        open: !!props.open,
      }}
      aria-label={props.label}
      onMouseEnter={(e) => revealRailCard(props.app, e.currentTarget)}
      onMouseLeave={hideRailCard}
      onFocus={(e) => revealRailCard(props.app, e.currentTarget)}
      onBlur={hideRailCard}
      onClick={props.onClick}
    />
  );
}

/** Hidden tiles live in a thin rail on the left of the board, one small square
 *  each (status-tinted while that app runs/waits/fails). Hover or keyboard focus
 *  reveals what a square is; click/tap puts the tile back on the board. */
export function HiddenRail() {
  const hidden = createMemo(() => hiddenApps());
  return (
    <Show when={hidden().length}>
      <aside class="hidden-rail" aria-label="hidden tiles" onScroll={hideRailCard}>
        <For each={hidden()}>
          {(a) => (
            <RailSquare
              app={a}
              label={`${a.name} (hidden) — show this tile`}
              onClick={() => {
                hideRailCard();
                toggleHidden(a.name);
              }}
            />
          )}
        </For>
      </aside>
    </Show>
  );
}

/** A parent tile's sub-app rail, inside the tile's left edge: one square per
 *  sub-app (board order), parked by default. Click opens the sub-tile beside
 *  the parent's chat; the square stays listed and highlighted while open —
 *  this rail is navigation, not a parking lot the tile leaves. */
function SubRail(props: { parent: string }) {
  const kids = createMemo(() => subApps(props.parent));
  return (
    <div class="tile-rail" aria-label={`${props.parent} sub-apps`} onScroll={hideRailCard}>
      <For each={kids()}>
        {(a) => (
          <RailSquare
            app={a}
            open={state.layout.subsOpen.includes(a.name)}
            label={
              state.layout.subsOpen.includes(a.name)
                ? `${a.name} (open) — park it back into this rail`
                : `${a.name} (parked) — open beside the parent's chat`
            }
            onClick={() => {
              hideRailCard();
              toggleSub(a.name);
            }}
          />
        )}
      </For>
    </div>
  );
}

export function Tiles(props: { apps: AppInfo[]; trunk?: AppInfo }) {
  // A wide tile spans two tracks. The CSS uses this flag to guarantee there are
  // two: a 2-span in a one-column grid invents a thin implicit track and squeezes
  // the other tiles into a strip at the right (see `.grid.has-wide`).
  const hasWide = () => props.apps.some((a) => state.layout.wide.includes(a.name));
  return (
    <>
      <div class="grid" classList={{ "has-wide": hasWide() }}>
        <For each={props.apps}>{(a) => <Tile app={a} />}</For>
      </div>
      {/* The trunk is the board's home tile: a full-width row below the square
          grid, docked to the bottom of the tiles viewport (sticky) while the
          app tiles scroll under it. It sits outside the grid so sticky has the
          whole scroll area as its containing block, not a single grid cell. */}
      <Show when={props.trunk}>{(t) => <Tile app={t()} />}</Show>
    </>
  );
}

export function GlobalStream() {
  const lines = createMemo(() => streamLines(state.turns));
  /** Divider rows are not events — keep the header's count about events. */
  const events = createMemo(() => lines().filter((l) => l.kind !== "turn").length);
  const tools = createMemo(() => toolCallCount(lines()));
  const prompts = createMemo(() => promptCount(lines()));
  const tokens = createMemo(() => tokenSum(lines()));
  let ref: HTMLDivElement | undefined;
  createEffect(() => {
    lines();
    if (ref && state.streamOpen) ref.scrollTop = ref.scrollHeight;
  });
  return (
    <aside class="stream" classList={{ collapsed: !state.streamOpen }}>
      <div class="stream-head">
        <div class="panel-title stream-title">
          event stream <span class="count">{events()}</span>
          {" · "}prompts <span class="count prompt">{prompts()}</span>
          {" · "}tool calls <span class="count tool">{tools()}</span>
          <Show when={tokens().calls}>
            {" · "}tokens{" "}
            <span class="count tok" title={tokenTitle(tokens())}>
              {fmtTokenCount(tokens().input)}/{fmtTokenCount(tokens().output)}
            </span>
          </Show>
        </div>
        <span class="stream-tools">
          <button
            type="button"
            title="Copy the full event stream (all events in the turn log) as JSON"
            onClick={(event) => {
              event.stopPropagation();
              void copyEventStream();
            }}
          >
            copy
          </button>
          <button
            type="button"
            title="Download the full event stream as JSON"
            onClick={(event) => {
              event.stopPropagation();
              void downloadEventStream();
            }}
          >
            ↓
          </button>
        </span>
        {/* Hiding the panel is also the toolbar button's job, but a close button
            inside it is where the eye looks first (and it is the only way out of
            the phone sheet besides the sticky toolbar). */}
        <button class="stream-close" title="hide the event stream" onClick={() => setStreamOpen(false)}>
          ✕
        </button>
      </div>
      <Show when={state.streamOpen}>
        <div class="stream-note">copy/download: latest 20 turns · all events per turn</div>
        <div class="stream-body" ref={ref}>
          <For each={lines().slice(-400)}>{(l) => <LogRow line={l} showApp />}</For>
        </div>
      </Show>
    </aside>
  );
}

export function SessionPanel(props: { onClose: () => void }) {
  const activeSession = createMemo(() => state.sessions.find((s) => s.key === state.active));
  // A local draft while editing the active session's name; null = show the
  // stored label.
  const [labelDraft, setLabelDraft] = createSignal<string | null>(null);
  const nameValue = () => labelDraft() ?? activeSession()?.label ?? "";
  const commitName = () => {
    void renameSession(nameValue());
    setLabelDraft(null);
  };
  return (
    <div class="drawer" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="drawer-card">
        <div class="drawer-head">
          <strong>session</strong>
          <span class="spacer" />
          <button onClick={props.onClose}>✕</button>
        </div>

        <Show when={!state.browserMode}>
          <label class="row">
            <input
              type="checkbox"
              checked={state.follow}
              disabled={!state.adminOnline}
              onChange={(e) => void setFollow(e.currentTarget.checked)}
            />
            follow the live Telegram conversation
            <ServerIcon />
          </label>
        </Show>

        <Show when={state.browserMode}>
          <label class="row">
            <input
              type="checkbox"
              checked={state.bridgeOn}
              disabled={!state.adminOnline}
              onChange={(e) => setBridge(e.currentTarget.checked)}
            />
            bridge this chat to Telegram while the tab is open
            <ServerIcon />
          </label>
        </Show>

        <label class="row">
          <input type="checkbox" checked={state.showMachine} onChange={() => toggleMachine()} />
          show machine notes (tree input, waiting and hand-offs)
        </label>

        <div class="row">
          <select onChange={(e) => e.currentTarget.value && void selectSession(e.currentTarget.value)}>
            <option value="" disabled selected={!state.active}>
              select a session…
            </option>
            <For each={state.sessions}>
              {(s) => (
                <option value={s.key} selected={state.active === s.key}>
                  {s.label || s.key}
                  {s.remote ? " (remote)" : ""}
                </option>
              )}
            </For>
          </select>
          <button class="secondary" onClick={() => void newSession()}>
            new chat
          </button>
        </div>
        <Show when={state.active}>
          <div class="row">
            <input
              type="text"
              placeholder="session name"
              value={nameValue()}
              onInput={(e) => setLabelDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
              }}
            />
            <button class="secondary" onClick={commitName}>
              rename
            </button>
          </div>
          <div class="row muted small">
            active: {activeSession()?.label || state.active}
            <span class="spacer" />
            <button class="danger" onClick={() => state.active && void deleteSession(state.active)}>
              delete
            </button>
            <button class="secondary" onClick={() => void clearConversation()}>
              clear conversation
            </button>
            {/* The in-browser target bridges continuously instead of pushing a
                one-shot transcript; the bridge checkbox above replaces this. */}
            <Show when={!state.browserMode}>
              <button
                class="secondary"
                disabled={!state.adminOnline}
                title={
                  state.adminOnline
                    ? "push this transcript to your linked Telegram chat"
                    : "needs the admin server (BOB_WEB=1)"
                }
                onClick={() => void sendToTelegram()}
              >
                ✈ telegram
                <ServerIcon />
              </button>
            </Show>
          </div>
        </Show>

        <hr />
        <label class="col">
          tree
          <select onChange={(e) => void setPattern(e.currentTarget.value)}>
            <For each={state.patterns}>
              {(p) => <option value={p.name} selected={state.pattern === p.name}>{p.name}</option>}
            </For>
          </select>
        </label>
        <div class="row">
          <label class="col">
            cheap model
            <select onChange={(e) => void setModel("cheap", e.currentTarget.value)}>
              <option value="" selected={!state.models.cheap}>default</option>
              <For each={state.slots}>
                {(s) => <option value={s.name} selected={state.models.cheap === s.name}>{s.name} · {s.model}</option>}
              </For>
            </select>
          </label>
          <label class="col">
            strong model
            <select onChange={(e) => void setModel("strong", e.currentTarget.value)}>
              <option value="" selected={!state.models.strong}>default</option>
              <For each={state.slots}>
                {(s) => <option value={s.name} selected={state.models.strong === s.name}>{s.name} · {s.model}</option>}
              </For>
            </select>
          </label>
        </div>
        <Show when={state.mockOnly}>
          <div class="muted small">
            mock models only — add real slots in Settings → Models JSON
          </div>
        </Show>
      </div>
    </div>
  );
}

/**
 * Upload files into the workspace with a normal OS file picker. The
 * destination folder is asked each time, remembered for next time, and
 * suggested from folders already in the workspace.
 *
 * The request goes to `/api/files/upload`, which both targets implement, so the
 * same button uploads into the OPFS sandbox, the storage bridge, or the Node
 * workspace.
 */
export function WorkspaceUpload() {
  let fileInput: HTMLInputElement | undefined;
  const LAST_DIR = "bob:upload-dir";
  const [files, setFiles] = createSignal<File[] | null>(null);
  const [dest, setDest] = createSignal("");
  const [dirs, setDirs] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);

  const lastDir = (): string => {
    try {
      return localStorage.getItem(LAST_DIR) || "assets/inbox";
    } catch {
      return "assets/inbox";
    }
  };

  /** Normalize a folder path; null when it tries to escape (`..`). */
  const normalizeDir = (raw: string): string | null => {
    const cleaned = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "").replace(/^\.\//, "");
    const parts = cleaned.split("/").filter((p) => p && p !== ".");
    if (parts.some((p) => p === "..")) return null;
    return parts.join("/");
  };

  const loadDirs = async (base: string): Promise<void> => {
    const found = new Set<string>();
    for (const dir of ["", normalizeDir(base) ?? ""]) {
      try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}`);
        const data = (await res.json()) as { files?: { name: string; isDir?: boolean }[] };
        for (const f of data.files ?? []) {
          if (f.isDir) found.add(dir ? `${dir}/${f.name}` : f.name);
        }
      } catch {
        /* suggestions are best-effort */
      }
    }
    setDirs([...found].sort());
  };

  const openPicker = (): void => {
    if (fileInput) fileInput.value = "";
    fileInput?.click();
  };

  const onPicked = (list: FileList | null): void => {
    if (!list || !list.length) return;
    setFiles(Array.from(list));
    setDest(lastDir());
    void loadDirs(lastDir());
  };

  const close = (): void => {
    if (!busy()) setFiles(null);
  };

  const upload = async (): Promise<void> => {
    const target = normalizeDir(dest());
    if (target === null) {
      toast("folder may not contain '..'", true);
      return;
    }
    const picked = files() ?? [];
    if (!picked.length) return;
    setBusy(true);
    let done = 0;
    for (const file of picked) {
      const fd = new FormData();
      fd.append("path", target);
      fd.append("file", file);
      try {
        const res = await fetch("/api/files/upload", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          toast(`upload failed: ${data.error || res.status}`, true);
          continue;
        }
        done++;
      } catch (e) {
        toast(`upload failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
    if (done) {
      try {
        localStorage.setItem(LAST_DIR, target);
      } catch {
        /* private mode */
      }
      toast(`uploaded ${done} file${done === 1 ? "" : "s"} → ${target || "workspace root"}`);
      void loadDirs(target);
    }
    setBusy(false);
    setFiles(null);
  };

  return (
    <>
      <button title="upload files into the workspace" onClick={openPicker}>
        ⬆ upload
      </button>
      <input
        ref={(el) => (fileInput = el)}
        id="workspace-upload-input"
        type="file"
        multiple
        class="hidden-input"
        onChange={(e) => onPicked(e.currentTarget.files)}
      />
      <Show when={files()}>
        {(picked) => (
          <div class="drawer" onClick={(e) => e.target === e.currentTarget && close()}>
            <div class="drawer-card">
              <div class="drawer-head">
                <strong>
                  upload {picked().length} file{picked().length === 1 ? "" : "s"}
                </strong>
                <span class="spacer" />
                <button onClick={close} disabled={busy()}>
                  ✕
                </button>
              </div>
              <div class="row muted small">{picked().map((f) => f.name).join(", ")}</div>
              <label class="col">
                folder in the workspace
                <input
                  type="text"
                  list="bob-upload-dirs"
                  value={dest()}
                  placeholder="assets/inbox"
                  autofocus
                  onInput={(e) => setDest(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void upload();
                  }}
                />
              </label>
              <datalist id="bob-upload-dirs">
                <For each={dirs()}>{(d) => <option value={d} />}</For>
              </datalist>
              <div class="row muted small">leave empty to upload to the workspace root</div>
              <div class="row">
                <span class="spacer" />
                <button class="secondary" onClick={close} disabled={busy()}>
                  cancel
                </button>
                <button onClick={() => void upload()} disabled={busy()}>
                  {busy() ? "uploading…" : "upload"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
