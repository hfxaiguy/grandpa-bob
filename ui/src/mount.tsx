import { render } from "solid-js/web";
import { App } from "./app";
import { closeLiveStream } from "./store";
import "./styles.css";

/** Mount the tiled app UI into `el`. Used by the standalone page and by the
 *  browser target (web/), which imports this module directly. Returns a
 *  dispose function (call before re-mounting). */
export function mountApp(el: HTMLElement): () => void {
  const dispose = render(() => <App />, el);
  // A dispose here is a real teardown (the browser target swaps chat ↔ settings
  // in place, no page load). Drop the live subscription too, so the next mount
  // opens exactly one — otherwise every event would be appended twice.
  return () => {
    closeLiveStream();
    dispose();
  };
}
