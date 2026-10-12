/**
 * Transport shim: overrides `fetch` and `EventSource` so the UI's `/api/*`
 * calls are served by the in-browser backend instead of a server.
 *
 * Installed two ways: directly in the top window (the tiled app mounts there)
 * and injected as a classic script into the settings iframe. Both run this
 * same function, so the two hosts behave identically.
 */
export function installShim(target: Window): void {
  const win = target as Window & { __bobBackend?: unknown; __bobBackendReady?: Promise<void> };
  function parentWin(): (Window & { __bobBackend?: unknown; __bobBackendReady?: Promise<void> }) | null {
    return (win.parent as typeof win) || win;
  }
  function wait(): Promise<void> {
    const p = parentWin();
    return (p && p.__bobBackendReady) || Promise.resolve();
  }
  function backend(): { request: (m: string, p: string, s: URLSearchParams, b: unknown) => Promise<{ status?: number; body: unknown; contentType?: string }>; subscribe: (cb: (msg: unknown) => void) => () => void } {
    return (parentWin() as any).__bobBackend;
  }
  const nativeFetch = win.fetch ? win.fetch.bind(win) : null;
  function apiPath(url: string): { pathname: string; search: string } | null {
    const origin = (parentWin() && parentWin()!.location && parentWin()!.location.origin) || "";
    let rel: string | null = null;
    if (url.indexOf("/api/") === 0) rel = url;
    else if (origin && url.indexOf(origin + "/api/") === 0) rel = url.slice(origin.length);
    if (rel === null) return null;
    const q = rel.indexOf("?");
    return { pathname: q >= 0 ? rel.slice(0, q) : rel, search: q >= 0 ? rel.slice(q + 1) : "" };
  }
  win.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || String(input);
    const method = (init && init.method) || (typeof input === "object" && "method" in (input as object) ? (input as Request).method : "GET");
    const body = init && init.body ? init.body : null;
    const api = apiPath(url);
    if (api) {
      return wait()
        .then(() => backend().request(method, api.pathname, new URLSearchParams(api.search), body))
        .then((res) => {
          const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
          return new Response(text, { status: res.status || 200, headers: { "content-type": res.contentType || "application/json" } });
        });
    }
    return nativeFetch ? nativeFetch(input, init) : Promise.reject(new Error("fetch unavailable"));
  } as typeof win.fetch;

  function LocalEventSource(this: any, url: string | URL) {
    const self = this;
    self.url = String(url);
    self.readyState = 0;
    self.onopen = null;
    self.onmessage = null;
    self.onerror = null;
    self._unsub = null;
    self.close = function () {
      self.readyState = 2;
      if (self._unsub) {
        self._unsub();
        self._unsub = null;
      }
    };
    if (self.url.indexOf("/api/events") === 0) {
      wait()
        .then(() => {
          self.readyState = 1;
          if (self.onopen) self.onopen({});
          self._unsub = backend().subscribe((msg: unknown) => {
            if (self.onmessage) self.onmessage({ data: JSON.stringify(msg) });
          });
        })
        .catch(() => {
          if (self.onerror) self.onerror({});
        });
    }
  }
  (win as unknown as { EventSource: unknown }).EventSource = LocalEventSource;
}

/** Classic-script form, injected into an iframe's <head>. */
export const SHIM_SCRIPT = `(${installShim.toString()})(window);`;
