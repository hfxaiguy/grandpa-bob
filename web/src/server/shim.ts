/**
 * Transport shim injected into the hosted admin page (a same-origin iframe).
 *
 * It overrides `fetch` and `EventSource` so the page's `/api/*` calls are
 * served by the parent window's in-browser backend instead of a server. The
 * page HTML/JS itself is untouched, so it is the exact Node UI.
 *
 * Kept as a string: it must run as a classic script in the iframe's <head>
 * before the page's own inline script.
 */
export const SHIM_SCRIPT = `(function () {
  function parentWin() { return window.parent; }
  function wait() { return (parentWin() && parentWin().__bobBackendReady) || Promise.resolve(); }
  function backend() { return parentWin().__bobBackend; }
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  // srcdoc iframes have an about:srcdoc base, so match /api paths directly.
  function apiPath(url) {
    var origin = (parentWin() && parentWin().location && parentWin().location.origin) || "";
    var rel = null;
    if (url.indexOf("/api/") === 0) { rel = url; }
    else if (origin && url.indexOf(origin + "/api/") === 0) { rel = url.slice(origin.length); }
    if (rel === null) { return null; }
    var q = rel.indexOf("?");
    return { pathname: q >= 0 ? rel.slice(0, q) : rel, search: q >= 0 ? rel.slice(q + 1) : "" };
  }
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    var method = (init && init.method) || (input && input.method) || "GET";
    var body = init && init.body ? init.body : null;
    var api = apiPath(url);
    if (api) {
      return wait().then(function () {
        return backend().request(method, api.pathname, new URLSearchParams(api.search), body);
      }).then(function (res) {
        var text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
        return new Response(text, { status: res.status || 200, headers: { "content-type": res.contentType || "application/json" } });
      });
    }
    return nativeFetch ? nativeFetch(input, init) : Promise.reject(new Error("fetch unavailable"));
  };
  function LocalEventSource(url) {
    var self = this;
    self.url = url;
    self.readyState = 0;
    self.onopen = null;
    self.onmessage = null;
    self.onerror = null;
    self._unsub = null;
    self.close = function () { self.readyState = 2; if (self._unsub) { self._unsub(); self._unsub = null; } };
    if (String(url).indexOf("/api/events") === 0) {
      wait().then(function () {
        self.readyState = 1;
        if (self.onopen) { self.onopen({}); }
        self._unsub = backend().subscribe(function (msg) {
          if (self.onmessage) { self.onmessage({ data: JSON.stringify(msg) }); }
        });
      }).catch(function () { if (self.onerror) { self.onerror({}); } });
    }
  }
  window.EventSource = LocalEventSource;
})();`;
