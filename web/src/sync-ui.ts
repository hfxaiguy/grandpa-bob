/**
 * The Live sync pairing UI: manual paste (no service) and BobSwap REST.
 *
 * Same-origin tabs reconcile automatically (BroadcastChannel) — this dialog
 * exists for CROSS-DEVICE pairs. Manual pairing is the no-service path: one
 * blob per direction, exchanged by any means (a Telegram message works).
 * BobSwap pairing is automatic: the service implements the sync channel
 * endpoints (`/api/v1/sync/channels…`), pairing codes are single-use, and the
 * signaling mailbox carries SDP/ICE only. The create/join responses supply the
 * ICE servers the peer connection uses (STUN, plus TURN when configured).
 */
import { activeSwapService, type SwapService } from "./swap";
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

/** Create a sync channel on a BobSwap service (offerer side). */
async function createSwapChannel(service: SwapService): Promise<{
  id: string;
  code: string;
  roleToken: string;
  iceServers: RTCIceServer[];
}> {
  const base = service.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/v1/sync/channels`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(service.readKey ? { authorization: `Bearer ${service.readKey}` } : {}),
    },
    body: "{}",
  });
  const data = (await res.json().catch(() => ({}))) as {
    channel_id?: string;
    pairing_code?: string;
    role_token?: string;
    ice_servers?: unknown;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `service said HTTP ${res.status} (sync channels may not be deployed yet)`);
  if (!data.channel_id || !data.pairing_code || !data.role_token) {
    throw new Error("the service answered without a channel, pairing code or role token");
  }
  return {
    id: data.channel_id,
    code: data.pairing_code,
    roleToken: data.role_token,
    iceServers: toIceServers(data.ice_servers),
  };
}

/** Join an existing sync channel (answerer side). */
async function joinSwapChannel(
  service: SwapService,
  id: string,
  code: string,
): Promise<{ roleToken: string; iceServers: RTCIceServer[] }> {
  const base = service.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/v1/sync/channels/${encodeURIComponent(id)}/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(service.readKey ? { authorization: `Bearer ${service.readKey}` } : {}),
    },
    body: JSON.stringify({ code }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    role_token?: string;
    ice_servers?: unknown;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `join failed: HTTP ${res.status}`);
  if (!data.role_token) throw new Error("the service answered without a role token");
  return { roleToken: data.role_token, iceServers: toIceServers(data.ice_servers) };
}

export function wireSyncUi(getSync: SyncGetter): void {
  const dialog = el<HTMLDialogElement>("pair-dialog");
  const open = el<HTMLButtonElement>("live-pair");
  const close = el<HTMLButtonElement>("pair-close");
  if (!dialog || !open) return;

  let manual: { accept: (blob: string) => void; done: Promise<string> } | null = null;

  const setStatus = (text: string): void => setText("pair-status", text);
  const setVerify = (phrase: string): void => setText("pair-verify", phrase);
  const setServerStatus = (text: string): void => setText("pair-server-status", text);
  const activeProfile = (): string => localStorage.getItem("bob:profile") || "default";
  const serverUrl = (): string => {
    const input = el<HTMLInputElement>("pair-server-url");
    // Normalize the saved bridge URL: a stale file:/// or bare host value would
    // otherwise reach fetch() and surface as Firefox's bare NetworkError.
    const fallback = loadStorageServer();
    if (input && !input.value) input.value = fallback;
    return input?.value.trim() || fallback;
  };
  const serverChannel = (): string => el<HTMLInputElement>("pair-server-channel")?.value.trim() ?? "";
  const serverCode = (): string => el<HTMLInputElement>("pair-server-code")?.value.trim() ?? "";
  const showActiveProfile = (): void => setText("pair-server-profile", activeProfile());

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
    const input = el<HTMLInputElement>("pair-server-url");
    if (input && !input.value) input.value = loadStorageServer();
    dialog.showModal();
  });
  close?.addEventListener("click", () => dialog.close());
  const sync = getSync();
  sync?.onState(() => updateLiveStatus());
  updateLiveStatus();
  showActiveProfile();

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

  // ── BobSwap REST (automatic) ─────────────────────────────────────────
  const service = (): SwapService => {
    const active = activeSwapService();
    if (!active) throw new Error("configure a BobSwap service first (BobSwap… in the Sync dialog)");
    return active;
  };

  el<HTMLButtonElement>("pair-swap-offer")?.addEventListener("click", () => {
    const handle = requireSync();
    if (!handle) return;
    void (async () => {
      try {
        const swap = service();
        setStatus("creating a sync channel…");
        const channel = await createSwapChannel(swap);
        setText("pair-swap-channel", channel.id);
        setText("pair-swap-code", channel.code);
        setText("pair-swap-box", "");
        setStatus("share the channel id + pairing code with the other device, then wait");
        const phrase = await handle.pairBobSwap({
          baseUrl: swap.baseUrl,
          readKey: swap.readKey,
          id: channel.id,
          roleToken: channel.roleToken,
          role: "offerer",
          iceServers: channel.iceServers,
        });
        setVerify(phrase);
        setStatus("connected — both devices must show the same phrase");
        updateLiveStatus();
      } catch (err) {
        setStatus(`BobSwap pairing failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  el<HTMLButtonElement>("pair-swap-join")?.addEventListener("click", () => {
    const handle = requireSync();
    if (!handle) return;
    void (async () => {
      try {
        const swap = service();
        const id = (el<HTMLInputElement>("pair-swap-channel-input") as HTMLInputElement)?.value.trim();
        const code = (el<HTMLInputElement>("pair-swap-code-input") as HTMLInputElement)?.value.trim();
        if (!id || !code) {
          setStatus("enter the channel id and pairing code");
          return;
        }
        setStatus("joining the channel…");
        const joined = await joinSwapChannel(swap, id, code);
        const phrase = await handle.pairBobSwap({
          baseUrl: swap.baseUrl,
          readKey: swap.readKey,
          id,
          roleToken: joined.roleToken,
          role: "answerer",
          iceServers: joined.iceServers,
        });
        setVerify(phrase);
        setStatus("connected — both devices must show the same phrase");
        updateLiveStatus();
      } catch (err) {
        setStatus(`BobSwap pairing failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  el<HTMLButtonElement>("pair-server-join")?.addEventListener("click", () => {
    const handle = requireSync();
    if (!handle) return;
    void (async () => {
      try {
        const profile = activeProfile();
        const url = serverUrl();
        const channel = serverChannel();
        const code = serverCode();
        if (!channel || !/^\d{4}-?\d{4}$/.test(code)) {
          setServerStatus("enter the channel id and the 8-digit code from npm run pair");
          return;
        }
        showActiveProfile();
        setServerStatus(`joining ${url}…`);
        const connection = await pairWithServer({
          url,
          channelId: channel,
          code,
          profile,
          localId: handle.engine.id,
          onSas: (phrase) => setVerify(phrase),
          onStatus: (text) => {
            setServerStatus(text);
            setStatus(text);
          },
        });
        handle.attach(connection.peer);
        await bindDesktopMirror(profile, connection.info.mirror);
        setServerStatus(`paired · fingerprint ${connection.info.fingerprint}`);
        setStatus("paired — reloading…");
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        setServerStatus(`pairing failed: ${text}`);
        setStatus(`server pairing failed: ${text}`);
      }
    })();
  });

  el<HTMLButtonElement>("pair-unpair")?.addEventListener("click", () => {
    getSync()?.unpair();
    setVerify("—");
    setStatus("cross-device pairing closed (same-origin tabs keep syncing)");
    updateLiveStatus();
  });
}
