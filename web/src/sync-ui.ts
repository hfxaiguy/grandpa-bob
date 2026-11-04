/**
 * The Live sync pairing UI: one code form (BobSwap relay or desktop/server),
 * plus manual paste (no service).
 *
 * Same-origin tabs reconcile automatically (BroadcastChannel) — this dialog
 * exists for CROSS-DEVICE pairs. The code form has a source switch: the relay
 * path is automatic (BobSwap REST mailbox; codes are single-use and the signal
 * mailbox carries SDP/ICE only), while the desktop path joins the loopback
 * mailbox created by `npm run pair` and binds a mirror folder + exec
 * capabilities after the console approves. Manual pairing is the no-service
 * path: one blob per direction, exchanged by any means (a Telegram message
 * works). The create/join responses supply the ICE servers the peer connection
 * uses (STUN, plus TURN when configured).
 */
import { activeSwapService, defaultSwapService, type SwapService } from "./swap";
import { pairWithServer, type ServerConnection } from "./server-link";
import { bindDesktopMirror } from "./profiles";
import { loadStorageServer } from "./settings";
import { toIceServers } from "./sync/transport-webrtc";
import type { PendingPairing, SyncHandle } from "./sync";
import { emptyTransfer, type SyncState, type TransferState } from "./sync/engine";

type SyncGetter = () => SyncHandle | null;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string): void {
  const node = el(id);
  if (node) node.textContent = text;
}

function statusLine(state: SyncState): string {
  const conflicts = state.conflicts.length ? ` · ${state.conflicts.length} conflict(s)` : "";
  return `${state.status}${state.detail ? ` — ${state.detail}` : ""}${conflicts}`;
}

const DIRECTION_LABEL: Record<TransferState["direction"], string> = {
  idle: "⇅ idle",
  up: "↑ sending",
  down: "↓ receiving",
  both: "⇅ sending + receiving",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** Paint the shared transfer block in the Sync and Pair dialogs. */
function renderTransfer(stats: TransferState | null): void {
  const t = stats ?? emptyTransfer();
  const active = t.direction !== "idle";
  const parts: string[] = [];
  if (t.roundTotal > 0) parts.push(`${t.roundDone}/${t.roundTotal} files`);
  if (t.sent || t.received) {
    parts.push(`↓ ${formatBytes(t.received)}`, `↑ ${formatBytes(t.sent)}`);
  } else {
    parts.push("no data transfer yet");
  }
  if (active && t.path) parts.push(t.path);

  for (const prefix of ["live", "pair"]) {
    const wrap = el<HTMLElement>(`${prefix}-transfer`);
    if (!wrap) continue;
    wrap.dataset.direction = t.direction;
    setText(`${prefix}-transfer-dir`, DIRECTION_LABEL[t.direction]);
    setText(`${prefix}-transfer-text`, parts.join(" · "));
    const bar = el<HTMLProgressElement>(`${prefix}-transfer-bar`);
    if (!bar) continue;
    const determinate = t.roundTotal > 0;
    bar.hidden = !determinate && !active;
    if (determinate) {
      bar.max = 100;
      bar.value = Math.round((t.roundDone / t.roundTotal) * 100);
    } else if (active) {
      // Serving an unknown number of requests: indeterminate.
      bar.removeAttribute("value");
    }
  }
}

function relayUnreachable(base: string, err: unknown): Error {
  const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
  return new Error(`cannot reach ${base}${detail} — check the relay in BobSwap… and the network`);
}

/** Create a sync channel on a BobSwap service (offerer side). */
async function createSwapChannel(service: SwapService): Promise<{
  id: string;
  code: string;
  roleToken: string;
  role: "offerer" | "answerer" | "joiner";
  iceServers: RTCIceServer[];
}> {
  const base = service.baseUrl.replace(/\/$/, "");
  const key = service.readKey ?? service.uploadKey;
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/sync/channels`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: "{}",
    });
  } catch (err) {
    throw relayUnreachable(base, err);
  }
  const data = (await res.json().catch(() => ({}))) as {
    channel_id?: string;
    pairing_code?: string;
    role_token?: string;
    role?: string;
    ice_servers?: unknown;
    error?: string;
  };
  if (!res.ok) {
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      throw new Error(`${data.error ?? "rate limited"}${retry ? ` — retry in ${retry}s` : ""}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "this relay needs a BobSwap key to create a code — add one in BobSwap…, or switch to My desktop / server",
      );
    }
    throw new Error(data.error ?? `service said HTTP ${res.status} (sync channels may not be deployed yet)`);
  }
  if (!data.channel_id || !data.pairing_code || !data.role_token) {
    throw new Error("the service answered without a channel, pairing code or role token");
  }
  return {
    id: data.channel_id,
    code: data.pairing_code,
    roleToken: data.role_token,
    role: data.role === "answerer" || data.role === "joiner" ? data.role : "offerer",
    iceServers: toIceServers(data.ice_servers),
  };
}

/** Join with a single code (answerer side); the service resolves the channel. */
async function joinSwapChannel(
  service: SwapService,
  code: string,
): Promise<{
  id: string;
  roleToken: string;
  role: "offerer" | "answerer" | "joiner";
  iceServers: RTCIceServer[];
}> {
  const base = service.baseUrl.replace(/\/$/, "");
  const key = service.readKey ?? service.uploadKey;
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/sync/channels/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    throw relayUnreachable(base, err);
  }
  const data = (await res.json().catch(() => ({}))) as {
    channel_id?: string;
    role_token?: string;
    role?: string;
    ice_servers?: unknown;
    error?: string;
  };
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("this relay has no single-code join — update it, or switch to My desktop / server");
    }
    const retry = res.headers.get("retry-after");
    const suffix = res.status === 429 && retry ? ` — retry in ${retry}s` : "";
    throw new Error(`${data.error ?? `join failed: HTTP ${res.status}`}${suffix}`);
  }
  if (!data.channel_id || !data.role_token) throw new Error("the service answered without a channel or role token");
  return {
    id: data.channel_id,
    roleToken: data.role_token,
    role: data.role === "answerer" || data.role === "joiner" ? data.role : "answerer",
    iceServers: toIceServers(data.ice_servers),
  };
}

export function wireSyncUi(getSync: SyncGetter): void {
  const dialog = el<HTMLDialogElement>("pair-dialog");
  const open = el<HTMLButtonElement>("live-pair");
  const close = el<HTMLButtonElement>("pair-close");
  if (!dialog || !open) return;

  let manual: { accept: (blob: string) => void; done: Promise<string> } | null = null;

  const setStatus = (text: string): void => setText("pair-status", text);
  const setVerify = (phrase: string): void => setText("pair-verify", phrase);

  // ── explicit phrase confirmation ─────────────────────────────────────
  // A displayed phrase is not consent. Both ends must press the button before
  // the link exchanges catalogs or data. The desktop path uses the CLI approval
  // as its confirmation; the browser still presses here before sending `ready`.
  let pendingPairing: PendingPairing | null = null;
  const confirmWrap = el<HTMLElement>("pair-confirm-wrap");
  const confirmButton = el<HTMLButtonElement>("pair-phrase-ok");
  const rejectButton = el<HTMLButtonElement>("pair-phrase-no");
  const hideConfirm = (): void => {
    if (confirmWrap) confirmWrap.hidden = true;
    if (confirmButton) confirmButton.disabled = false;
    if (rejectButton) rejectButton.disabled = false;
  };
  const waitForPairingReady = (pairing: PendingPairing): void => {
    hideConfirm();
    setStatus("waiting for the other side to confirm the phrase…");
    progress("waiting for the other side to confirm…");
    void pairing.ready
      .then(() => {
        progress("verification phrase confirmed");
        progressDone();
        setStatus("connected — profile catalog exchanged");
        updateLiveStatus();
      })
      .catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        progressFailed(`pairing aborted: ${text}`);
        setStatus(`pairing aborted: ${text}`);
      });
  };
  const showPhraseConfirm = (pairing: PendingPairing, phrase: string): void => {
    pendingPairing = pairing;
    // The gate can reject on timeout/peer mismatch while the user is still
    // comparing; keep that from surfacing as an unhandled rejection.
    void pairing.ready.catch(() => undefined);
    setVerify(phrase);
    if (confirmWrap) confirmWrap.hidden = false;
    progress("verification phrase ready — compare it, then confirm");
    setStatus("compare the phrase on both devices, then press “Phrase matches” on both");
  };
  confirmButton?.addEventListener("click", () => {
    const pairing = pendingPairing;
    if (!pairing) return;
    pendingPairing = null;
    if (confirmButton) confirmButton.disabled = true;
    if (rejectButton) rejectButton.disabled = true;
    pairing.confirm();
    waitForPairingReady(pairing);
  });
  rejectButton?.addEventListener("click", () => {
    const pairing = pendingPairing;
    if (!pairing) return;
    pendingPairing = null;
    pairing.reject("the phrase does not match");
    hideConfirm();
    progressFailed("phrase rejected — nothing was exchanged");
    setStatus("phrase rejected — nothing was exchanged");
  });

  // ── pairing progress ──────────────────────────────────────────────────
  // A short, live timeline so a browser-to-browser handshake is observable on
  // both ends: each transport status becomes a line and the last one stays
  // highlighted until the next arrives. "Retry pairing" replays the attempt.
  type ProgressState = "active" | "done" | "failed";
  interface ProgressLine {
    text: string;
    state: ProgressState;
    at: string;
  }
  const progressList = el<HTMLOListElement>("pair-progress");
  const retryButton = el<HTMLButtonElement>("pair-retry");
  const retryWrap = el<HTMLElement>("pair-retry-wrap");
  let progressLines: ProgressLine[] = [];
  let retryAction: (() => void) | null = null;
  let pairingActive = false;

  const clock = (): string =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  const renderProgress = (): void => {
    if (!progressList) return;
    progressList.replaceChildren(
      ...progressLines.map((line) => {
        const row = document.createElement("li");
        row.dataset.state = line.state;
        row.append(line.text);
        const at = document.createElement("span");
        at.className = "at";
        at.textContent = line.at;
        row.append(at);
        return row;
      }),
    );
    progressList.hidden = progressLines.length === 0;
    progressList.scrollTop = progressList.scrollHeight;
  };

  /** Begin an attempt: clear the timeline, wire the manual retry trigger. */
  const beginPairing = (retry: () => void): void => {
    pairingActive = true;
    progressLines = [];
    retryAction = retry;
    pendingPairing = null;
    hideConfirm();
    setVerify("—");
    if (retryWrap) retryWrap.hidden = false;
    if (retryButton) retryButton.disabled = true;
    renderProgress();
  };

  const progress = (text: string): void => {
    if (!pairingActive) return;
    const previous = progressLines[progressLines.length - 1];
    // The relay polls once a second; repeat the same status instead of
    // stacking identical rows.
    if (previous && previous.state === "active" && previous.text === text) {
      previous.at = clock();
      renderProgress();
      return;
    }
    for (const line of progressLines) if (line.state === "active") line.state = "done";
    progressLines.push({ text, state: "active", at: clock() });
    renderProgress();
  };

  const progressDone = (): void => {
    pairingActive = false;
    for (const line of progressLines) if (line.state === "active") line.state = "done";
    if (retryButton) retryButton.disabled = false;
    renderProgress();
  };

  const progressFailed = (message: string): void => {
    if (!pairingActive) return;
    pairingActive = false;
    for (const line of progressLines) if (line.state === "active") line.state = "done";
    progressLines.push({ text: message, state: "failed", at: clock() });
    if (retryButton) retryButton.disabled = false;
    renderProgress();
  };

  retryButton?.addEventListener("click", () => {
    const action = retryAction;
    if (!action) {
      setStatus("nothing to retry — start a pairing first");
      return;
    }
    setStatus("retrying the last pairing attempt…");
    action();
  });

  /** Transport callbacks only feed the timeline while an attempt is live. */
  const onPairStatus = (text: string): void => progress(text);
  const activeProfile = (): string => localStorage.getItem("bob:profile") || "default";
  const defaultDesktopUrl = (): string => {
    // A phone cannot reach the desktop's loopback mailbox. On a remote page
    // the shared BobSwap relay is the useful default; a local desktop keeps
    // its loopback bridge.
    const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
    if (local) return loadStorageServer();
    const saved = loadStorageServer();
    if (!/^http:\/\/(127\.0\.0\.1|localhost):8795\/?$/.test(saved)) return saved;
    return activeSwapService()?.baseUrl ?? defaultSwapService().baseUrl;
  };
  const serverUrl = (): string => {
    const input = el<HTMLInputElement>("pair-server-url");
    // Normalize the saved bridge URL: a stale file:/// or bare host value would
    // otherwise reach fetch() and surface as Firefox's bare NetworkError.
    const fallback = defaultDesktopUrl();
    if (input && !input.value) input.value = fallback;
    return input?.value.trim() || fallback;
  };
  const pairCode = (): string => el<HTMLInputElement>("pair-code")?.value.trim() ?? "";
  const showActiveProfile = (): void => setText("pair-server-profile", activeProfile());

  const PAIR_SOURCE_KEY = "bob:pair-source";
  type PairSource = "relay" | "desktop";
  const pairSource = (): PairSource => {
    try {
      return localStorage.getItem(PAIR_SOURCE_KEY) === "desktop" ? "desktop" : "relay";
    } catch {
      return "relay";
    }
  };
  const relayService = (): SwapService => activeSwapService() ?? defaultSwapService();
  const updatePairMode = (): void => {
    const desktop = pairSource() === "desktop";
    const relayRadio = el<HTMLInputElement>("pair-source-relay");
    const desktopRadio = el<HTMLInputElement>("pair-source-desktop");
    if (relayRadio) relayRadio.checked = !desktop;
    if (desktopRadio) desktopRadio.checked = desktop;
    const relayHint = el<HTMLElement>("pair-hint-relay");
    const desktopHint = el<HTMLElement>("pair-hint-desktop");
    if (relayHint) relayHint.hidden = desktop;
    if (desktopHint) desktopHint.hidden = !desktop;
    const create = el<HTMLButtonElement>("pair-create-code");
    if (create) create.hidden = desktop;
    const advanced = el<HTMLDetailsElement>("pair-advanced");
    if (advanced) advanced.hidden = !desktop;
    const join = el<HTMLButtonElement>("pair-join-code");
    if (join) join.textContent = desktop ? "Pair with desktop" : "Pair with code";
    const saved = activeSwapService();
    const keyNote = el<HTMLElement>("pair-relay-key-note");
    if (keyNote) keyNote.hidden = desktop || Boolean(saved?.readKey || saved?.uploadKey);
    setText("pair-relay-url", saved ? saved.baseUrl : `${defaultSwapService().baseUrl} (default)`);
  };
  const setPairSource = (source: PairSource): void => {
    try {
      localStorage.setItem(PAIR_SOURCE_KEY, source);
    } catch {
      /* private mode */
    }
    const created = el<HTMLElement>("pair-created-wrap");
    if (created) created.hidden = true;
    updatePairMode();
  };
  const fillServerUrl = (): void => {
    const input = el<HTMLInputElement>("pair-server-url");
    if (input && !input.value) input.value = defaultDesktopUrl();
  };

  // Live status line in the Sync… dialog. Subscribe lazily: a secondary tab
  // starts its engine only when the lease is promoted, after this wiring.
  let watchedSync: SyncHandle | null = null;
  let unwatchState: (() => void) | null = null;
  const watchSync = (): void => {
    const sync = getSync();
    if (sync === watchedSync) return;
    unwatchState?.();
    watchedSync = sync;
    unwatchState = sync?.onState(() => updateLiveStatus()) ?? null;
  };
  const updateLiveStatus = (): void => {
    const sync = getSync();
    if (!sync) {
      setText("live-sync-status", "not running here — this tab is not the workspace host");
      renderTransfer(null);
      return;
    }
    const state = sync.state();
    setText("live-sync-status", statusLine(state));
    renderTransfer(state.transfer);
  };

  // A manual round covers more than a desktop mirror: paired tabs/devices too.
  const syncNowButton = el<HTMLButtonElement>("live-sync-now");
  syncNowButton?.addEventListener("click", () => {
    const handle = getSync();
    if (!handle) {
      setText("live-sync-status", "not running here — this tab is not the workspace host");
      return;
    }
    syncNowButton.disabled = true;
    setText("live-sync-status", "syncing…");
    void handle
      .syncNow()
      .then(({ peers, completed }) => {
        if (!peers) {
          setText("live-sync-status", "no peers connected — pair with another device first");
          return;
        }
        if (!completed) {
          setText("live-sync-status", `asked ${peers} peer(s) for a map — no answer yet`);
          return;
        }
        updateLiveStatus();
      })
      .catch((err) => {
        setText("live-sync-status", `sync failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        syncNowButton.disabled = false;
      });
  });

  open.addEventListener("click", () => {
    watchSync();
    updateLiveStatus();
    showActiveProfile();
    updatePairMode();
    fillServerUrl();
    dialog.showModal();
  });
  close?.addEventListener("click", () => dialog.close());
  watchSync();
  updateLiveStatus();
  showActiveProfile();
  updatePairMode();

  const requireSync = (): SyncHandle | null => {
    const handle = getSync();
    if (!handle) {
      setStatus("this tab does not host the workspace — take over the workspace first");
      return null;
    }
    return handle;
  };

  // ── manual paste (no service) ────────────────────────────────────────
  function startManualOffer(): void {
    const handle = requireSync();
    if (!handle) return;
    beginPairing(startManualOffer);
    setVerify("—");
    setStatus("gathering candidates — your pairing blob appears below");
    progress("gathering the offer (all ICE candidates)…");
    (el<HTMLTextAreaElement>("pair-input") as HTMLTextAreaElement).value = "";
    const pairing = handle.startManualPairing(
      "offerer",
      (blob) => {
        const out = el<HTMLTextAreaElement>("pair-output");
        if (out) out.value = blob;
        progress("offer blob ready — hand it to the other device");
        setStatus("hand this blob to the other device, then paste their answer below and press “finish”");
      },
      onPairStatus,
    );
    manual = pairing;
    pairing.done
      .then((phrase) => {
        showPhraseConfirm(pairing, phrase);
      })
      .catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        progressFailed(`pairing failed: ${text}`);
        setStatus(`pairing failed: ${text}`);
      });
  }

  function startManualJoin(): void {
    const handle = requireSync();
    if (!handle) return;
    const offer = (el<HTMLTextAreaElement>("pair-input") as HTMLTextAreaElement)?.value.trim();
    if (!offer) {
      setStatus("paste the other device's offer blob first");
      return;
    }
    beginPairing(startManualJoin);
    setVerify("—");
    setStatus("reading their offer…");
    progress("reading their offer…");
    const pairing = handle.startManualPairing(
      "joiner",
      (blob) => {
        const out = el<HTMLTextAreaElement>("pair-output");
        if (out) out.value = blob;
        progress("answer blob ready — send it back");
        setStatus("send this answer blob back, then wait for the channel to open");
      },
      onPairStatus,
    );
    manual = pairing;
    pairing.accept(offer);
    pairing.done
      .then((phrase) => {
        showPhraseConfirm(pairing, phrase);
      })
      .catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        progressFailed(`pairing failed: ${text}`);
        setStatus(`pairing failed: ${text}`);
      });
  }

  el<HTMLButtonElement>("pair-offer")?.addEventListener("click", () => startManualOffer());
  el<HTMLButtonElement>("pair-join")?.addEventListener("click", () => startManualJoin());

  el<HTMLButtonElement>("pair-answer")?.addEventListener("click", () => {
    if (!manual) {
      setStatus("start an offer first");
      return;
    }
    const answer = (el<HTMLTextAreaElement>("pair-input") as HTMLTextAreaElement)?.value.trim();
    if (!answer) {
      setStatus("paste the other device's answer blob first");
      return;
    }
    progress("answer pasted — checking it…");
    manual.accept(answer);
    setStatus("checking the answer…");
  });

  // ── Code pairing: relay (BobSwap) or desktop/server ──────────────────
  el<HTMLInputElement>("pair-source-relay")?.addEventListener("change", () => setPairSource("relay"));
  el<HTMLInputElement>("pair-source-desktop")?.addEventListener("change", () => setPairSource("desktop"));

  const validCode = (): string | null => {
    const code = pairCode();
    if (!/^\d{4}-?\d{4}$/.test(code)) {
      setStatus("enter the 8-digit pairing code");
      return null;
    }
    return code;
  };

  const startRelayJoin = (): void => {
    const handle = requireSync();
    if (!handle) return;
    const code = validCode();
    if (!code) return;
    beginPairing(startRelayJoin);
    setVerify("—");
    void (async () => {
      try {
        const swap = relayService();
        progress(`joining via ${swap.baseUrl}…`);
        setStatus(`joining via ${swap.baseUrl}…`);
        const joined = await joinSwapChannel(swap, code);
        progress("code accepted — pairing");
        const pairing = await handle.pairBobSwap({
          baseUrl: swap.baseUrl,
          readKey: swap.readKey ?? swap.uploadKey,
          id: joined.id,
          roleToken: joined.roleToken,
          role: joined.role,
          iceServers: joined.iceServers,
          onStatus: onPairStatus,
        });
        const phrase = await pairing.done;
        showPhraseConfirm(pairing, phrase);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        progressFailed(`relay pairing failed: ${text}`);
        setStatus(`relay pairing failed: ${text}`);
      }
    })();
  };

  const startRelayOffer = (): void => {
    const handle = requireSync();
    if (!handle) return;
    beginPairing(startRelayOffer);
    void (async () => {
      try {
        const swap = relayService();
        progress(`creating a code via ${swap.baseUrl}…`);
        setStatus(`creating a code via ${swap.baseUrl}…`);
        const channel = await createSwapChannel(swap);
        const created = el<HTMLElement>("pair-created-wrap");
        if (created) created.hidden = false;
        setText("pair-created-code", channel.code);
        progress(`code ${channel.code} created — share it with the other browser`);
        setStatus("share the 8-digit code with the other device, then wait");
        const pairing = await handle.pairBobSwap({
          baseUrl: swap.baseUrl,
          readKey: swap.readKey ?? swap.uploadKey,
          id: channel.id,
          roleToken: channel.roleToken,
          role: channel.role,
          iceServers: channel.iceServers,
          onStatus: onPairStatus,
        });
        const phrase = await pairing.done;
        showPhraseConfirm(pairing, phrase);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        progressFailed(`pairing failed: ${text}`);
        setStatus(`pairing failed: ${text}`);
      }
    })();
  };

  const startDesktopJoin = (): void => {
    const handle = requireSync();
    if (!handle) return;
    const code = validCode();
    if (!code) return;
    beginPairing(startDesktopJoin);
    setVerify("—");
    void (async () => {
      try {
        const profile = activeProfile();
        const url = serverUrl();
        showActiveProfile();
        progress(`joining ${url}…`);
        setStatus(`joining ${url}…`);
        const connection = await pairWithServer({
          url,
          code,
          profile,
          localId: handle.engine.id,
          onSas: (phrase) => {
            setVerify(phrase);
            progress("verification phrase ready");
          },
          onStatus: (text) => {
            setStatus(text);
            progress(text);
          },
        });
        let resolveReady!: () => void;
        let rejected = false;
        const ready = new Promise<void>((resolve) => (resolveReady = resolve));
        const pairing: PendingPairing = {
          done: Promise.resolve(connection.phrase),
          ready,
          accept: () => undefined,
          confirm: () => {
            connection.confirmPhrase();
            handle.attachDevice(connection.peer, {
              kind: "desktop",
              deviceId: connection.info.deviceId,
              deviceName: connection.info.mirror || "desktop",
              requirePhrase: false,
              freshPairing: true,
            });
            resolveReady();
          },
          reject: (reason) => {
            rejected = true;
            connection.rejectPhrase(reason);
            connection.close();
          },
        };
        showPhraseConfirm(pairing, connection.phrase);
        void pairing.ready.then(async () => {
          if (rejected) return;
          progress("binding the mirror folder…");
          await bindDesktopMirror(profile, connection.info.mirror);
          progressDone();
          if (connection.info.relay) {
            // BobSwap channels are single-session signaling: reloading would
            // throw this datachannel away and there is nothing to resume.
            const globals = window as unknown as {
              __bobServer?: unknown;
              __bobAdoptServer?: (connection: ServerConnection) => void;
            };
            if (typeof globals.__bobAdoptServer === "function") globals.__bobAdoptServer(connection);
            else globals.__bobServer = connection;
            setStatus(
              `paired over the relay for this tab session · fingerprint ${connection.info.fingerprint} — ` +
                "keep this tab open; after a reload run `npm run pair -- --relay` again",
            );
            updateLiveStatus();
            return;
          }
          setStatus(`paired · fingerprint ${connection.info.fingerprint} — reloading…`);
          setTimeout(() => location.reload(), 800);
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        progressFailed(`desktop pairing failed: ${text}`);
        setStatus(`desktop pairing failed: ${text}`);
      }
    })();
  };

  el<HTMLButtonElement>("pair-create-code")?.addEventListener("click", () => startRelayOffer());

  el<HTMLButtonElement>("pair-join-code")?.addEventListener("click", () => {
    if (pairSource() === "desktop") startDesktopJoin();
    else startRelayJoin();
  });

  el<HTMLButtonElement>("pair-unpair")?.addEventListener("click", () => {
    getSync()?.unpair();
    setVerify("—");
    setStatus("tab-to-tab pairing disconnected (same-origin tabs keep syncing)");
    updateLiveStatus();
  });
}
