# Feature plan — end-user browser automation: chrome.debugger extension transport

Status as of 2026-10-30. **Phase 0 shipped** (launcher script + Connect browser…
dialog, see below); the extension transport is designed but not started. Work on
the extension happens on a `browser-extension` worktree branched from `main`.

Scope: **hosted, client-only deployments** — the end user opens Bobkat from a URL,
has no Node process of their own, and a **separate automation window is
acceptable** (their normal Chrome profile's tabs do not need to be driven).

Decision in one line: **browser automation for end users is delivered by a packaged
MV3 extension that drives a dedicated Chrome window through `chrome.debugger`; the
existing `?cdp=` browser-level WebSocket transport stays as the developer/self-hosted
path and is not removed.**

### Phase 0 — launcher script + Connect browser… UI (shipped 2026-10-30)

The zero-install path lands first, reusing the existing `?cdp=` transport:

- `web/public/scripts/bob-browser.sh` — POSIX launcher: finds Chrome/Chromium,
  starts a dedicated profile (`~/.bobkat/chrome-profile`) with
  `--remote-debugging-port=9222` + `--remote-allow-origins=<app origin>`, reads
  `webSocketDebuggerUrl` from `/json/version`, and hands the app URL with
  `?cdp=…` to the running instance as a new tab. `BOB_NO_OPEN=1` prints the URL;
  `BOB_BROWSER_HEADLESS=1` runs windowless.
- `web/public/scripts/bob-browser.ps1` — the Windows PowerShell twin (Chrome,
  Edge fallback, `%LOCALAPPDATA%\Bobkat\chrome-profile`).
- **Sync… → Connect browser…** (`web/index.html` `#browser-dialog`,
  `web/src/profile-ui.ts` `wireBrowserDialog`) — OS tabs (Windows/macOS/Linux,
  preselected from the user agent), the copyable one-liner
  (`curl … | sh -s -- <app-url>` / `$env:BOB_APP_URL=…; irm … | iex`), download
  links, a "what this runs" preview of the served script, and an editable app
  URL for self-hosted copies (validated before it reaches a shell command).
- `browser-cdp.ts` / `cdp.ts` error copy branches on `location.hostname`:
  loopback builds keep `npm run chrome`; hosted builds point at the dialog.

Known wrinkle (documented in the dialog): a hosted `https://` page opening
`ws://127.0.0.1` triggers Chrome's local-network access prompt on first connect.
The extension path remains the follow-up that removes both the script and the
prompt.

---

## Why

Today the four browser tools work only through a developer flow:

1. `npm run chrome` (`web/scripts/chrome.mjs`) starts a *separate* Chrome with
   `--remote-debugging-port` + `--remote-allow-origins` and a dedicated profile;
2. it reads `/json/version` server-side (Node has no CORS);
3. it opens the app with `?cdp=<browser ws url>`, persisted in localStorage and
   handed to the agent worker (`web/src/settings.ts:65`, `web/src/main.ts:76-78`).

That flow cannot be packaged for hosted end users: they have no Node, no launcher,
and no reason to know what a debug port is.

The obvious "pure CDP from the hosted page" alternative is **dead on arrival**, and
the repo already knew half of it (`web/src/agent/cdp.ts:1-19`, `web/README.md:277`).
Both blockers were re-verified empirically on Chrome 153 for this plan (see
[Evidence](#evidence)):

1. **Discovery is CORS-gated.** `http://127.0.0.1:<port>/json/version` returns the
   `webSocketDebuggerUrl` (with the unguessable browser UUID) and **no
   `Access-Control-Allow-Origin`** header. A hosted page can never read it.
2. **The WS upgrade is Origin-gated.** Chrome 111+ rejects every page-origin upgrade
   with **403** unless the origin is in `--remote-allow-origins` — the probe even got
   403 for `http://127.0.0.1:9333` itself. Only the process that starts Chrome can
   allow an origin, which a hosted end user cannot arrange.
3. For completeness: public HTTPS → loopback `fetch` is also subject to Chrome's
   **Local Network Access** permission, so even discovery-with-no-CORS is a dead end.

`chrome.debugger` sidesteps all three: it is the browser's own automation API for
extensions — no debug port, no flags, no relaunch, no PNA, and it works while the
user's normal Chrome is open. This is how end-user browser-automation products
ship. The cost is the one-time extension install.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Hosted page ↔ CDP directly | CORS + Origin 403 + Local Network Access; verified above |
| Ask the user to launch Chrome with flags and paste the WS URL | 4 technical steps; still refused without the right `--remote-allow-origins`; not an end-user path |
| Native messaging host / local helper process | Requires a native binary install — violates "client-only, no Node on their machine" |
| WebDriver / BiDi endpoint | Needs a driver process and a debug build; worse than the flags path |
| Bookmarklet / console snippet | Cannot launch a process; pages cannot open devtools sockets |

## Target architecture

```
hosted app page (:443)                          the user's normal Chrome
┌──────────────────────────────────────┐        ┌────────────────────────────────────┐
│ main thread                          │        │ MV3 extension (fixed ID via "key") │
│  AgentClient ── ext relay ◄──────────┼─Port──►│  background service worker         │
│       │ postMessage (run opts)       │        │   · validates allowlisted commands │
│       ▼                              │        │   · chrome.windows/tabs lifecycle  │
│  agent worker                        │        │   · chrome.debugger.attach/send    │
│   browser_* verbs → PageSession      │        │            │                       │
│   transport: "extension" | "cdp"     │        │            ▼                       │
└──────────────────────────────────────┘        │  dedicated automation window       │
                                                │   └─ work tab (about:blank)        │
                                                │      Runtime.evaluate etc.         │
                                                └────────────────────────────────────┘
```

Transport selection (in the worker, resolved by the main thread before the run):

| Condition | Transport |
|---|---|
| `?cdp=` endpoint present/persisted (dev, self-hosted) | existing WS transport (`cdp.ts`) — unchanged |
| no `?cdp=`, extension probe succeeds | **extension transport** (this plan) |
| neither | the four tools return the install-the-extension error |

### Critical constraint: the worker cannot talk to the extension

`chrome.runtime` is **not exposed inside web workers**. The agent — and therefore
the browser verbs — run in `agent-worker.ts` (`web/src/agent/agent-worker.ts:705`
receives run options; `agent-client.ts:69` owns the `Worker`). So the extension
Port must live on the **main thread**, and the worker reaches it through the
existing postMessage RPC:

- worker → main: `{ type: "ext", id, cmd, args }`
- main → worker: `{ type: "ext-result", id, ok, value | error }`

`AgentClient` (`web/src/agent/agent-client.ts`) hosts an `ExtensionBridge` and
answers those messages; the worker-side `PageSession` implementation just awaits
them. The `?cdp=` path stays entirely in the worker and is untouched.

## Extension design

### Identity and manifest

- MV3, `background.service_worker`, no content scripts, no remote code.
- Permissions: `debugger`, `storage` (for `chrome.storage.session` state). Tab URL
  access comes with the debugger attachment; `tabs` is not needed for
  create/navigate.
- **Fixed ID:** include a `"key"` (the public half of a dedicated keypair) in
  `manifest.json`. Unpacked installs then get the *same ID on every machine*, which
  makes `externally_connectable` and `chrome.runtime.sendMessage(EXT_ID, …)` from
  the hosted page work without runtime discovery.
- `externally_connectable.matches`: the hosted origin(s) plus
  `http://localhost/*` / `http://127.0.0.1/*` for dev. Exact origins only — never
  `<all_urls>`.
- Icons, name, description; the install warning text will effectively say "read and
  change all your data on all websites" (debugger permission) — document it in the
  install guide rather than hide it.

### Protocol (page ↔ extension)

A named Port (`chrome.runtime.connect(EXT_ID, { name: "bobkat" })`), JSON messages
with `{ id, cmd, args }` / `{ id, ok, value | error }`. The extension validates the
sender origin and a **small command allowlist** — it is not a generic
`chrome.debugger.sendCommand` passthrough:

| Command | Extension action |
|---|---|
| `hello` | `{ version, browser, attached, windowId?, tabId? }` — used by the probe |
| `open` | `chrome.windows.create({ url: "about:blank" })` + attach; returns `{ tabId, url }` |
| `page` | current URL/title of the work tab |
| `evaluate` | `Runtime.evaluate` (returnByValue) on the work tab |
| `evaluateHandles` | `Runtime.evaluate` (objectIds, returned as an array of ids) |
| `callFunction` | `Runtime.callFunctionOn` on an objectId |
| `eventListenerTypes` | `DOMDebugger.getEventListeners` on an objectId |
| `navigate` | `Page.navigate` (or `location.href` eval) |
| `close` | detach + `chrome.windows.remove` the automation window |
| `disconnect` | detach, keep the window (user can close it) |

The unwrap/async-retry semantics stay in `web/src/agent/cdp.ts`-style code on the
app side (the verbs are transport-agnostic), so the extension does not need to
reimplement them.

### Target lifecycle

- One **dedicated automation window** with a single pinned **work tab** per run,
  mirroring `browser-cdp.ts:109-140`'s "one tab per run" behavior. `open` creates
  it lazily on the first browser tool call.
- The window id / tab id live in `chrome.storage.session`, because the MV3 service
  worker may be suspended between calls. On wake, re-check
  `chrome.debugger.getTargets` and reattach if needed.
- `chrome.debugger.onDetach` (user clicked "Cancel" on the yellow infobar, tab
  crashed, window closed) is forwarded as a Port event so the next tool call fails
  with an actionable message instead of hanging.
- Page reload / app reconnect reuses the existing automation window when it still
  exists; "Disconnect" in the app closes it.
- Attaching to `chrome://`, Web Store and other extensions' pages is refused by
  Chrome — surface that as a friendly verb error.

### Extension ID + origin in the app build

The hosted build needs the extension ID. Bake it into the web build
(`VITE_BOB_EXT_ID` or a generated constant), keep dev builds pointed at the
unpacked key's ID. The probe reads it and calls `chrome.runtime.sendMessage`; when
`chrome.runtime` is missing (Firefox/Safari) the browser-automation UI shows
"not supported in this browser".

## App changes

| File | Change |
|---|---|
| `web/src/agent/browser-cdp.ts` | extract the `Session`/`SessionPage` adapter (today inline at `:142-164`) so verbs bind to a transport-neutral session; on `transport: "extension"` build the session from the relay instead of `BrowserCdp`; new not-connected copy |
| `web/src/agent/cdp.ts` | unchanged (WS transport); move `unwrap`/`asyncWrap`/retry helpers somewhere shared if the extension adapter reuses them |
| `web/src/agent/agent-worker.ts` | accept `browserTransport` in run opts (`:594`); implement the worker half of the ext relay in `self.onmessage` (`:705`) |
| `web/src/agent/agent-client.ts` | `AgentRunOptions` gains `browserTransport`; own the `ExtensionBridge` (main thread), probe at boot, relay `ext` messages |
| `web/src/settings.ts`, `web/src/main.ts` | `?cdp=` flow untouched; add the extension probe result to the settings model shown in the UI |
| `web/src/ui/pages.ts` | "Browser automation" settings card: state (not installed / installed, not connected / connected), **Connect** / **Disconnect**, and the 3-step install guide link |
| new `web/src/agent/extension-bridge.ts` | Port lifecycle, probe, request/response with timeouts, reconnect with backoff |
| new `extension/` | MV3 manifest + background service worker + icons (plain JS, no build step needed for unpacked use) |
| new `web/scripts/build-extension.mjs` | package the unpacked folder + zip; verify the manifest key's ID matches `VITE_BOB_EXT_ID` |

`web/` boundary rule stands: the app must not import from `extension/`. The protocol
is a small duplicated contract on both sides; a unit test parses the allowlist out
of both files and fails if they diverge.

## Phases

### Phase 0 — extension skeleton + identity

- [ ] `extension/` with MV3 manifest (`"key"`, `externally_connectable`, debugger +
      storage permissions), empty command router, icons.
- [ ] `web/scripts/build-extension.mjs` (copy to `dist/extension/`, zip, verify key→ID).
- [ ] Load unpacked in Chromium 153; service worker starts; ID stable across two
      different machines/profiles.
- [ ] Confirm a page from a **non-allowlisted** origin cannot connect
      (`onConnectExternal` never fires).

**Acceptance:** ID is deterministic; a foreign origin is refused; the zip loads
after extraction.

### Phase 1 — protocol + command router

- [ ] Message types and validation in the extension; allowlist of the table above.
- [ ] `hello`, `open`, `close`, `disconnect` implemented; `open` creates the
      dedicated window and attaches the debugger; infobar appears.
- [ ] `chrome.storage.session` state; reattach after service-worker suspension.

**Acceptance:** scripted probe from a page reports connected; after forcing the
service worker to idle, the next command still works; `close` removes the window.

### Phase 2 — page command subset + worker relay

- [ ] `page`, `evaluate`, `evaluateHandles`, `callFunction`,
      `eventListenerTypes`, `navigate`.
- [ ] `web/src/agent/extension-bridge.ts` (main thread) + `AgentClient` wiring.
- [ ] Worker-side `PageSession` over the relay; extract the shared adapter in
      `browser-cdp.ts`; `browserTransport` in run opts.
- [ ] Timeouts, reconnect with backoff, `onDetach` propagation.

**Acceptance:** a run with a fake model executes `browser_body` / `browser_clickables`
against the automation window end-to-end with no `?cdp=` anywhere.

### Phase 3 — app UX

- [ ] Settings card with the three states; **Connect** opens/attaches the window,
      **Disconnect** closes it.
- [ ] Not-installed state shows the install guide (enable Developer mode → Load
      unpacked → pick the extracted folder); "verify" button re-probes.
- [ ] Unsupported-browser copy (Firefox/Safari) and Chromium-without-extension copy.
- [ ] Verb error text stops telling hosted users to run `npm run chrome`.

**Acceptance:** a fresh profile with no extension shows guide + disabled tools; after
install + Connect the tools work on the first try; Firefox shows unsupported.

### Phase 4 — packaging + install path

- [ ] Build outputs: `bobkat-extension-<version>.zip` + `INSTALL.md` with images.
- [ ] Versioned; upgrade = reload the unpacked folder.
- [ ] Decide/page: Chrome Web Store submission (see open decision #1). If adopted,
      add privacy-policy text and store listing assets; if not, the dev-mode guide
      stays the documented path.

**Acceptance:** an end user with only the zip follows the guide and reaches the
"connected" state without touching a terminal.

### Phase 5 — tests

- [ ] Unit: protocol validation, allowlist, key→ID derivation, origin refusal.
- [ ] New `web/scripts/extension-smoke.mjs`, same style as `browser-smoke.mjs`
      (spawn Chromium with `--load-extension=… --disable-extensions-except=…`,
      mock LLM, drive a run, assert all four verbs). Headless `--headless=new`
      supports extensions; keep it Linux/Chromium-gated like the other smokes.
- [ ] Regression: the `?cdp=` path still connects when supplied (manual smoke —
      `test:cdp` is already red on `main`, see `standalone-only.md:285`).

**Acceptance:** `npm run smoke:extension` green locally and in CI (skip cleanly
without Chromium); `?cdp=` unchanged.

### Phase 6 — docs + status

- [ ] `web/README.md` "Browser tools" section: two transports, who uses which.
- [ ] Root README endpoints/features blurb.
- [ ] Update `standalone-only.md` references if this plan lands first.
- [ ] `CHANGELOG.md` entry.

**Acceptance:** docs match behavior; the plan file's status header flipped to
"implemented".

## Verification gates (definition of done)

| # | Gate |
|---|---|
| 1 | Hosted app + installed extension + normal Chrome (no flags, no `?cdp=`) → all four verbs work |
| 2 | Extension ID deterministic (manifest `key`) and origin allowlist exact |
| 3 | No `chrome.runtime` use from workers; worker↔main relay is the only path |
| 4 | `?cdp=` developer path and `chrome.mjs` untouched and still working |
| 5 | Disconnect/user-cancel/closed-window all fail fast with actionable errors |
| 6 | `smoke:extension` green; existing smoke suite unchanged |
| 7 | No new `web/` tree vis-à-vis: app still imports nothing outside `web/` + `ui/` (`test:standalone` gate) |

## Security and privacy constraints

1. **Allowlist, not passthrough.** The extension accepts only the table's commands
   and shapes; no arbitrary `debugger.sendCommand` from page JS.
2. **Exact origins** in `externally_connectable`; validate `sender.origin` in
   `onConnectExternal`/`onMessageExternal` as well.
3. **No remote code** in the extension; the verbs themselves stay in the workspace
   app evaluated in the target tab, as today.
4. **Visible trust signal:** the yellow "started debugging this browser" infobar is
   never suppressed; the dedicated window makes it obvious what is automated.
5. **Least data:** nothing leaves the browser; no analytics in the extension.
6. **No key leakage:** only the public key belongs in `manifest.json`; the private
   key never ships.

## Open decisions

1. **Distribution:** unpacked/dev-mode (ships now, rough UX) vs Chrome Web Store
   (one-time $5, review scrutiny for `debugger`, needs privacy policy, best UX).
   Does not change the architecture — only phase 4's shape.
2. **Window vs tabs:** v1 drives a dedicated automation window only (per this
   plan). "Use a tab I pick" can be a later `open` variant; the protocol already
   carries the target.
3. **Browsers:** Chromium-only (Chrome/Edge/Brave). Firefox has no `chrome.debugger`
   equivalent exposed to extensions — show unsupported and keep Firefox for the
   `?cdp=`/do-nothing path.
4. **Auto-connect:** probe at boot and connect silently when installed, or require
   the user to press Connect once. Recommend explicit Connect (the infobar appears
   either way; consent should be a click).
5. **Self-hosted users:** they keep `npm run chrome`; optionally they can also load
   the same extension — no extra work planned.

## Code anchors

| Concern | Location |
|---|---|
| WS transport + why browser-level socket | `web/src/agent/cdp.ts:1-19` |
| Verb binding + transport seam | `web/src/agent/browser-cdp.ts:24-174` |
| Worker tool wiring | `web/src/agent/agent-worker.ts:594` |
| Worker message loop | `web/src/agent/agent-worker.ts:705` |
| Worker client / run options | `web/src/agent/agent-client.ts:33-124` |
| `?cdp=` persistence | `web/src/settings.ts:65`, `web/src/main.ts:76-78` |
| Launcher | `web/scripts/chrome.mjs:1-34` |
| Smoke harness pattern | `web/scripts/browser-smoke.mjs:14-55` |
| Standalone boundary gate | `scripts/web-standalone-test.ts` (`standalone-only.md:191-193`) |

## Evidence

Chrome/153.0.8010.52, `chromium --headless=new --remote-debugging-port=9333`:

```
$ curl -s -i http://127.0.0.1:9333/json/version | head -5
HTTP/1.1 200 OK
Content-Security-Policy:frame-ancestors 'none'
Content-Length:411
Content-Type:application/json; charset=UTF-8
                                    ← no Access-Control-Allow-Origin
```

WebSocket upgrade probe (raw handshake with an `Origin` header):

```
https://evil.example      -> 403
http://127.0.0.1:9333     -> 403     (with no --remote-allow-origins)
```

Re-run both before implementing phase 0; if Chrome ever starts sending CORS headers
or relaxing the Origin check, revisit this plan's first rejected alternative.
