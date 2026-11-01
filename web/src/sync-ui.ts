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
import { pairWithServer } from "./server-link";
import { bindDesktopMirror } from "./profiles";
import { loadStorageServer } from "./settings";
import { toIceServers } from "./sync/transport-webrtc";
import type { SyncHandle } from "./sync";
import type { SyncState } from "./sync/engine";

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
  const activeProfile = (): string => localStorage.getItem("bob:profile") || "default";
  const serverUrl = (): string => {
    const input = el<HTMLInputElement>("pair-server-url");
    // Normalize the saved bridge URL: a stale file:/// or bare host value would
    // otherwise reach fetch() and surface as Firefox's bare NetworkError.
    const fallback = loadStorageServer();
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
    if (input && !input.value) input.value = loadStorageServer();
  };

  // Live status line in the Sync… dialog.
  const updateLiveStatus = (): void => {
    const sync = getSync();
    if (!sync) {
      setText("live-sync-status", "not running here — this tab is not the workspace host");
      return;
    }
    setText("live-sync-status", statusLine(sync.state()));
  };
  open.addEventListener("click", () => {
    updateLiveStatus();
    showActiveProfile();
    updatePairMode();
    fillServerUrl();
    dialog.showModal();
  });
  close?.addEventListener("click", () => dialog.close());
  const sync = getSync();
  sync?.onState(() => updateLiveStatus());
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
  el<HTMLButtonElement>("pair-offer")?.addEventListener("click", () => {
    const handle = requireSync();
    if (!handle) return;
    setVerify("—");
    setStatus("gathering candidates — your pairing blob appears below");
    (el<HTMLTextAreaElement>("pair-input") as HTMLTextAreaElement).value = "";
    const pairing = handle.startManualPairing("offerer", (blob) => {
      const out = el<HTMLTextAreaElement>("pair-output");
      if (out) out.value = blob;
      setStatus("hand this blob to the other device, then paste their answer below and press “finish”");
    });
    manual = pairing;
    pairing.done
      .then((phrase) => {
        setVerify(phrase);
        setStatus("connected — both devices must show the same phrase");
        updateLiveStatus();
      })
      .catch((err) => setStatus(`pairing failed: ${err instanceof Error ? err.message : String(err)}`));
  });

  el<HTMLButtonElement>("pair-join")?.addEventListener("click", () => {
    const handle = requireSync();
    if (!handle) return;
    const offer = (el<HTMLTextAreaElement>("pair-input") as HTMLTextAreaElement)?.value.trim();
    if (!offer) {
      setStatus("paste the other device's offer blob first");
      return;
    }
    setVerify("—");
    setStatus("reading their offer…");
    const pairing = handle.startManualPairing("joiner", (blob) => {
      const out = el<HTMLTextAreaElement>("pair-output");
      if (out) out.value = blob;
      setStatus("send this answer blob back, then wait for the channel to open");
    });
    manual = pairing;
    pairing.accept(offer);
    pairing.done
      .then((phrase) => {
        setVerify(phrase);
        setStatus("connected — both devices must show the same phrase");
        updateLiveStatus();
      })
      .catch((err) => setStatus(`pairing failed: ${err instanceof Error ? err.message : String(err)}`));
  });

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
    manual.accept(answer);
    setStatus("checking the answer…");
  });

  // ── Code pairing: relay (BobSwap) or desktop/server ──────────────────
  el<HTMLInputElement>("pair-source-relay")?.addEventListener("change", () => setPairSource("relay"));
  el<HTMLInputElement>("pair-source-desktop")?.addEventListener("change", () => setPairSource("desktop"));

  const pairRelay = async (handle: SyncHandle, code: string): Promise<void> => {
    const swap = relayService();
    setStatus(`joining via ${swap.baseUrl}…`);
    const joined = await joinSwapChannel(swap, code);
    const phrase = await handle.pairBobSwap({
      baseUrl: swap.baseUrl,
      readKey: swap.readKey ?? swap.uploadKey,
      id: joined.id,
      roleToken: joined.roleToken,
      role: joined.role,
      iceServers: joined.iceServers,
    });
    setVerify(phrase);
    setStatus("connected — both devices must show the same phrase");
    updateLiveStatus();
  };

  const pairDesktop = async (handle: SyncHandle, code: string): Promise<void> => {
    const profile = activeProfile();
    const url = serverUrl();
    showActiveProfile();
    setStatus(`joining ${url}…`);
    const connection = await pairWithServer({
      url,
      code,
      profile,
      localId: handle.engine.id,
      onSas: (phrase) => setVerify(phrase),
      onStatus: (text) => setStatus(text),
    });
    handle.attach(connection.peer);
    await bindDesktopMirror(profile, connection.info.mirror);
    setStatus(`paired · fingerprint ${connection.info.fingerprint} — reloading…`);
    setTimeout(() => location.reload(), 800);
  };

  el<HTMLButtonElement>("pair-create-code")?.addEventListener("click", () => {
    const handle = requireSync();
    if (!handle) return;
    void (async () => {
      try {
        const swap = relayService();
        setStatus(`creating a code via ${swap.baseUrl}…`);
        const channel = await createSwapChannel(swap);
        const created = el<HTMLElement>("pair-created-wrap");
        if (created) created.hidden = false;
        setText("pair-created-code", channel.code);
        setStatus("share the 8-digit code with the other device, then wait");
        const phrase = await handle.pairBobSwap({
          baseUrl: swap.baseUrl,
          readKey: swap.readKey ?? swap.uploadKey,
          id: channel.id,
          roleToken: channel.roleToken,
          role: channel.role,
          iceServers: channel.iceServers,
        });
        setVerify(phrase);
        setStatus("connected — both devices must show the same phrase");
        updateLiveStatus();
      } catch (err) {
        setStatus(`pairing failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  el<HTMLButtonElement>("pair-join-code")?.addEventListener("click", () => {
    const handle = requireSync();
    if (!handle) return;
    const code = pairCode();
    if (!/^\d{4}-?\d{4}$/.test(code)) {
      setStatus("enter the 8-digit pairing code");
      return;
    }
    const source = pairSource();
    setVerify("—");
    void (async () => {
      try {
        if (source === "desktop") await pairDesktop(handle, code);
        else await pairRelay(handle, code);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        setStatus(`${source === "desktop" ? "desktop" : "relay"} pairing failed: ${text}`);
      }
    })();
  });

  el<HTMLButtonElement>("pair-unpair")?.addEventListener("click", () => {
    getSync()?.unpair();
    setVerify("—");
    setStatus("tab-to-tab pairing disconnected (same-origin tabs keep syncing)");
    updateLiveStatus();
  });
}
