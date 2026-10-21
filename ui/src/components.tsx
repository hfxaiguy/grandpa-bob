/** Tile, memory, per-tile event log, global stream, session panel. */
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { describeEvent, streamLines, type EventLine } from "./describe";
import { copyEventStream, copyText, downloadEventStream } from "./event-dump";
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
  setRef,
  setModel,
  chooseFallback,
  clearConversation,
  sendToTelegram,
  fetchProvenance,
  fetchRef,
  refView,
  openRef,
  closeRef,
  toggleExpanded,
  toggleWide,
  toggleHidden,
  moveTile,
  toast,
  sendFile,
  transcribeAudio,
  transcribeFileStream,
} from "./store";
import type { AppInfo, ProvPiece, ProvWriter, Provenance, RefTarget, Turn } from "./types";

const trunkOf = (a?: string | null) => a || "trunk";

/** Chat bubbles for one app, across every turn. */
function bubblesFor(app: string): { turn: Turn; text: string; kind: "user" | "bot" | "err"; emitIndex?: number }[] {
  const out: { turn: Turn; text: string; kind: "user" | "bot" | "err"; emitIndex?: number }[] = [];
  for (const t of state.turns) {
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
    if (app === "trunk" && t.status === "done" && !emits.length && t.output) {
      out.push({ turn: t, text: t.output, kind: "bot" });
    }
    if ((t.inputApp ?? "trunk") === app && t.status === "error" && t.error) {
      out.push({ turn: t, text: t.error, kind: "err" });
    }
  }
  return out;
}

function MemoryPanel(props: { app: string }) {
  const [inspect, setInspect] = createSignal<{ path: string; value: unknown } | null>(null);
  const entries = createMemo(() => {
    const m = state.memory[props.app] || {};
    return Object.entries(m)
      .map(([path, value]) => ({ path, value, depth: (path.match(/\//g) || []).length }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
  const shown = (v: unknown) => {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return t.length > 200 ? t.slice(0, 200) + "…" : t;
  };
  const full = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return (
    <div class="mem">
      <div class="panel-title">memory</div>
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
      <Show when={inspect()}>
        {(sel) => (
          <div class="mem-modal" onClick={(ev) => ev.target === ev.currentTarget && setInspect(null)}>
            <div class="mem-modal-card">
              <div class="mem-modal-head">
                <span class="mem-modal-path">{sel().path}</span>
                <span class="spacer" />
                <button onClick={() => setInspect(null)}>✕</button>
              </div>
              <pre class="mem-modal-body"><RefText text={full(sel().value)} /></pre>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

// A single log line, expandable to its full event payload. Native
// <details>/<summary> keeps it keyboard-accessible for free. The detail is the
// sanitized event; "full" fetches the raw run-log row (complete messages, no
// 400-char caps) for exact prompt/output inspection.
function LogRow(props: { line: EventLine; showApp?: boolean }) {
  const [full, setFull] = createSignal<{ text: string; chars: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = createSignal(false);

  const loadFull = async (): Promise<void> => {
    const seq = props.line.seq;
    if (!seq) return;
    setLoading(true);
    try {
      const target = await fetchRef(seq);
      setFull({ text: target.value, chars: target.chars, truncated: target.truncated });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setLoading(false);
    }
  };

  const copy = async (text: string, label: string): Promise<void> => {
    const ok = await copyText(text);
    toast(ok ? `copied ${label}` : "clipboard blocked", !ok);
  };

  const copyMessages = (): void => {
    const current = full();
    if (!current) return;
    try {
      const parsed = JSON.parse(current.text) as { messages?: unknown };
      if (!Array.isArray(parsed.messages)) {
        toast("this event has no message array", true);
        return;
      }
      void copy(JSON.stringify(parsed.messages, null, 2), `${parsed.messages.length} messages`);
    } catch {
      toast("could not parse the full event", true);
    }
  };

  return (
    <details
      class="log-row"
      classList={{ emit: props.line.emit, [props.line.cls]: !!props.line.cls }}
      onToggle={(event) => {
        // Opening an LLM call should show the exact prompt immediately, not
        // require a second click. Other rows fetch on demand.
        if (
          (event.currentTarget as HTMLDetailsElement).open &&
          props.line.kind === "llm_call" &&
          !full() &&
          !loading()
        ) {
          void loadFull();
        }
      }}
    >
      <summary>
        <Show when={props.showApp}>
          <span class="stream-app">{props.line.app}</span>
        </Show>
        <span class="badge">{props.line.badge}</span>
        <span class="log-text"><RefText text={props.line.text} /></span>
      </summary>
      <pre class="log-detail">{props.line.detail}</pre>
      <div class="log-actions">
        <button type="button" onClick={() => void copy(props.line.detail, "event")}>copy</button>
        <Show when={props.line.seq}>
          <button type="button" onClick={() => void loadFull()}>
            {loading() ? "loading…" : full() ? "reload full" : "full"}
          </button>
        </Show>
      </div>
      <Show when={full()}>
        {(value) => (
          <>
            <div class="log-actions">
              <span class="log-note">
                full row · {value().chars} chars{value().truncated ? " · truncated" : ""}
              </span>
              <button type="button" onClick={() => copyMessages()}>copy messages</button>
            </div>
            <pre class="log-detail full">{value().text}</pre>
          </>
        )}
      </Show>
    </details>
  );
}

// ── ref:// handles ─────────────────────────────────────────────────────
// A `ref://<seq>`, `ref://<seq>/<path>` or `ref://<label>.<seq>` token in any
// text becomes a link that opens the referenced run-log row in the inspector.

/** Matches a whole ref token (label.seq, optional /path). */
const REF_TOKEN = /ref:\/\/[A-Za-z0-9_.\/-]+/g;

/** The row seq and optional `/path` a ref token points at. */
function parseRef(token: string): { seq: number; path: string | null } | null {
  const body = token.slice("ref://".length);
  const [head, ...rest] = body.split("/");
  const m = /(\d+)$/.exec(head); // "146629" or "rows.146629"
  if (!m) return null;
  return { seq: Number(m[1]), path: rest.length ? rest.join("/") : null };
}

/** Render text with any `ref://…` tokens as clickable inspect links. */
function RefText(props: { text: string }) {
  const parts = createMemo(() => {
    const text = String(props.text ?? "");
    const out: { t: string; ref: string | null }[] = [];
    let last = 0;
    for (const m of text.matchAll(REF_TOKEN)) {
      const i = m.index ?? 0;
      const raw = m[0];
      // Sentence punctuation after the handle is not part of it.
      const link = raw.replace(/[.,;:!?\])}]+$/, "");
      const trail = raw.slice(link.length);
      if (i > last) out.push({ t: text.slice(last, i), ref: null });
      if (link) out.push({ t: link, ref: link });
      if (trail) out.push({ t: trail, ref: null });
      last = i + raw.length;
    }
    if (last < text.length) out.push({ t: text.slice(last), ref: null });
    return out;
  });
  return (
    <For each={parts()}>
      {(p) =>
        p.ref ? (
          <button
            class="ref-link"
            title={`inspect ${p.ref}`}
            onClick={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const r = parseRef(p.ref!);
              if (r) openRef(r.seq, r.path);
            }}
          >
            {p.t}
          </button>
        ) : (
          p.t
        )
      }
    </For>
  );
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
        <div class="mem-modal" onClick={(ev) => ev.target === ev.currentTarget && closeRef()}>
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
                    <pre class="prov-value ref-value"><RefText text={d().value} /></pre>
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
  return (
    <div class="evlog">
      <button class="panel-title as-button" onClick={() => setOpen(!open())}>
        events <span class="count">{lines().length}</span>
        {" · "}prompts <span class="count prompt">{prompts()}</span>
        {" · "}tool calls <span class="count tool">{tools()}</span> {open() ? "▾" : "▸"}
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
  // ── voice input (MediaRecorder → /api/transcribe → send) ──
  const canMic =
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder !== "undefined";
  const [recording, setRecording] = createSignal(false);
  const [recSecs, setRecSecs] = createSignal(0);
  let rec: MediaRecorder | null = null;
  let recStream: MediaStream | null = null;
  let recChunks: Blob[] = [];
  let recTimer: ReturnType<typeof setInterval> | undefined;

  const finishRecording = async () => {
    clearInterval(recTimer);
    setRecording(false);
    recStream?.getTracks().forEach((t) => t.stop());
    recStream = null;
    const mimeType = rec?.mimeType || "audio/webm";
    const blob = new Blob(recChunks, { type: mimeType });
    const secs = recSecs();
    rec = null;
    recChunks = [];
    if (!blob.size) return;
    if (secs < 1) {
      toast("recording too short", true);
      return;
    }
    toast("transcribing…");
    try {
      const heard = (
        await transcribeAudio(blob, `voice${mimeType.includes("mp4") ? ".mp4" : ".webm"}`)
      ).trim();
      if (!heard) {
        toast("heard nothing", true);
        return;
      }
      toast(`heard: "${heard}"`);
      await send(heard);
    } catch (e) {
      toast(`transcription failed: ${e instanceof Error ? e.message : e}`, true);
    }
  };

  const toggleMic = async () => {
    if (recording()) {
      rec?.stop();
      return;
    }
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast(`microphone unavailable: ${e instanceof Error ? e.message : e}`, true);
      return;
    }
    const mime =
      ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) || "";
    rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    recChunks = [];
    rec.ondataavailable = (e) => {
      if (e.data?.size) recChunks.push(e.data);
    };
    rec.onstop = () => void finishRecording();
    rec.start();
    setRecSecs(0);
    setRecording(true);
    recTimer = setInterval(() => setRecSecs((s) => s + 1), 1000);
  };

  // If the composer unmounts (the tile hides) mid-recording, release the mic
  // without trying to transcribe a partial clip.
  onCleanup(() => {
    clearInterval(recTimer);
    if (rec) {
      rec.onstop = null;
      if (rec.state === "recording") rec.stop();
    }
    recStream?.getTracks().forEach((t) => t.stop());
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
        <button
          class="icon-btn"
          classList={{ recording: recording() }}
          disabled={!canMic}
          title={canMic ? "record a voice message" : "voice input needs a secure context (localhost or https)"}
          onClick={() => void toggleMic()}
        >
          {recording() ? `${recSecs()}s` : "🎙"}
        </button>
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
          placeholder="reply…"
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
              <pre class="prov-value">
                {(w().text || "(no value)") + (w().truncated ? `\n… (${w().chars} chars total)` : "")}
              </pre>
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
                  <div class="prov-emit">{d().emit.text || "(empty)"}</div>
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
                                <pre class="prov-msg-body"><RefText text={m.content} /></pre>
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
                          <span class="prov-slot"><RefText text={`ref://${r.seq}`} /></span>
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

function Tile(props: { app: AppInfo }) {
  const name = () => props.app.name;
  const expanded = () => state.layout.expanded.includes(name());
  const wide = () => state.layout.wide.includes(name());
  const paused = () => state.awaiting === name();
  // The app currently executing: walk the running turn's events through the
  // same enter/exit stack the server uses. The OUTERMOST tree tool is the app;
  // tree tools nested inside it are its capabilities (email's `answer`,
  // contacts' `contacts_query`), which still belong to the app's tile — so the
  // email tile lights while its `answer` branch runs, not only while the
  // orchestrator itself is the innermost tree.
  const currentApp = createMemo(() => {
    const t = state.turns.find((x) => x.status === "running");
    if (!t) return null;
    const stack: string[] = [];
    for (const e of t.events) {
      const nm =
        typeof e.content?.tool === "string" ? e.content?.tool
        : typeof e.content?.tree === "string" ? e.content?.tree
        : "";
      if (e.kind === "tree_enter" && nm) stack.push(nm);
      else if (e.kind === "tree_exit" && nm) {
        const i = stack.lastIndexOf(nm);
        if (i >= 0) stack.splice(i, 1);
      }
    }
    return stack[0] ?? "trunk";
  });
  const running = () => currentApp() === name();
  const bubbles = createMemo(() => bubblesFor(name()));
  const chatRef = { el: undefined as HTMLDivElement | undefined };
  // The bubble whose provenance panel is open (null = closed).
  const [prov, setProv] = createSignal<{ turnId: string; bubble: number; text: string } | null>(null);

  createEffect(() => {
    bubbles();
    const el = chatRef.el;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // The trunk tile always has a composer (start a conversation, reply, or
  // queue while a turn runs); an app tile shows one only when its tree is the
  // one paused at .human() — or when the last turn failed and was headed there
  // (so a retry is possible).
  const retryApp = createMemo(() => {
    const last = state.turns[state.turns.length - 1];
    return last && last.status === "error" ? (last.inputApp ?? "trunk") : null;
  });
  const showInput = () => name() === "trunk" || state.awaiting === name() || retryApp() === name();

  const errored = createMemo(() => {
    const last = state.turns[state.turns.length - 1];
    return !!last && last.status === "error" && (last.inputApp ?? "trunk") === name();
  });
  const statusText = () => (paused() ? "waiting" : running() ? "running" : errored() ? "error" : "idle");

  return (
    <section
      class="tile"
      classList={{ expanded: expanded(), wide: wide(), paused: paused(), errored: errored() }}
      draggable
      onDragStart={(e) => e.dataTransfer?.setData("text/plain", name())}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const from = e.dataTransfer?.getData("text/plain");
        if (from) moveTile(from, name());
      }}
    >
      <header class="tile-head">
        <span class="dot" classList={{ run: running(), wait: paused(), err: errored() }} />
        <span class="tile-name">{name()}</span>
        <span class="tile-status">{statusText()}</span>
        <span class="spacer" />
        <button title="wider" onClick={() => toggleWide(name())}>
          ↔
        </button>
        <button title={expanded() ? "restore" : "expand"} onClick={() => toggleExpanded(name())}>
          {expanded() ? "⤡" : "⤢"}
        </button>
        <button title="hide tile" onClick={() => toggleHidden(name())}>
          ✕
        </button>
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
      <Show when={prov()}>
        {(p) => <ProvenanceModal turnId={p().turnId} bubble={p().bubble} text={p().text} onClose={() => setProv(null)} />}
      </Show>
    </section>
  );
}

export function Tiles(props: { apps: AppInfo[] }) {
  return (
    <div class="grid">
      <For each={props.apps}>{(a) => <Tile app={a} />}</For>
    </div>
  );
}

export function GlobalStream() {
  const [open, setOpen] = createSignal(true);
  const lines = createMemo(() => streamLines(state.turns));
  const tools = createMemo(() => toolCallCount(lines()));
  const prompts = createMemo(() => promptCount(lines()));
  let ref: HTMLDivElement | undefined;
  createEffect(() => {
    lines();
    if (ref && open()) ref.scrollTop = ref.scrollHeight;
  });
  return (
    <aside class="stream" classList={{ collapsed: !open() }}>
      <div class="stream-head">
        <button class="panel-title as-button stream-toggle" onClick={() => setOpen(!open())}>
          event stream <span class="count">{lines().length}</span>
          {" · "}prompts <span class="count prompt">{prompts()}</span>
          {" · "}tool calls <span class="count tool">{tools()}</span> {open() ? "▸" : "◂"}
        </button>
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
      </div>
      <Show when={open()}>
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

        <label class="row">
          <input type="checkbox" checked={state.follow} onChange={(e) => void setFollow(e.currentTarget.checked)} />
          follow the live Telegram conversation
        </label>

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
            <button class="secondary" title="push this transcript to your linked Telegram chat" onClick={() => void sendToTelegram()}>
              ✈ telegram
            </button>
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
        <label class="col">
          version (new sessions)
          <select onChange={(e) => void setRef(e.currentTarget.value)}>
            <option value="prod" selected={(state.ref || "prod") === "prod"}>
              prod{state.versions.prod ? ` (${state.versions.prod})` : ""}
            </option>
            <For each={state.versions.versions}>
              {(v) => <option value={v} selected={state.ref === v}>{v}</option>}
            </For>
            <Show when={state.versions.draft}>
              <option value="draft" selected={state.ref === "draft"}>draft</option>
            </Show>
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
