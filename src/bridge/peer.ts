/**
 * The server side of the unified peer model.
 *
 * A desktop/server session waits in a BobSwap-shaped mailbox channel as the
 * `answerer`; the browser joins with the code, creates the data channel, and
 * both sides verify the DTLS SAS. The operator approves capabilities in
 * `npm run pair`; the server mints a per-profile client key and pins a
 * per-profile server proof key. After that the session runs the same
 * `SyncEngine` as a tab, with its journal outside the mirror folder, plus an
 * allowlisted exec surface.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { config } from "../config.js";
import { transcribeAudioBytes } from "../stt.js";
import { SyncEngine, type SyncEnvelope, type SyncPeer, type SyncState } from "../../web/src/sync/engine.js";
import { buildHashmap, type Hashmap } from "../../web/src/sync/hashmap.js";
import { chunkedPeer } from "../../web/src/sync/chunking.js";
import { controlEnvelope } from "../../web/src/sync/control-peer.js";
import { ProfileLink } from "../../web/src/sync/profile-link.js";
import { pairingPhrase } from "../../web/src/sync/sas.js";
import {
  autoLinkProfiles,
  effectiveAllow,
  type ProfileCatalogEntry,
  type ProfilePreview,
} from "../../web/src/profile-sync-model.js";
import { applyDatabaseDumps, isDatabaseDumpPath } from "../../web/src/db-sync.js";
import { createNodePlatform } from "../platform/node.js";
import { ShellTools } from "../tools/shell.js";
import { Mailbox, type MailboxChannel, type SignalEntry } from "./mailbox.js";
import { expandLocalCandidate, expandLocalSdp, localMdnsHosts } from "./mdns.js";
import {
  createRelayChannel,
  RelayTransport,
  type OpenedPeer,
  type PeerEvent,
  type PeerTransport,
  type SyncRelayOptions,
} from "./relay.js";
import { appendPeerLog, handshakePeerLog } from "./peer-log.js";
import {
  defaultMirrorDir,
  peerJournalDir,
  readPeers,
  removePeer,
  sameSecret,
  savePeer,
  secretFingerprint,
  serverKey,
  type PeerCapabilities,
  type PeerRecord,
} from "./store.js";
import {
  bridgeCatalog,
  bridgeConsent,
  bridgeDeviceId,
  clearBridgeProfileConsent,
  ensureBridgeProfile,
  listBridgeProfiles,
  relinkBridgeProfile,
  setBridgeProfileConsent,
  type BridgeProfile,
} from "./profiles.js";

export interface PairingEvent {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}

export interface PairingInfo {
  id: string;
  profile: string;
  channelId: string;
  code: string;
  capabilities: PeerCapabilities;
}

export interface PairingSessionView {
  info: PairingInfo;
  events: PairingEvent[];
  done: boolean;
}

const PROFILE_RE = /^[a-z0-9._-]{1,64}$/;
const OP_TIMEOUT_MS = 10 * 60_000;
const MAX_CHANGED_REPORT = 200;
/** A recorded clip, base64 expanded on the wire; generous but still bounded. */
const MAX_STT_BYTES = 32 * 1024 * 1024;

function hmac(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function channelPeerId(profile: string): string {
  return `server:${profile}`;
}

interface AnswerHandle {
  peer: SyncPeer;
  phrase: string;
  close(): void;
}

/**
 * Attach to a mailbox channel as the answerer. The browser is the offerer
 * (it creates the datachannel); this waits for its offer, answers, and returns
 * a `SyncPeer` wired to the open channel.
 */
function answerChannel(
  mailbox: Mailbox,
  channel: MailboxChannel,
  iceServers: unknown[] = [],
  onEvent?: (type: string, data?: Record<string, unknown>) => void,
): Promise<AnswerHandle> {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({ iceServers: iceServers as never });
    let remoteSet = false;
    let dc: RTCDataChannel | null = null;
    let phrase = "";
    let settled = false;
    const pending: unknown[] = [];
    const mdnsHosts = localMdnsHosts();
    const timer = setTimeout(() => fail(new Error("timed out waiting for the browser's offer")), 600_000);

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      onEvent?.("offer-failed", { error: err.message });
      clearTimeout(timer);
      channel.listeners.delete(listener);
      try { pc.close(); } catch { /* already closed */ }
      reject(err);
    };
    const succeed = (channelDc: RTCDataChannel): void => {
      if (settled) return;
      settled = true;
      onEvent?.("channel-open", {});
      clearTimeout(timer);
      const base: SyncPeer = {
        id: channelPeerId(channel.profile),
        send(envelope: SyncEnvelope): void {
          if (channelDc.readyState !== "open") return;
          channelDc.send(JSON.stringify(envelope));
        },
        connected: () => channelDc.readyState === "open" && pc.connectionState !== "closed",
        onMessage(cb) {
          channelDc.onmessage = (event: unknown) => {
            const raw = (event as { data?: unknown })?.data ?? event;
            const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
            try {
              cb(JSON.parse(text) as SyncEnvelope);
            } catch {
              /* torn frame */
            }
          };
        },
        onClosed(cb) {
          const fire = (): void => cb();
          channelDc.addEventListener("close", fire);
          pc.addEventListener("connectionstatechange", () => {
            if (["failed", "closed", "disconnected"].includes(pc.connectionState)) fire();
          });
        },
        close() {
          try {
            channelDc.close();
          } catch { /* already closed */ }
          try { pc.close(); } catch { /* already closed */ }
          channel.listeners.delete(listener);
        },
      };
      resolve({ peer: chunkedPeer(base), phrase, close: () => base.close() });
    };

    pc.onicecandidate = (event: any) => {
      const candidate = event?.candidate;
      if (!candidate) return;
      const json = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
      mailbox.append(channel, "answerer", "candidates", { candidates: [json] });
    };
    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(pc.connectionState) && !settled) {
        fail(new Error(`connection ${pc.connectionState}`));
      }
    });
    pc.ondatachannel = (event: any) => {
      dc = event.channel as RTCDataChannel;
      const open = (): void => {
        phrase = pairingPhrase(
          pc.localDescription?.sdp ?? "",
          pc.remoteDescription?.sdp ?? "",
        );
        succeed(dc!);
      };
      if (dc.readyState === "open") open();
      else dc.addEventListener("open", open);
    };

    const handle = async (entry: SignalEntry): Promise<void> => {
      if (entry.from === "answerer") return;
      if (entry.type === "candidates") {
        const list = (entry.payload as { candidates?: unknown[] }).candidates;
        if (!Array.isArray(list)) return;
        for (const candidate of list) {
          for (const expanded of expandLocalCandidate(candidate, mdnsHosts)) {
            if (remoteSet) await pc.addIceCandidate(expanded as never).catch(() => undefined);
            else pending.push(expanded);
          }
        }
        return;
      }
      if (entry.type === "offer" && !remoteSet) {
        const sdp = (entry.payload as { sdp?: unknown }).sdp;
        if (typeof sdp !== "string") return fail(new Error("offer without SDP"));
        onEvent?.("offer-received", { bytes: sdp.length });
        await pc.setRemoteDescription({ type: "offer", sdp: expandLocalSdp(sdp, mdnsHosts) }).catch(fail);
        remoteSet = true;
        for (const candidate of pending.splice(0)) {
          await pc.addIceCandidate(candidate as never).catch(() => undefined);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        mailbox.append(channel, "answerer", "answer", {
          sdp: pc.localDescription?.sdp ?? "",
          type: "answer",
        });
        onEvent?.("answer-sent", { bytes: pc.localDescription?.sdp?.length ?? 0 });
      }
    };
    const listener = (entry: SignalEntry): void => {
      void handle(entry).catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
    };
    channel.listeners.add(listener);
    // Signals may have arrived before the session attached (rare).
    void (async () => {
      for (const entry of [...channel.signals]) {
        if (entry.from === "answerer") continue;
        await handle(entry).catch(() => undefined);
      }
    })();
  });
}

interface BridgeRuntime {
  profile: BridgeProfile;
  platform: ReturnType<typeof createNodePlatform>;
  engine: SyncEngine;
  folder: string;
  watcher: FSWatcher | null;
  watchTimer: ReturnType<typeof setTimeout> | null;
  known: Hashmap;
}

/** Local in-memory mailbox transport (same-machine pairing and reconnect). */
class MailboxTransport implements PeerTransport {
  readonly kind = "mailbox" as const;
  readonly id: string;
  readonly profile: string;

  constructor(
    private readonly mailbox: Mailbox,
    private readonly channel: MailboxChannel,
  ) {
    this.id = channel.id;
    this.profile = channel.profile;
  }

  open(iceServers: unknown[], onEvent?: PeerEvent): Promise<OpenedPeer> {
    return answerChannel(this.mailbox, this.channel, iceServers, onEvent);
  }

  signalError(message: string): void {
    this.mailbox.append(this.channel, "answerer", "error", { message });
  }

  close(): void {
    this.mailbox.close(this.channel);
  }
}

export class PeerSession {
  readonly id = randomUUID();
  profile: string;
  /** Profile whose key/fingerprint authenticated this device link. */
  authProfile = "";
  /** Profile (or `*`) whose `pair:<profile>` secret produced the proof key. */
  private proofProfile: string;
  private reconnecting = false;
  readonly capabilities: PeerCapabilities;
  readonly mode: "pairing" | "reconnect";
  readonly events: PairingEvent[] = [];
  done = false;
  private eventSeq = 0;
  private link: SyncPeer | null = null;
  /** Primary profile's engine (ops/log/status keep using this handle). */
  private engine: SyncEngine | null = null;
  private profileLink: ProfileLink | null = null;
  private runtimes = new Map<string, BridgeRuntime>();
  private attached = new Map<string, SyncPeer>();
  private remoteCatalog: ProfileCatalogEntry[] = [];
  private remoteConsent: Record<string, boolean> = {};
  private catalogBusy = false;
  private remoteDeviceId = "";
  private remoteDeviceName = "browser";
  private approval: ((ok: boolean) => void) | null = null;
  private sas = "";
  private closed = false;
  private busy = false;
  private paired = false;
  private helloResolve: (() => void) | null = null;
  private helloPromise = new Promise<void>((resolve) => {
    this.helloResolve = resolve;
  });
  private closedResolve: (() => void) | null = null;
  private closedPromise = new Promise<void>((resolve) => {
    this.closedResolve = resolve;
  });

  constructor(
    private readonly transport: PeerTransport,
    mode: "pairing" | "reconnect",
    capabilities: PeerCapabilities,
    private iceServers: unknown[] = [],
    private onReady?: (session: PeerSession) => void,
    private onClosed?: (session: PeerSession) => void,
  ) {
    this.mode = mode;
    this.profile = transport.profile;
    this.proofProfile = transport.profile;
    this.capabilities = capabilities;
  }

  /** The server proof key a record was paired with (wildcard-aware). */
  private async proofKeyFor(record: PeerRecord): Promise<string> {
    const key = await serverKey();
    for (const candidate of new Set(
      [record.proofProfile, record.profile, "*"].filter((value): value is string => !!value),
    )) {
      const proof = hmac(key, `pair:${candidate}`);
      if (secretFingerprint(proof) === record.fingerprint) {
        this.proofProfile = candidate;
        return proof;
      }
    }
    this.proofProfile = record.proofProfile ?? record.profile;
    return hmac(key, `pair:${this.proofProfile}`);
  }

  private emit(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ seq: this.eventSeq++, at: new Date().toISOString(), type, data });
  }

  info(code: string): PairingInfo {
    return {
      id: this.id,
      profile: this.profile,
      channelId: this.transport.id,
      code,
      capabilities: { ...this.capabilities, mirrorPath: undefined },
    };
  }

  approve(ok: boolean): void {
    if (!this.approval) {
      this.emit("error", { message: "the pairing session is not awaiting approval yet" });
      return;
    }
    this.approval(ok);
    this.approval = null;
  }

  /**
   * Send the control/error frame, then give the browser's signal poll a
   * moment to read it before the channel disappears. Closing synchronously
   * races the error and surfaces as a bare `signal poll: HTTP 404` in the tab.
   */
  private closeSoon(delayMs = 1_500): void {
    setTimeout(() => this.dispose(), delayMs).unref?.();
  }

  async start(): Promise<void> {
    try {
      this.emit("waiting-offer", {
        profile: this.profile,
        mirror: this.capabilities.mirror,
        exec: this.capabilities.exec,
      });
      const answer = await this.transport.open(
        this.iceServers,
        (type, data) => this.emit(type, data ?? {}),
      );
      if (this.closed) {
        answer.close();
        return;
      }
      this.sas = answer.phrase;
      const link = answer.peer;
      this.link = link;
      link.onMessage((envelope) => {
        if (envelope.kind !== "control") return;
        void this.onControl(envelope.control ?? {}, link);
      });
      link.onClosed(() => this.onLinkClosed());
      this.emit("connected", { sas: this.sas });
      const reconnectRecord =
        this.mode === "reconnect"
          ? (await readPeers()).peers[this.authProfile || this.profile]
          : null;
      const proofKey =
        this.mode === "reconnect" && reconnectRecord
          ? await this.proofKeyFor(reconnectRecord)
          : hmac(await serverKey(), `pair:${this.proofProfile}`);
      const nonce = randomBytes(16).toString("hex");
      link.send(
        controlEnvelope(channelPeerId(this.profile), {
          op: "server",
          v: 1,
          profile: this.profile,
          fingerprint: secretFingerprint(proofKey),
          pairing: this.mode === "pairing",
          capabilities: { mirror: this.capabilities.mirror, exec: this.capabilities.exec },
          nonce,
        }),
      );
      this.emit("server-frame", { profile: this.profile, pairing: this.mode === "pairing" });
      if (this.mode === "pairing") {
        // The tab must identify its profile before anyone is asked to approve.
        // Otherwise a quick `--yes` (or a fast operator) can approve while the
        // hello is still in flight, minting a key for a profile mismatch.
        await Promise.race([
          this.helloPromise,
          this.closedPromise,
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("the browser did not send its profile")),
              2 * 60_000,
            ).unref?.(),
          ),
        ]);
        if (this.closed) return;
        const approval = new Promise<boolean>((resolve) => {
          this.approval = resolve;
          setTimeout(() => resolve(false), 5 * 60_000).unref?.();
        });
        this.emit("awaiting-approval", { sas: this.sas, capabilities: this.capabilities });
        const ok = await approval;
        if (this.closed) return;
        if (!ok) {
          link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message: "pairing denied" }));
          this.emit("denied", {});
          this.closeSoon();
          return;
        }
        const clientKey = randomBytes(32).toString("hex");
        const record: PeerRecord = {
          profile: this.profile,
          keyHash: createHash("sha256").update(clientKey).digest("hex"),
          capabilities: this.capabilities,
          pairedAt: new Date().toISOString(),
          fingerprint: secretFingerprint(proofKey),
          proofProfile: this.proofProfile,
        };
        await savePeer(record);
        // If the folder already holds a workspace, the first pairing replaces
        // the tab's copy instead of pushing a stale seed over it.
        const folder = this.capabilities.mirrorPath ?? defaultMirrorDir(this.capabilities.mirror ?? this.profile);
        await fs.mkdir(folder, { recursive: true });
        const existing = await buildHashmap(createNodePlatform(folder, this.capabilities.exec), folder);
        link.send(
          controlEnvelope(channelPeerId(this.profile), {
            op: "paired",
            v: 1,
            deviceId: await bridgeDeviceId(),
            clientKey,
            serverKey: proofKey,
            fingerprint: record.fingerprint,
            bootstrap: Object.keys(existing).length,
            transport: this.transport.kind,
            capabilities: { mirror: this.capabilities.mirror, exec: this.capabilities.exec },
          }),
        );
        this.paired = true;
        this.authed = true;
        this.emit("paired", { profile: this.profile, fingerprint: record.fingerprint });
      } else {
        if (!reconnectRecord) {
          link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message: "unknown profile" }));
          this.dispose();
          return;
        }
        this.authProfile = reconnectRecord.profile;
        this.pendingNonce = nonce;
        this.pendingProofKey = proofKey;
        this.emit("resume-requested", { profile: this.profile });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", { message });
      if (this.link) {
        try {
          this.link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message }));
        } catch {
          /* the datachannel is already going away */
        }
      } else {
        // No control link yet: leave an error in the signal feed so the
        // browser's offer/answer wait fails with this message, not a 404.
        this.transport.signalError(message);
      }
      this.closeSoon(this.link ? 1_500 : 3_000);
    }
  }

  /**
   * A relay pairing keeps its signaling channel for 30 minutes. When the
   * datachannel drops (profile switch, reload, network loss), wait for the
   * browser's reconnect request on that channel instead of tearing the device
   * link down. Direct-mailbox links still reconnect through their own channel.
   */
  private onLinkClosed(): void {
    this.emit("link-closed", { paired: this.paired });
    this.link = null;
    this.authed = false;
    const relay = this.transport.kind === "relay" && this.paired;
    if (relay) this.reconnecting = true;
    // Drop the old catalog/file link without disposing the session; a relay
    // reconnect reattaches a fresh ProfileLink below.
    this.profileLink?.close();
    this.profileLink = null;
    for (const id of [...this.attached.keys()]) this.detachProfile(id);
    this.attached.clear();
    if (this.closed) return;
    if (relay) {
      void this.reconnectRelay();
      return;
    }
    if (this.mode === "pairing" && !this.paired) {
      this.emit("error", { message: "the browser disconnected before pairing finished" });
    }
    this.dispose();
  }

  private async reconnectRelay(): Promise<void> {
    try {
      const answer = await (this.transport as RelayTransport).waitForReconnect();
      if (this.closed) {
        answer.close();
        return;
      }
      const requested = answer.profile;
      if (requested && requested !== this.profile) {
        if (!PROFILE_RE.test(requested)) {
          throw new Error(`invalid browser profile name: ${JSON.stringify(requested)}`);
        }
        this.profile = requested;
        // The first pairing's --mirror applies to its first profile; a profile
        // the tab switched to defaults to its own name.
        this.capabilities.mirror = requested;
        await ensureBridgeProfile(requested).catch(() => undefined);
      }
      this.sas = answer.phrase;
      const link = answer.peer;
      this.link = link;
      link.onMessage((envelope) => {
        if (envelope.kind !== "control") return;
        void this.onControl(envelope.control ?? {}, link);
      });
      link.onClosed(() => this.onLinkClosed());
      this.emit("connected", { sas: this.sas });
      const proofKey = hmac(await serverKey(), `pair:${this.proofProfile}`);
      const nonce = randomBytes(16).toString("hex");
      this.pendingNonce = nonce;
      this.pendingProofKey = proofKey;
      link.send(
        controlEnvelope(channelPeerId(this.profile), {
          op: "server",
          v: 1,
          deviceId: await bridgeDeviceId(),
          profile: this.profile,
          fingerprint: secretFingerprint(proofKey),
          pairing: false,
          capabilities: { mirror: this.capabilities.mirror, exec: this.capabilities.exec },
          nonce,
        }),
      );
      this.emit("server-frame", { profile: this.profile, pairing: false, relay: true });
      this.emit("resume-requested", { profile: this.profile });
    } catch (err) {
      this.emit("error", { message: err instanceof Error ? err.message : String(err) });
      this.dispose();
    }
  }

  private pendingNonce = "";
  private pendingProofKey = "";
  private pendingClientNonce = "";
  /** The peer proved its client key on this connection (or finished pairing). */
  private authed = false;

  /**
   * Log-stream access needs a proven peer: during first pairing the data
   * channel is open before the operator approves, and pairing codes are
   * short-lived but not secrets we want writing rows.
   */
  private logAuthed(): boolean {
    return this.authed;
  }

  private async onControl(control: Record<string, unknown>, link: SyncPeer): Promise<void> {
    const op = String(control.op ?? "");
    this.emit("control", {
      op,
      ...(op === "hello" ? { profile: String(control.profile ?? "") } : {}),
    });
    const expectedProfile = this.profile;
    if (op === "hello") {
      const got = String(control.profile ?? "");
      if (expectedProfile !== "*" && got !== expectedProfile) {
        const message =
          `this code is for browser profile "${expectedProfile}", but this tab is "${got}" — ` +
          `rerun \`npm run pair -- --profile ${got}\``;
        this.emit("error", { message });
        link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message }));
        this.closeSoon();
        return;
      }
      if (expectedProfile === "*") {
        if (!PROFILE_RE.test(got)) {
          const message = `invalid browser profile name: ${JSON.stringify(got)}`;
          this.emit("error", { message });
          link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message }));
          this.closeSoon();
          return;
        }
        this.profile = got;
        if (!this.capabilities.mirror) this.capabilities.mirror = got;
      }
      this.emit("joined", { profile: this.profile, sas: this.sas });
      if (this.mode === "pairing") this.emit("sas", { sas: this.sas });
      this.helloResolve?.();
      return;
    }
    if (op === "resume") {
      if (this.mode !== "reconnect" && !this.reconnecting) {
        link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message: "pairing required" }));
        return;
      }
      if (control.profile !== expectedProfile) return;
      const records = (await readPeers()).peers;
      const record =
        records[this.profile] ??
        Object.values(records).find((entry) =>
          sameSecret(String(control.proof ?? ""), hmac(entry.keyHash, this.pendingNonce)),
        );
      if (!record) return;
      const proof = String(control.proof ?? "");
      if (!sameSecret(proof, hmac(record.keyHash, this.pendingNonce))) {
        this.emit("error", { message: "client key rejected" });
        link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message: "client key rejected" }));
        this.closeSoon();
        return;
      }
      this.emit("sas", { sas: this.sas });
      this.authProfile = record.profile;
      this.paired = true;
      this.reconnecting = false;
      this.authed = true;
      this.pendingClientNonce = String(control.clientNonce ?? randomBytes(16).toString("hex"));
      link.send(
        controlEnvelope(channelPeerId(this.profile), {
          op: "resumed",
          v: 1,
          deviceId: await bridgeDeviceId(),
          proof: hmac(this.pendingProofKey, this.pendingClientNonce),
          capabilities: { mirror: this.capabilities.mirror, exec: this.capabilities.exec },
        }),
      );
      return;
    }
    if (op === "ready") {
      if (this.profileLink) return;
      await this.attachProfileLink();
      return;
    }
    if (op === "ops-run" || op === "stt-run") {
      if (!this.authed) {
        link.send(
          controlEnvelope(channelPeerId(this.profile), {
            op: op === "ops-run" ? "ops-result" : "stt-result",
            id: String(control.id ?? ""),
            error: "pairing is not complete",
          }),
        );
        return;
      }
    }
    if (op === "log-handshake" || op === "log-batch") {
      // The control channel exists during pairing too; only a proven peer may
      // write the desktop log copy.
      if (!this.logAuthed()) {
        link.send(
          controlEnvelope(channelPeerId(this.profile), {
            op: "log-error",
            error: "log stream requires a paired session",
          }),
        );
        return;
      }
    }
    if (op === "log-handshake") {
      // The tab's run log lives only in its OPFS workspace (logs/ is excluded
      // from file sync and db-sync); this control stream is how the desktop
      // gets the rows. The cursor acknowledges what this profile already has.
      try {
        const status = await handshakePeerLog(this.profile, {
          epoch: String(control.epoch ?? ""),
          // Absent means the tab could not read its max; do not treat unknown
          // as 0, or a transient failure would wipe the desktop copy.
          max:
            typeof control.max === "number" && Number.isFinite(control.max)
              ? control.max
              : undefined,
        });
        this.emit("log-stream", { epoch: status.epoch, cursor: status.cursor, rows: status.total });
        link.send(
          controlEnvelope(channelPeerId(this.profile), {
            op: "log-cursor",
            epoch: status.epoch,
            cursor: status.cursor,
          }),
        );
      } catch (err) {
        link.send(
          controlEnvelope(channelPeerId(this.profile), {
            op: "log-error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }
    if (op === "log-batch") {
      try {
        const result = await appendPeerLog(
          this.profile,
          String(control.epoch ?? ""),
          Array.isArray(control.events) ? control.events : [],
        );
        if (result.error) {
          link.send(controlEnvelope(channelPeerId(this.profile), { op: "log-error", error: result.error }));
          return;
        }
        if (result.inserted > 0) {
          this.emit("log-rows", { inserted: result.inserted, cursor: result.cursor, rows: result.total });
        }
        link.send(
          controlEnvelope(channelPeerId(this.profile), {
            op: "log-ack",
            upTo: result.cursor,
            inserted: result.inserted,
          }),
        );
      } catch (err) {
        link.send(
          controlEnvelope(channelPeerId(this.profile), {
            op: "log-error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }
    if (op === "ops-run") {
      void this.runOp(control, link);
    }
    if (op === "stt-run") {
      void this.runStt(control, link);
    }
  }

  /**
   * Turn the authenticated connection into a multiplexed profile link. The
   * catalog goes out first; consent then decides which desktop mirror folders
   * get an engine. The primary profile's engine keeps the ops/log surface.
   */
  private async attachProfileLink(): Promise<void> {
    if (!this.link || this.profileLink) return;
    const deviceId = await bridgeDeviceId();
    const localCatalog = await bridgeCatalog();
    const primary = localCatalog.find((entry) => entry.name === this.profile) ?? localCatalog[0];
    const link = new ProfileLink(this.link, {
      deviceId,
      deviceName: "desktop/server",
      catalog: localCatalog,
      consent: await bridgeConsent(this.remoteDeviceId || "pending"),
      defaultProfileId: primary?.id,
      peerId: channelPeerId(this.profile),
      // Auth is complete (pairing approval or the resume proof); the browser
      // still gates its own catalog on the explicit phrase button.
      requirePhrase: false,
      onCatalog: (catalog, remoteId, remoteName) => {
        void this.onRemoteCatalog(catalog, remoteId, remoteName);
      },
      onConsent: (consent) => {
        void this.onRemoteConsent(consent);
      },
      onReady: () => {
        void this.applyConsent();
      },
      onPreviewRequest: (profileId) => this.previewProfile(profileId),
      onControl: (control) => {
        if (this.link) void this.onControl(control, this.link);
      },
      // Closing the old catalog link is part of a relay reconnect; keep the
      // session alive until the replacement link proves the client key.
      onClosed: () => {
        if (!this.reconnecting) this.dispose();
      },
    });
    this.profileLink = link;
    link.start();
  }

  private async onRemoteCatalog(
    catalog: ProfileCatalogEntry[],
    remoteDeviceId: string,
    remoteDeviceName: string,
  ): Promise<void> {
    this.remoteCatalog = catalog;
    this.remoteDeviceId = remoteDeviceId;
    this.remoteDeviceName = remoteDeviceName;
    this.catalogBusy = true;
    try {
      const local = await bridgeCatalog();
      const links = autoLinkProfiles(local, catalog, { linkedNames: [], unlinkedIds: [] });
      for (const link of links) {
        if (!link.adoptLocal) continue;
        await relinkBridgeProfile(link.adoptLocal.from, link.adoptLocal.to).catch(() => undefined);
      }
      if (links.some((link) => link.adoptLocal)) {
        this.profileLink?.setCatalog(await bridgeCatalog());
      }
      this.profileLink?.setConsent(await bridgeConsent(remoteDeviceId));
    } finally {
      this.catalogBusy = false;
    }
    await this.applyConsent();
  }

  private async onRemoteConsent(consent: Record<string, boolean>): Promise<void> {
    this.remoteConsent = { ...consent };
    // A catalog auto-link is in flight; its completion re-applies consent with
    // the canonical ids.
    if (this.catalogBusy) return;
    await this.applyConsent();
  }

  /**
   * Create local mirrors for browser-only profiles the browser has allowed,
   * then attach exactly the intersection of both consent maps.
   */
  private async applyConsent(): Promise<void> {
    if (!this.profileLink || !this.remoteDeviceId) return;
    for (const entry of this.remoteCatalog) {
      const id = entry.id.toLowerCase();
      if (this.remoteConsent[id] !== true) continue;
      const existing = await this.runtimeForId(id);
      if (existing) continue;
      await ensureBridgeProfile(entry.name, {
        id,
        createdAt: entry.createdAt,
      }).catch(() => undefined);
    }
    const profiles = await listBridgeProfiles();
    const localAllow = await bridgeConsent(this.remoteDeviceId);
    for (const profile of profiles) {
      const id = profile.id.toLowerCase();
      const allowed = effectiveAllow(
        { [id]: localAllow[id] ?? true },
        this.remoteConsent,
        id,
      );
      if (allowed) {
        await this.attachProfile(profile);
      } else {
        this.detachProfile(id);
      }
    }
    this.profileLink.setConsent(localAllow);
    this.emit("catalog", {
      device: this.remoteDeviceId,
      profiles: profiles.map((profile) => ({ id: profile.id, name: profile.name })),
    });
  }

  private async runtimeForId(id: string): Promise<BridgeRuntime | null> {
    const existing = this.runtimes.get(id.toLowerCase());
    if (existing) return existing;
    const profile = (await listBridgeProfiles()).find((entry) => entry.id === id.toLowerCase());
    if (!profile) return null;
    return this.createRuntime(profile);
  }

  private async runtimeForName(name: string): Promise<BridgeRuntime | null> {
    const profile = (await listBridgeProfiles()).find((entry) => entry.name === name);
    if (!profile) return null;
    return this.runtimes.get(profile.id) ?? this.createRuntime(profile);
  }

  private createRuntime(profile: BridgeProfile): BridgeRuntime {
    const folder =
      profile.name === this.profile && this.capabilities.mirrorPath
        ? this.capabilities.mirrorPath
        : profile.folder;
    const platform = createNodePlatform(folder, this.capabilities.exec);
    const engine = new SyncEngine(platform, channelPeerId(profile.name), {
      journalRoot: peerJournalDir(profile.name),
      onApplied: (paths, previous) => {
        if (!paths.some(isDatabaseDumpPath)) return undefined;
        const baseline: Record<string, string> = {};
        for (const [path, hash] of Object.entries(previous)) {
          if (isDatabaseDumpPath(path)) baseline[path.slice("db/".length, -".sql".length)] = hash;
        }
        return applyDatabaseDumps(platform, { applyClean: true, previous: baseline }).then(
          () => undefined,
        );
      },
    });
    const runtime: BridgeRuntime = {
      profile: { ...profile, folder },
      platform,
      engine,
      folder,
      watcher: null,
      watchTimer: null,
      known: {},
    };
    this.runtimes.set(profile.id, runtime);
    engine.onState((state: SyncState) =>
      this.emit("sync", { profile: profile.name, status: state.status, detail: state.detail }),
    );
    if (profile.name === this.profile) this.engine = engine;
    void this.startRuntime(runtime);
    return runtime;
  }

  private async startRuntime(runtime: BridgeRuntime): Promise<void> {
    await fs.mkdir(runtime.folder, { recursive: true });
    runtime.known = await buildHashmap(runtime.platform, runtime.platform.workspaceRoot);
    await applyDatabaseDumps(runtime.platform).catch(() => undefined);
    runtime.watchTimer = setTimeout(() => void this.scanExternal(runtime), 800);
    try {
      runtime.watcher = watch(runtime.folder, { recursive: true }, () => {
        if (runtime.watchTimer) return;
        runtime.watchTimer = setTimeout(() => {
          runtime.watchTimer = null;
          void this.scanExternal(runtime);
        }, 500);
      });
      runtime.watcher.on("error", () => undefined);
    } catch {
      /* coarse/exhausted watcher: ops and reconciles still converge */
    }
    this.onReady?.(this);
    this.emit("ready", {
      profile: runtime.profile.name,
      mirror: runtime.profile.name,
    });
  }

  private async attachProfile(profile: BridgeProfile): Promise<void> {
    const id = profile.id.toLowerCase();
    if (!this.profileLink || this.attached.has(id)) return;
    const runtime = this.runtimes.get(id) ?? this.createRuntime(profile);
    const virtual = this.profileLink.peerFor(id);
    this.attached.set(id, virtual);
    runtime.engine.attach(virtual);
  }

  private detachProfile(id: string): void {
    const virtual = this.attached.get(id.toLowerCase());
    if (!virtual) return;
    this.attached.delete(id.toLowerCase());
    virtual.close();
  }

  private async scanExternal(runtime: BridgeRuntime): Promise<void> {
    runtime.watchTimer = null;
    const current = await buildHashmap(runtime.platform, runtime.platform.workspaceRoot).catch(
      () => null,
    );
    if (!current) return;
    const changed: string[] = [];
    for (const [p, entry] of Object.entries(current)) {
      if (runtime.known[p]?.hash !== entry.hash) changed.push(p);
    }
    for (const p of Object.keys(runtime.known)) {
      if (!(p in current)) changed.push(p);
    }
    runtime.known = current;
    if (changed.length) {
      await runtime.engine.noteMutation([...new Set(changed)]).catch(() => undefined);
    }
  }

  private async previewProfile(profileId: string): Promise<ProfilePreview | null> {
    const id = profileId.toLowerCase();
    if (!this.remoteDeviceId || this.remoteConsent[id] !== true) return null;
    const runtime = await this.runtimeForId(id);
    if (!runtime) return null;
    const map = await buildHashmap(runtime.platform, runtime.platform.workspaceRoot);
    return {
      id,
      files: Object.keys(map).length,
      bytes: Object.values(map).reduce((sum, entry) => sum + entry.bytes, 0),
      updatedAt: runtime.profile.createdAt,
    };
  }

  /**
   * Transcribe a browser recording on the desktop. A phone paired over WebRTC
   * cannot reach the loopback `/stt` bridge, so voice input travels here like
   * any other channel op. The same opt-in gate (`BOB_STT=1`) applies.
   */
  private async runStt(control: Record<string, unknown>, link: SyncPeer): Promise<void> {
    const id = String(control.id ?? randomUUID());
    const reply = (body: Record<string, unknown>): void =>
      link.send(controlEnvelope(channelPeerId(this.profile), { op: "stt-result", id, ...body }));
    if (process.env.BOB_STT !== "1") {
      reply({ error: "transcription is off — start the channel with BOB_STT=1" });
      return;
    }
    const encoded = typeof control.audio === "string" ? control.audio : "";
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length) {
      reply({ error: "no audio was sent" });
      return;
    }
    if (bytes.length > MAX_STT_BYTES) {
      reply({ error: `audio is too large (${Math.round(bytes.length / 1024 / 1024)} MB)` });
      return;
    }
    const rawExt = String(control.ext ?? ".webm").toLowerCase();
    const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : ".webm";
    try {
      await fs.mkdir(config.tmpDir, { recursive: true });
      const text = await transcribeAudioBytes(bytes, {
        ext,
        backend: config.sttBackend,
        whisperUrl: config.whisperUrl,
        sherpaUrl: config.sherpaUrl,
        tmpDir: config.tmpDir,
        language: config.sttLanguage || undefined,
      });
      reply({ text });
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async runOp(control: Record<string, unknown>, link: SyncPeer): Promise<void> {
    const id = String(control.id ?? randomUUID());
    if (this.busy) {
      link.send(controlEnvelope(channelPeerId(this.profile), { op: "ops-result", id, error: "an op is already running" }));
      return;
    }
    const binary = String(control.binary ?? "");
    const args = Array.isArray(control.args) ? control.args.map(String) : [];
    if (!this.capabilities.exec.includes(path.basename(binary)) || path.basename(binary) !== binary) {
      link.send(
        controlEnvelope(channelPeerId(this.profile), {
          op: "ops-result",
          id,
          error: `command not allowed: ${binary}. Allowlist: ${this.capabilities.exec.join(", ")}`,
        }),
      );
      return;
    }
    const runtime = await this.runtimeForName(this.profile);
    const folder =
      runtime?.folder ??
      this.capabilities.mirrorPath ??
      defaultMirrorDir(this.capabilities.mirror ?? this.profile);
    const timeoutMs = Math.min(OP_TIMEOUT_MS, Math.max(1_000, Number(control.timeoutMs ?? OP_TIMEOUT_MS)));
    this.busy = true;
    try {
      const virtual = runtime ? this.attached.get(runtime.profile.id) : undefined;
      if (runtime && virtual) {
        await runtime.engine.reconcileAndWait(virtual, 15_000).catch(() => false);
      }
      const platform = runtime?.platform ?? createNodePlatform(folder, this.capabilities.exec);
      const before = await buildHashmap(platform, folder);
      const shell = new ShellTools(folder, this.capabilities.exec, { timeoutMs, maxOutput: 256 * 1024 });
      let output = "";
      let error: string | undefined;
      try {
        output = await shell.runCommand(binary, args);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      // Let the watcher settle, then compute exactly what the command wrote.
      await new Promise((r) => setTimeout(r, 350));
      const after = await buildHashmap(platform, folder);
      const changed: string[] = [];
      for (const [p, entry] of Object.entries(after)) {
        if (before[p]?.hash !== entry.hash) changed.push(p);
      }
      for (const p of Object.keys(before)) if (!(p in after)) changed.push(p);
      if (runtime) runtime.known = after;
      if (runtime && virtual && changed.length) {
        await runtime.engine.noteMutation(changed).catch(() => undefined);
        await runtime.engine.reconcileAndWait(virtual, 20_000).catch(() => false);
      }
      link.send(
        controlEnvelope(channelPeerId(this.profile), {
          op: "ops-result",
          id,
          output,
          error,
          changed: changed.slice(0, MAX_CHANGED_REPORT),
          changedCount: changed.length,
        }),
      );
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.done = true;
    this.closedResolve?.();
    for (const runtime of this.runtimes.values()) {
      if (runtime.watchTimer) clearTimeout(runtime.watchTimer);
      runtime.watcher?.close();
      runtime.engine.detach();
    }
    this.runtimes.clear();
    this.attached.clear();
    this.profileLink?.close();
    this.profileLink = null;
    try {
      this.link?.close();
    } catch {
      /* already closed */
    }
    this.link = null;
    this.transport.close();
    this.onClosed?.(this);
  }
}

export class PeerManager {
  private sessions = new Map<string, PeerSession>();
  private liveByProfile = new Map<string, PeerSession>();
  private codes = new Map<string, string>();

  constructor(private mailbox: Mailbox, private iceServers: unknown[] = []) {}

  private register(session: PeerSession, code = ""): void {
    this.sessions.set(session.id, session);
    if (code) this.codes.set(session.id, code);
    session.done = false;
    void session.start();
  }

  /** A session becomes the profile's live writer only after it is ready. */
  private makeLive(session: PeerSession): void {
    const previous = this.liveByProfile.get(session.profile);
    if (previous && previous !== session) previous.dispose();
    // A relay session can resume under the profile the tab switched to; drop
    // its old map entry so two names cannot point at one session.
    for (const [name, live] of this.liveByProfile) {
      if (live === session && name !== session.profile) this.liveByProfile.delete(name);
    }
    this.liveByProfile.set(session.profile, session);
  }

  private capabilitiesFor(
    profile: string,
    capabilities: Partial<PeerCapabilities>,
  ): PeerCapabilities {
    if (profile !== "*" && !PROFILE_RE.test(profile)) throw new Error("invalid profile name");
    // A wildcard pairing takes the browser's active profile from `hello`; the
    // mirror then defaults to that name. An explicit --mirror still wins.
    const mirror = capabilities.mirror ?? (profile === "*" ? undefined : profile);
    if (mirror !== undefined && !PROFILE_RE.test(mirror)) throw new Error("invalid mirror folder name");
    const mirrorPath = capabilities.mirrorPath ? path.resolve(capabilities.mirrorPath) : undefined;
    return {
      mirror,
      mirrorPath,
      exec: Array.isArray(capabilities.exec) ? capabilities.exec.map(String).filter(Boolean) : [],
    };
  }

  async createPairing(profile: string, capabilities: Partial<PeerCapabilities> = {}): Promise<PairingInfo> {
    const caps = this.capabilitiesFor(profile, capabilities);
    const created = this.mailbox.createPairing(profile);
    const transport = new MailboxTransport(this.mailbox, created.channel);
    const session = new PeerSession(
      transport,
      "pairing",
      caps,
      this.iceServers,
      (s) => this.makeLive(s),
      (s) => this.unregister(s),
    );
    this.register(session, created.code);
    created.channel.onJoined = () => undefined;
    return session.info(created.code ?? "");
  }

  /**
   * Pair through a BobSwap sync channel instead of the loopback mailbox.
   * Only SDP/ICE touch the relay; the datachannel still carries every byte.
   */
  async createRelayPairing(
    profile: string,
    capabilities: Partial<PeerCapabilities>,
    relay: SyncRelayOptions,
  ): Promise<PairingInfo> {
    const caps = this.capabilitiesFor(profile, capabilities);
    const channel = await createRelayChannel(relay, profile);
    const transport = new RelayTransport(channel);
    const session = new PeerSession(
      transport,
      "pairing",
      caps,
      channel.iceServers,
      (s) => this.makeLive(s),
      (s) => this.unregister(s),
    );
    this.register(session, channel.code);
    return session.info(channel.code);
  }

  /** A reconnect channel for an already-paired profile (client-key create). */
  createReconnect(profile: string, record: PeerRecord): { session: PeerSession; channelId: string; roleToken: string } {
    // A reconnect replaces the old connection for this profile.
    this.liveByProfile.get(profile)?.dispose();
    const created = this.mailbox.createReconnect(profile);
    // A device link may reconnect under another profile. Keep the proof key
    // from the profile that originally paired, but default the mirror folder
    // to the profile this tab is actually on.
    const caps: PeerCapabilities =
      record.profile === profile
        ? record.capabilities
        : { exec: record.capabilities.exec };
    const transport = new MailboxTransport(this.mailbox, created.channel);
    const session = new PeerSession(
      transport,
      "reconnect",
      caps,
      this.iceServers,
      (s) => this.makeLive(s),
      (s) => this.unregister(s),
    );
    session.authProfile = record.profile;
    this.register(session);
    return { session, channelId: created.channel.id, roleToken: created.clientToken };
  }

  approve(id: string, ok: boolean): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("unknown pairing session");
    if (session.mode !== "pairing") throw new Error("this session is not awaiting approval");
    session.approve(ok);
  }

  view(id: string): PairingSessionView | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      info: session.info(this.codes.get(id) ?? ""),
      events: [...session.events],
      done: session.done,
    };
  }

  async revoke(profile: string): Promise<void> {
    this.liveByProfile.get(profile)?.dispose();
    this.liveByProfile.delete(profile);
    await removePeer(profile);
    // Re-pairing starts from defaults, not a stale per-device veto.
    const entry = (await listBridgeProfiles()).find((item) => item.name === profile);
    if (entry) await clearBridgeProfileConsent(entry.id);
  }

  async peers(): Promise<PeerRecord[]> {
    return Object.values((await readPeers()).peers);
  }

  sessionForProfile(profile: string): PeerSession | null {
    return this.liveByProfile.get(profile) ?? null;
  }

  private unregister(session: PeerSession): void {
    this.codes.delete(session.id);
    if (this.liveByProfile.get(session.profile) === session) this.liveByProfile.delete(session.profile);
    if (session.mode === "pairing") {
      // Keep the finished session's events queryable for a minute. `npm run
      // pair` polls every 700ms; deleting immediately races its next poll and
      // turns the real error into "unknown pairing session".
      setTimeout(() => this.sessions.delete(session.id), 60_000).unref?.();
    } else {
      this.sessions.delete(session.id);
    }
  }
}
