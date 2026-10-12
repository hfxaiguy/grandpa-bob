/** Tile, memory, per-tile event log, global stream, session panel. */
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { describeEvent, streamLines, type EventLine } from "./describe";
import {
  state,
  send,
  selectSession,
  newSession,
  deleteSession,
  setFollow,
  setPattern,
  setRef,
  setModel,
  clearConversation,
  toggleExpanded,
  toggleWide,
  toggleHidden,
  moveTile,
} from "./store";
import type { AppInfo, Turn } from "./types";

const trunkOf = (a?: string | null) => a || "trunk";

/** Chat bubbles for one app, across every turn. */
function bubblesFor(app: string): { turn: Turn; text: string; kind: "user" | "bot" | "err" }[] {
  const out: { turn: Turn; text: string; kind: "user" | "bot" | "err" }[] = [];
  for (const t of state.turns) {
    if ((t.inputApp ?? "trunk") === app && t.input) out.push({ turn: t, text: t.input, kind: "user" });
    const emits = t.emits ?? [];
    const apps = t.emitApps ?? [];
    for (let i = 0; i < emits.length; i++) {
      if (trunkOf(apps[i]) !== app) continue;
      out.push({ turn: t, text: emits[i], kind: "bot" });
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
              <pre class="mem-modal-body">{full(sel().value)}</pre>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

function EventLog(props: { app: string }) {
  const [open, setOpen] = createSignal(false);
  const lines = createMemo<EventLine[]>(() => {
    const out: EventLine[] = [];
    for (const t of state.turns) for (const ev of t.events) if (trunkOf(ev.app) === props.app) out.push(describeEvent(ev));
    return out;
  });
  return (
    <div class="evlog">
      <button class="panel-title as-button" onClick={() => setOpen(!open())}>
        events <span class="count">{lines().length}</span> {open() ? "▾" : "▸"}
      </button>
      <Show when={open()}>
        <ul class="ev-list">
          <For each={lines().slice(-200)}>
            {(l) => (
              <li class={l.cls}>
                <span class="badge">{l.badge}</span>
                <span class="ev-text">{l.text}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function Composer(props: { app: string }) {
  const [text, setText] = createSignal("");
  let ta: HTMLTextAreaElement | undefined;
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
      if (t.buttons?.length) return t.buttons;
      break;
    }
    return [];
  });
  const submit = () => {
    const v = text();
    setText("");
    void send(v);
  };
  return (
    <div class="composer">
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

function Tile(props: { app: AppInfo }) {
  const name = () => props.app.name;
  const expanded = () => state.layout.expanded.includes(name());
  const wide = () => state.layout.wide.includes(name());
  const running = createMemo(() => state.turns.some((t) => t.status === "running"));
  const paused = () => state.awaiting === name();
  const bubbles = createMemo(() => bubblesFor(name()));
  const chatRef = { el: undefined as HTMLDivElement | undefined };

  createEffect(() => {
    bubbles();
    const el = chatRef.el;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // The trunk tile always has a composer (start a conversation, reply, or
  // queue while a turn runs); an app tile shows one only when its tree is the
  // one paused at .human().
  const showInput = () => name() === "trunk" || state.awaiting === name();

  const errored = createMemo(() => {
    const last = state.turns[state.turns.length - 1];
    return !!last && last.status === "error" && (last.inputApp ?? "trunk") === name();
  });
  const statusText = () => (paused() ? "paused" : running() ? "running" : errored() ? "error" : "idle");

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
        <span class="dot" classList={{ on: paused(), run: running(), err: errored() }} />
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
              <div class="bubble" classList={{ user: b.kind === "user", bot: b.kind === "bot", err: b.kind === "err" }}>
                {b.text}
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
  let ref: HTMLDivElement | undefined;
  createEffect(() => {
    lines();
    if (ref && open()) ref.scrollTop = ref.scrollHeight;
  });
  return (
    <aside class="stream" classList={{ collapsed: !open() }}>
      <button class="panel-title as-button stream-head" onClick={() => setOpen(!open())}>
        event stream <span class="count">{lines().length}</span> {open() ? "▸" : "◂"}
      </button>
      <Show when={open()}>
        <div class="stream-body" ref={ref}>
          <For each={lines().slice(-400)}>
            {(l) => (
              <div class="stream-line" classList={{ emit: l.emit }}>
                <span class="stream-app">{l.app}</span>
                <span class="badge">{l.badge}</span>
                <span class="stream-text">{l.text}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </aside>
  );
}

export function SessionPanel(props: { onClose: () => void }) {
  const activeSession = createMemo(() => state.sessions.find((s) => s.key === state.active));
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
          <div class="row muted small">
            active: {activeSession()?.label || state.active}
            <span class="spacer" />
            <button class="danger" onClick={() => state.active && void deleteSession(state.active)}>
              delete
            </button>
            <button class="secondary" onClick={() => void clearConversation()}>
              clear conversation
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
