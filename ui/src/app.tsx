/** App shell: toolbar + tiled grid + global stream + session drawer. */
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { GlobalStream, SessionPanel, Tiles } from "./components";
import { init, orderedApps, state, toggleHidden, dismissError, retryLast } from "./store";

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
              <label class="menu-row">
                <input
                  type="checkbox"
                  checked={!state.layout.hidden.includes(a.name)}
                  onChange={() => toggleHidden(a.name)}
                />
                {a.name}
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
  const apps = createMemo(() => orderedApps());
  // A hard-failed last turn can be resent with one click.
  const canRetry = () => {
    const t = state.turns[state.turns.length - 1];
    return !!t && t.status === "error" && !!t.input;
  };

  onMount(() => {
    void init();
  });

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">grandpa-bob</span>
        <span class="conn" classList={{ on: state.connected }} title={state.connected ? "live" : "disconnected"} />
        <span class="session-label" title={state.active ?? ""}>
          {state.label || state.active || "no session"}
        </span>
        <span class="spacer" />
        <TilesMenu />
        <button onClick={() => setShowSession(true)}>session</button>
        <a class="link-btn" href="/classic" title="the classic single-thread chat (voice, file upload, tree panel)">
          classic
        </a>
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
        when={state.active}
        fallback={
          <div class="empty-state">
            <p>No session selected.</p>
            <button onClick={() => setShowSession(true)}>open a session</button>
          </div>
        }
      >
        <div class="body">
          <main class="tiles">
            <Tiles apps={apps()} />
          </main>
          <GlobalStream />
        </div>
      </Show>

      <Show when={showSession()}>
        <SessionPanel onClose={() => setShowSession(false)} />
      </Show>

      <Show when={state.toast}>
        <div class="toast" classList={{ err: state.toastErr }}>
          {state.toast}
        </div>
      </Show>
    </div>
  );
}
