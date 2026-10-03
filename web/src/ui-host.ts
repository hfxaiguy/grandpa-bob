/**
 * Host the exact Node admin pages inside the browser target.
 *
 * The shared page (src/ui/pages.ts) is rendered into a same-origin iframe with
 * the transport shim injected, so it runs verbatim and its `/api/*` calls hit
 * the in-browser backend. Link navigation between `/` and `/settings` is
 * intercepted and swaps the iframe content instead of navigating away.
 */
import { buildChatHtml, buildSettingsHtml } from "../../src/ui/pages";
import { SHIM_SCRIPT } from "./server/shim";
import type { LocalBackend } from "./server/local-backend";

export type UiPage = "chat" | "settings";

export function hostUi(
  backend: LocalBackend,
  container: HTMLElement,
  opts: { page: UiPage; port: number; sttLabel?: string },
): void {
  (window as unknown as { __bobBackend?: LocalBackend }).__bobBackend = backend;
  (window as unknown as { __bobBackendReady?: Promise<void> }).__bobBackendReady = backend.ready;

  const pageHtml = (page: UiPage): string =>
    page === "settings"
      ? buildSettingsHtml({ port: opts.port })
      : buildChatHtml({ port: opts.port }, opts.sttLabel ?? "voice: not configured");

  const iframe = document.createElement("iframe");
  iframe.id = "bob-ui";
  iframe.style.cssText = "border:0;width:100%;height:100%;display:block;background:transparent";
  container.replaceChildren(iframe);

  const render = (page: UiPage): void => {
    iframe.srcdoc = pageHtml(page).replace("</head>", `<script>${SHIM_SCRIPT}</script></head>`);
  };

  iframe.addEventListener("load", () => {
    const doc = iframe.contentDocument;
    if (!doc) return;
    // Intercept in-page navigation between the chat page and settings.
    doc.addEventListener(
      "click",
      (event) => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
        if (!anchor) return;
        // srcdoc iframes can't resolve relative hrefs, so match the raw value.
        const raw = anchor.getAttribute("href") || "";
        if (raw.startsWith("/api/files/download")) {
          // Downloads are native navigation; fetch via the backend and save.
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
        if (raw === "/settings" || raw === "/") {
          event.preventDefault();
          render(raw === "/settings" ? "settings" : "chat");
        }
      },
      true,
    );
  });

  render(opts.page);
}
