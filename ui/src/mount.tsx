import { render } from "solid-js/web";
import { App } from "./app";
import "./styles.css";

/** Mount the tiled app UI into `el`. Used by the standalone page and by the
 *  browser target (web/), which imports this module directly. Returns a
 *  dispose function (call before re-mounting). */
export function mountApp(el: HTMLElement): () => void {
  return render(() => <App />, el);
}
