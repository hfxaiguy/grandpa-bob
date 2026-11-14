/**
 * Host the Solid app inside the browser target.
 *
 * The chat board, Settings and workspace Files are now views of one Solid
 * tree (`ui/src/app.tsx`); there is no iframe and no second script scope. The
 * transport shim is installed once in this window so the same `/api/*` calls
 * reach the in-browser backend.
 *
 * The shell toolbar's Settings button and the chat UI's `bob:show-*` events
 * are the in-page navigation: the address bar stays at "/".
 */
import { installShim } from "./server/shim";
import { mountApp } from "../../ui/src/mount";
import type { LocalBackend } from "./server/local-backend";

export function hostUi(backend: LocalBackend, container: HTMLElement): void {
  (window as unknown as { __bobBackend?: LocalBackend }).__bobBackend = backend;
  (window as unknown as { __bobBackendReady?: Promise<void> }).__bobBackendReady = backend.ready;
  // The Solid app runs in this window, so the shim must be installed here.
  installShim(window);

  // The shell's phone Session button sits beside Sync…; the mounted chat owns
  // the drawer, so the click becomes a same-window request to open it.
  const sessionButton = document.getElementById("session-menu") as HTMLButtonElement | null;
  sessionButton?.addEventListener("click", () => {
    window.dispatchEvent(new Event("bob:open-session"));
  });

  // Settings is global, so it also lives in the shell toolbar at the very top
  // of the browser window. The Solid router listens for the event.
  document.getElementById("settings-menu")?.addEventListener("click", () => {
    window.dispatchEvent(new Event("bob:show-settings"));
  });

  container.replaceChildren();
  mountApp(container);
}
