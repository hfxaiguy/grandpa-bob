import { render } from "solid-js/web";
import { App } from "./app";
import logoMark from "./assets/logo-mark.webp";
import { closeLiveStream, refreshTtsEnabled } from "./store";
import "./styles.css";

/** Point the tab icon at the Bob cat mark. Both the standalone page and the
 *  browser target mount through here, so neither needs its own asset copy. */
function setFavicon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) {
    link.href = href;
    return;
  }
  const el = document.createElement("link");
  el.rel = "icon";
  el.href = href;
  document.head.appendChild(el);
}

/** Mount the tiled app UI into `el`. Used by the standalone page and by the
 *  browser target (web/), which imports this module directly. Returns a
 *  dispose function (call before re-mounting). */
export function mountApp(el: HTMLElement): () => void {
  setFavicon(logoMark);
  // Settings is an in-place iframe; picking the chat back up is the moment to
  // re-read the TTS switch that hides/shows every 🔊 button.
  refreshTtsEnabled();
  const dispose = render(() => <App />, el);
  // A dispose here is a real teardown (the browser target swaps chat ↔
  // settings/files in place, no page load). Drop the live subscription too, so
  // the next mount opens exactly one — otherwise every event is appended twice.
  return () => {
    closeLiveStream();
    dispose();
  };
}
