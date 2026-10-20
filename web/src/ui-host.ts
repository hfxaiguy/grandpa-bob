/**
 * Host the web frontend inside the browser target.
 *
 * The chat UI (`ui/`, SolidJS) mounts directly in this window with the
 * transport shim installed, so its `/api/*` calls hit the in-browser backend.
 * The settings page is the shared server-rendered HTML, hosted in a
 * same-origin iframe (with the shim). Links between "/" and "/settings" swap
 * the two instead of navigating away.
 */
import { buildSettingsHtml } from "../../src/ui/pages";
import { installShim, SHIM_SCRIPT } from "./server/shim";
import { mountApp } from "../../ui/src/mount";
import type { LocalBackend } from "./server/local-backend";

export type UiPage = "chat" | "settings";

export function hostUi(
  backend: LocalBackend,
  container: HTMLElement,
  opts: { page: UiPage; port: number; sttLabel?: string },
): void {
  (window as unknown as { __bobBackend?: LocalBackend }).__bobBackend = backend;
  (window as unknown as { __bobBackendReady?: Promise<void> }).__bobBackendReady = backend.ready;
  // The chat UI runs in this window, so the shim must be installed here too.
  installShim(window);

  let disposeChat: (() => void) | undefined;

  const showChat = (): void => {
    disposeChat?.();
    const el = document.createElement("div");
    el.style.cssText = "height:100%;display:flex;flex-direction:column";
    container.replaceChildren(el);
    disposeChat = mountApp(el);
  };

  const showSettings = (): void => {
    disposeChat?.();
    disposeChat = undefined;
    const iframe = document.createElement("iframe");
    iframe.id = "bob-ui";
    iframe.style.cssText = "border:0;width:100%;height:100%;display:block;background:transparent";
    iframe.srcdoc = buildSettingsHtml({ port: opts.port }).replace("</head>", `<script>${SHIM_SCRIPT}</script></head>`);
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
          if (raw === "/" || raw === "/settings") {
            event.preventDefault();
            if (raw === "/") showChat();
          }
        },
        true,
      );
    });
  };

  // The chat UI links to /settings; intercept that click at the container.
  container.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      if ((anchor.getAttribute("href") || "") === "/settings") {
        event.preventDefault();
        showSettings();
      }
    },
    true,
  );

  if (opts.page === "settings") showSettings();
  else showChat();
}
