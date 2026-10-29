/** App shell: toolbar + tiled grid + global stream + session drawer. */
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import logo from "./assets/logo.webp";
import logoMark from "./assets/logo-mark.webp";
import { EventModal, GlobalStream, HiddenRail, RailCard, RefModal, SessionPanel, Tiles, WorkspaceUpload } from "./components";
import { init, orderedApps, state, stop, toggleHidden, toggleSub, toggleMachine, toggleStream, dismissError, retryLast } from "./store";

function TilesMenu() {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="menu-wrap">
      <button onClick={() => setOpen(!open())} title="show/hide tiles">
        tiles ▾
      </button>
      <Show when={open()}>
        <div class="menu" onMouseLeave={() => setOpen(false)}>
          <For each={state.apps}>
            {(a) => (
              <label class="menu-row" classList={{ submenu: !!a.parent }}>
                <input
                  type="checkbox"
                  // A top-level tile's box is its board seat; a sub-app's box
                  // opens it inside its parent (parked = unchecked).
                  checked={a.parent ? state.layout.subsOpen.includes(a.name) : !state.layout.hidden.includes(a.name)}
                  onChange={() => (a.parent ? toggleSub(a.name) : toggleHidden(a.name))}
                />
                {a.parent ? `↳ ${a.name}` : a.name}
              </label>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function App() {
  const [showSession, setShowSession] = createSignal(false);
  // The grid tiles are the apps; the trunk docks along the bottom of the same
  // grid, spanning every column — it is the board's home conversation.
  const apps = createMemo(() => orderedApps().filter((a) => a.name !== "trunk"));
  const trunk = createMemo(() => orderedApps().find((a) => a.group === "trunk"));
  // The toolbar's stream badge. On a phone the stream starts hidden, so this is
  // the only visible entry point; the count matches the header's event count
  // (one line per event — turn dividers are not events).
  const streamEvents = createMemo(() => state.turns.reduce((n, t) => n + (t.events?.length ?? 0), 0));
  // A hard-failed last turn can be resent with one click — unless it hit a
  // quota wall, where the fallback buttons are the right action (a plain retry
  // would just hit the same 402).
  const canRetry = () => {
    const t = state.turns[state.turns.length - 1];
    return !!t && t.status === "error" && !!t.input && !t.fallback?.length;
  };

  onMount(() => {
    void init();
  });

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">
          <img class="brand-mark" src={logoMark} alt="" aria-hidden="true" />
          <span class="brand-name">grandpa-bob</span>
        </span>
        <span class="conn" classList={{ on: state.connected }} title={state.connected ? "live" : "disconnected"} />
        <span class="session-label" title={state.active ?? ""}>
          {state.label || state.active || "no session"}
        </span>
        {/* The composer lives on the parked tile only, so the stop lives here:
            always reachable while a turn runs, wherever the tiles are parked. */}
        <Show when={state.turns.some((t) => t.status === "running")}>
          <button class="danger" title="stop the running tree now" onClick={() => void stop()}>
            Stop
          </button>
        </Show>
        <span class="spacer" />
        <button
          classList={{ active: state.streamOpen }}
          aria-pressed={state.streamOpen}
          title={state.streamOpen ? "hide the event stream" : "show the event stream"}
          onClick={toggleStream}
        >
          stream <span class="count">{streamEvents()}</span>
        </button>
        <button
          classList={{ active: state.showMachine }}
          title="show machine-tagged emits in the app chats"
          onClick={toggleMachine}
        >
          machine
        </button>
        <WorkspaceUpload />
        <TilesMenu />
        <button onClick={() => setShowSession(true)}>session</button>
        <a class="link-btn" href="/settings">
          settings
        </a>
      </header>

      <Show when={state.lastError}>
        {(err) => (
          <div class="error-banner" role="alert">
            <span class="err-icon" aria-hidden="true">⚠</span>
            <div class="err-body">
              <div class="err-title">{err().title}</div>
              <div class="err-text">{err().text}</div>
            </div>
            <Show when={canRetry()}>
              <button class="err-retry" onClick={() => void retryLast()}>
                ↻ retry
              </button>
            </Show>
            <button class="err-dismiss" onClick={() => dismissError()}>
              dismiss
            </button>
          </div>
        )}
      </Show>

      <Show
        when={state.ready}
        fallback={
          <div class="boot-splash">
            <img class="empty-logo" src={logo} alt="grandpa-bob" />
            <div class="boot-status" role="status" aria-live="polite">
              <span class="spinner" aria-hidden="true" />
              <span class="boot-text">{state.bootStatus || "starting…"}</span>
              <span class="boot-pct">{state.bootProgress}%</span>
            </div>
            <div
              class="boot-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={state.bootProgress}
            >
              <div class="boot-bar-fill" style={{ width: `${state.bootProgress}%` }} />
            </div>
          </div>
        }
      >
        <Show
          when={state.active}
          fallback={
            <div class="empty-state">
              <img class="empty-logo" src={logo} alt="grandpa-bob" />
              <p>No session selected.</p>
              <button onClick={() => setShowSession(true)}>open a session</button>
            </div>
          }
        >
          <div class="body">
            <HiddenRail />
            <main class="tiles">
              <Tiles apps={apps()} trunk={trunk()} />
            </main>
            <GlobalStream />
            <RailCard />
          </div>
        </Show>
      </Show>

      <Show when={showSession()}>
        <SessionPanel onClose={() => setShowSession(false)} />
      </Show>

      <EventModal />
      <RefModal />

      <Show when={state.toast}>
        <div class="toast" classList={{ err: state.toastErr }}>
          {state.toast}
        </div>
      </Show>
    </div>
  );
}
