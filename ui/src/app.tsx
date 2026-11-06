/** App shell: toolbar + tiled grid + global stream + session drawer. */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import logo from "./assets/logo.webp";
import logoMark from "./assets/logo-mark.webp";
import { buildInfo } from "./build-info";
import { EventModal, GlobalStream, HiddenRail, RailCard, RefModal, SessionPanel, Tiles, WorkspaceUpload } from "./components";
import {
  init,
  orderedApps,
  state,
  stop,
  toggleHidden,
  toggleSub,
  toggleMachine,
  toggleStream,
  dismissError,
  retryLast,
  smallScreen,
} from "./store";

/** The tile checkboxes, shared by the desktop popover and the phone settings menu. */
function TileToggles() {
  return (
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
  );
}

function TilesMenu() {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="menu-wrap">
      <button onClick={() => setOpen(!open())} title="show/hide tiles">
        tiles ▾
      </button>
      <Show when={open()}>
        <div class="menu" onMouseLeave={() => setOpen(false)}>
          <TileToggles />
        </div>
      </Show>
    </div>
  );
}

/**
 * The phone toolbar folds upload, tiles and stream/machine (plus the workspace
 * files page link) into one list, so those controls keep their behavior without
 * making the wrapped toolbar several rows taller. Desktop keeps the direct
 * buttons; the shell toolbar hosts the phone's Session button beside Sync….
 */
function SettingsMenu(props: { events: number; onSession: () => void }) {
  const [open, setOpen] = createSignal(false);
  // The browser shell hosts a Session button beside Sync… on a phone. The
  // standalone UI has no shell, so keep the action in this menu there.
  const shellSession = !!document.getElementById("session-menu");
  let wrap: HTMLDivElement | undefined;
  // WorkspaceUpload keeps the hidden picker + destination drawer mounted even
  // while the menu is closed, so the file dialog's onChange still lands.
  let openUpload: (() => void) | undefined;
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (open() && wrap && !wrap.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });
  return (
    <div class="menu-wrap" ref={(el) => (wrap = el)}>
      <button
        classList={{ active: open() }}
        aria-haspopup="menu"
        aria-expanded={open()}
        title="upload, tiles, stream, machine notes and files"
        onClick={() => setOpen(!open())}
      >
        settings ▾
      </button>
      <Show when={open()}>
        <div class="menu" role="menu" aria-label="settings">
          <button
            type="button"
            class="menu-row menu-action"
            role="menuitem"
            onClick={() => pick(() => openUpload?.())}
          >
            ⬆ upload
          </button>
          <div class="menu-section">view</div>
          <label class="menu-row" role="menuitemcheckbox" aria-checked={state.streamOpen}>
            <input
              type="checkbox"
              checked={state.streamOpen}
              onChange={() => pick(toggleStream)}
            />
            stream <span class="count">{props.events}</span>
          </label>
          <label class="menu-row" role="menuitemcheckbox" aria-checked={state.showMachine}>
            <input type="checkbox" checked={state.showMachine} onChange={() => pick(toggleMachine)} />
            machine
          </label>
          <Show when={!shellSession}>
            <button type="button" class="menu-row menu-action" role="menuitem" onClick={() => pick(props.onSession)}>
              session
            </button>
          </Show>
          <button
            type="button"
            class="menu-row menu-action"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new Event("bob:show-files"));
            }}
          >
            files page
          </button>
          <div class="menu-section">tiles</div>
          <TileToggles />
        </div>
      </Show>
      <WorkspaceUpload hideTrigger onReady={(opener) => (openUpload = opener)} />
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
  // The store derives this beside the failure itself: a hard-failed turn and a
  // completed turn with an unhandled model call both keep their input, so both
  // can be resent. A quota wall is not retryable (the fallback buttons are the
  // right action; a plain retry would just hit the same 402).
  const canRetry = () => !!state.lastError?.retryable;

  onMount(() => {
    // The browser shell's Session button lives in its own toolbar, above this
    // app. It asks the mounted chat to open the same drawer as the direct
    // desktop button.
    const openSession = () => setShowSession(true);
    window.addEventListener("bob:open-session", openSession);
    onCleanup(() => window.removeEventListener("bob:open-session", openSession));
    void init();
  });

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">
          <img class="brand-mark" src={logoMark} alt="" aria-hidden="true" />
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
        <Show when={!smallScreen()}>
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
        </Show>
        <Show when={!smallScreen()}>
          <WorkspaceUpload />
          <TilesMenu />
        </Show>
        <Show
          when={smallScreen()}
          fallback={
            <>
              <button onClick={() => setShowSession(true)}>session</button>
              <button
                type="button"
                class="link-btn"
                onClick={() => window.dispatchEvent(new Event("bob:show-files"))}
              >
                files
              </button>
            </>
          }
        >
          <SettingsMenu events={streamEvents()} onSession={() => setShowSession(true)} />
        </Show>
        <span class="build-stamp" title={buildInfo.title}>
          {buildInfo.label}
        </span>
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
            <main class="tiles" classList={{ "front-open": !!state.front }}>
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
