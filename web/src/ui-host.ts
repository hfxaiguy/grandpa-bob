/**
 * Host the web frontend inside the browser target.
 *
 * The chat UI (`ui/`, SolidJS) mounts directly in this window with the
 * transport shim installed, so its `/api/*` calls hit the in-browser backend.
 * Settings and Files are shared server-rendered HTML pages, hosted in a
 * same-origin iframe (with the shim). Both are in-page views only: the chat UI
 * dispatches `bob:show-settings` / `bob:show-files`, the shell toolbar has a
 * global Settings button, the iframes' links swap views, and the address bar
 * always stays at "/".
 */
import { buildFilesHtml, buildSettingsHtml } from "./ui/pages";
import { installShim, SHIM_SCRIPT } from "./server/shim";
import { mountApp } from "../../ui/src/mount";
import type { LocalBackend } from "./server/local-backend";

export function hostUi(
  backend: LocalBackend,
  container: HTMLElement,
  opts: { port: number },
): void {
  (window as unknown as { __bobBackend?: LocalBackend }).__bobBackend = backend;
  (window as unknown as { __bobBackendReady?: Promise<void> }).__bobBackendReady = backend.ready;
  // The chat UI runs in this window, so the shim must be installed here too.
  installShim(window);

  let disposeChat: (() => void) | undefined;
  // The shell's phone Session button sits beside Sync…; the mounted chat owns
  // the drawer, so the click becomes a same-window request to open it.
  const sessionButton = document.getElementById("session-menu") as HTMLButtonElement | null;
  sessionButton?.addEventListener("click", () => {
    window.dispatchEvent(new Event("bob:open-session"));
  });

  const showChat = (): void => {
    disposeChat?.();
    sessionButton?.removeAttribute("hidden");
    const el = document.createElement("div");
    el.style.cssText = "height:100%;display:flex;flex-direction:column";
    container.replaceChildren(el);
    disposeChat = mountApp(el);
  };

  // Host one of the shared HTML views in the iframe. Links between views and
  // back to chat are handled here, so the iframe never navigates the tab.
  const showPage = (html: string): void => {
    disposeChat?.();
    disposeChat = undefined;
    sessionButton?.setAttribute("hidden", "");
    const iframe = document.createElement("iframe");
    iframe.id = "bob-ui";
    iframe.style.cssText = "border:0;width:100%;height:100%;display:block;background:transparent";
    iframe.srcdoc = html.replace("</head>", `<script>${SHIM_SCRIPT}</script></head>`);
    container.replaceChildren(iframe);
    iframe.addEventListener("load", () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      doc.addEventListener(
        "click",
        (event) => {
          const anchor = (event.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
          if (!anchor) return;
          const raw = anchor.getAttribute("href") || "";
          if (raw.startsWith("/api/files/download")) {
            event.preventDefault();
            const q = raw.indexOf("?");
            const search = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "");
            void backend
              .request("GET", "/api/files/download", search, null)
              .then((res) => {
                const body = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
                const url = URL.createObjectURL(new Blob([body], { type: res.contentType || "text/plain" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = (search.get("path") ?? "download").split("/").pop() || "download";
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
              })
              .catch(() => {});
            return;
          }
          if (raw === "/") {
            event.preventDefault();
            showChat();
            return;
          }
          if (raw === "/settings") {
            event.preventDefault();
            showSettings();
            return;
          }
          if (raw === "/files") {
            event.preventDefault();
            showFiles();
          }
        },
        true,
      );
    });
  };

  const showSettings = (): void => showPage(buildSettingsHtml({ port: opts.port }));
  const showFiles = (): void => showPage(buildFilesHtml({ port: opts.port }));

  // Settings is global, so it also lives in the shell toolbar at the very top
  // of the browser window — not only inside the chat surface.
  document.getElementById("settings-menu")?.addEventListener("click", showSettings);

  // Both views are in-page only: the chat UI and the shell ask for them with
  // events. No URL change and no server route exist for either.
  window.addEventListener("bob:show-settings", showSettings);
  window.addEventListener("bob:show-files", showFiles);

  showChat();
}
