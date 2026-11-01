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
import { SyncEngine, type SyncEnvelope, type SyncPeer, type SyncState } from "../../web/src/sync/engine.js";
import { buildHashmap, type Hashmap } from "../../web/src/sync/hashmap.js";
import { chunkedPeer } from "../../web/src/sync/chunking.js";
import { controlEnvelope, controlPeer } from "../../web/src/sync/control-peer.js";
import { pairingPhrase } from "../../web/src/sync/sas.js";
import { createNodePlatform } from "../platform/node.js";
import { ShellTools } from "../tools/shell.js";
import { Mailbox, type MailboxChannel, type SignalEntry } from "./mailbox.js";
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
): Promise<AnswerHandle> {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({ iceServers: iceServers as never });
    let remoteSet = false;
    let dc: RTCDataChannel | null = null;
    let phrase = "";
    let settled = false;
    const pending: unknown[] = [];
    const timer = setTimeout(() => fail(new Error("timed out waiting for the browser's offer")), 600_000);

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.listeners.delete(listener);
      try { pc.close(); } catch { /* already closed */ }
      reject(err);
    };
    const succeed = (channelDc: RTCDataChannel): void => {
      if (settled) return;
      settled = true;
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
          if (remoteSet) await pc.addIceCandidate(candidate as never).catch(() => undefined);
          else pending.push(candidate);
        }
        return;
      }
      if (entry.type === "offer" && !remoteSet) {
        const sdp = (entry.payload as { sdp?: unknown }).sdp;
        if (typeof sdp !== "string") return fail(new Error("offer without SDP"));
        await pc.setRemoteDescription({ type: "offer", sdp }).catch(fail);
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

export class PeerSession {
  readonly id = randomUUID();
  readonly profile: string;
  readonly capabilities: PeerCapabilities;
  readonly mode: "pairing" | "reconnect";
  readonly channel: MailboxChannel;
  readonly events: PairingEvent[] = [];
  done = false;
  private eventSeq = 0;
  private link: SyncPeer | null = null;
  private engine: SyncEngine | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private known: Hashmap = {};
  private approval: ((ok: boolean) => void) | null = null;
  private sas = "";
  private closed = false;
  private busy = false;

  constructor(
    private mailbox: Mailbox,
    mode: "pairing" | "reconnect",
    channel: MailboxChannel,
    capabilities: PeerCapabilities,
    private iceServers: unknown[] = [],
    private onReady?: (session: PeerSession) => void,
    private onClosed?: (session: PeerSession) => void,
  ) {
    this.mode = mode;
    this.channel = channel;
    this.profile = channel.profile;
    this.capabilities = capabilities;
  }

  private emit(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ seq: this.eventSeq++, at: new Date().toISOString(), type, data });
  }

  info(code: string): PairingInfo {
    return {
      id: this.id,
      profile: this.profile,
      channelId: this.channel.id,
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
      const answer = await answerChannel(this.mailbox, this.channel, this.iceServers);
      if (this.closed) {
        answer.close();
        return;
      }
      this.sas = answer.phrase;
      let link!: SyncPeer;
      link = controlPeer(answer.peer, (control) => {
        void this.onControl(control, link);
      });
      this.link = link;
      link.onClosed(() => this.dispose());
      this.emit("connected", { sas: this.sas });
      const key = await serverKey();
      const proofKey = hmac(key, `pair:${this.profile}`);
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
      if (this.mode === "pairing") {
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
            clientKey,
            serverKey: proofKey,
            fingerprint: record.fingerprint,
            bootstrap: Object.keys(existing).length,
            capabilities: { mirror: this.capabilities.mirror, exec: this.capabilities.exec },
          }),
        );
        this.emit("paired", { profile: this.profile, fingerprint: record.fingerprint });
      } else {
        const record = (await readPeers()).peers[this.profile];
        if (!record) {
          link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message: "unknown profile" }));
          this.dispose();
          return;
        }
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
        this.mailbox.append(this.channel, "answerer", "error", { message });
      }
      this.closeSoon(this.link ? 1_500 : 3_000);
    }
  }

  private pendingNonce = "";
  private pendingProofKey = "";
  private pendingClientNonce = "";

  private async onControl(control: Record<string, unknown>, link: SyncPeer): Promise<void> {
    const op = String(control.op ?? "");
    const expectedProfile = this.profile;
    if (op === "hello") {
      if (control.profile !== expectedProfile) {
        const got = String(control.profile ?? "");
        link.send(
          controlEnvelope(channelPeerId(this.profile), {
            op: "error",
            message:
              `this code is for browser profile "${expectedProfile}", but this tab is "${got}" — ` +
              `rerun \`npm run pair -- --profile ${got}\``,
          }),
        );
        this.closeSoon();
        return;
      }
      this.emit("joined", { profile: this.profile, sas: this.sas });
      if (this.mode === "pairing") this.emit("sas", { sas: this.sas });
      return;
    }
    if (op === "resume") {
      if (this.mode !== "reconnect") {
        link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message: "pairing required" }));
        return;
      }
      if (control.profile !== expectedProfile) return;
      const record = (await readPeers()).peers[this.profile];
      if (!record) return;
      const proof = String(control.proof ?? "");
      if (!sameSecret(proof, hmac(record.keyHash, this.pendingNonce))) {
        this.emit("error", { message: "client key rejected" });
        link.send(controlEnvelope(channelPeerId(this.profile), { op: "error", message: "client key rejected" }));
        this.closeSoon();
        return;
      }
      this.emit("sas", { sas: this.sas });
      this.pendingClientNonce = String(control.clientNonce ?? randomBytes(16).toString("hex"));
      link.send(
        controlEnvelope(channelPeerId(this.profile), {
          op: "resumed",
          v: 1,
          proof: hmac(this.pendingProofKey, this.pendingClientNonce),
          capabilities: { mirror: this.capabilities.mirror, exec: this.capabilities.exec },
        }),
      );
      return;
    }
    if (op === "ready") {
      if (this.engine) return;
      await this.attachEngine();
      return;
    }
    if (op === "ops-run") {
      void this.runOp(control, link);
    }
  }

  private async attachEngine(): Promise<void> {
    const folder = this.capabilities.mirrorPath ?? defaultMirrorDir(this.capabilities.mirror ?? this.profile);
    await fs.mkdir(folder, { recursive: true });
    const platform = createNodePlatform(folder, this.capabilities.exec);
    this.engine = new SyncEngine(platform, channelPeerId(this.profile), {
      journalRoot: peerJournalDir(this.profile),
    });
    this.known = await buildHashmap(platform, platform.workspaceRoot);
    this.engine.onState((state: SyncState) => this.emit("sync", { status: state.status, detail: state.detail }));
    if (this.link) this.engine.attach(this.link);
    this.onReady?.(this);
    this.watchTimer = setTimeout(() => void this.scanExternal(), 800);
    try {
      this.watcher = watch(folder, { recursive: true }, () => {
        if (this.watchTimer) return;
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.scanExternal();
        }, 500);
      });
      this.watcher.on("error", () => undefined);
    } catch {
      /* coarse/exhausted watcher: ops and reconciles still converge */
    }
    this.emit("ready", { profile: this.profile, mirror: this.capabilities.mirror });
  }

  private async scanExternal(): Promise<void> {
    this.watchTimer = null;
    if (!this.engine || !this.link) return;
    const platform = createNodePlatform(this.capabilities.mirrorPath ?? defaultMirrorDir(this.capabilities.mirror ?? this.profile));
    const current = await buildHashmap(platform, platform.workspaceRoot).catch(() => null);
    if (!current) return;
    const changed: string[] = [];
    for (const [p, entry] of Object.entries(current)) {
      if (this.known[p]?.hash !== entry.hash) changed.push(p);
    }
    for (const p of Object.keys(this.known)) {
      if (!(p in current)) changed.push(p);
    }
    this.known = current;
    if (changed.length) {
      await this.engine.noteMutation([...new Set(changed)]).catch(() => undefined);
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
    const folder = this.capabilities.mirrorPath ?? defaultMirrorDir(this.capabilities.mirror ?? this.profile);
    const timeoutMs = Math.min(OP_TIMEOUT_MS, Math.max(1_000, Number(control.timeoutMs ?? OP_TIMEOUT_MS)));
    this.busy = true;
    try {
      if (this.engine) await this.engine.reconcileAndWait(link, 15_000).catch(() => false);
      const before = await buildHashmap(createNodePlatform(folder, this.capabilities.exec), folder);
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
      const after = await buildHashmap(createNodePlatform(folder, this.capabilities.exec), folder);
      const changed: string[] = [];
      for (const [p, entry] of Object.entries(after)) {
        if (before[p]?.hash !== entry.hash) changed.push(p);
      }
      for (const p of Object.keys(before)) if (!(p in after)) changed.push(p);
      this.known = after;
      if (this.engine && changed.length) {
        await this.engine.noteMutation(changed).catch(() => undefined);
        await this.engine.reconcileAndWait(link, 20_000).catch(() => false);
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
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watcher?.close();
    try {
      this.link?.close();
    } catch {
      /* already closed */
    }
    this.link = null;
    this.mailbox.close(this.channel);
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
    this.liveByProfile.set(session.profile, session);
  }

  async createPairing(profile: string, capabilities: Partial<PeerCapabilities> = {}): Promise<PairingInfo> {
    if (!PROFILE_RE.test(profile)) throw new Error("invalid profile name");
    const mirror = capabilities.mirror ?? profile;
    if (!PROFILE_RE.test(mirror)) throw new Error("invalid mirror folder name");
    const mirrorPath = capabilities.mirrorPath ? path.resolve(capabilities.mirrorPath) : undefined;
    const caps: PeerCapabilities = {
      mirror,
      mirrorPath,
      exec: Array.isArray(capabilities.exec) ? capabilities.exec.map(String).filter(Boolean) : [],
    };
    const created = this.mailbox.createPairing(profile);
    const session = new PeerSession(
      this.mailbox,
      "pairing",
      created.channel,
      caps,
      this.iceServers,
      (s) => this.makeLive(s),
      (s) => this.unregister(s),
    );
    this.register(session, created.code);
    session.channel.onJoined = () => undefined;
    return session.info(created.code ?? "");
  }

  /** A reconnect channel for an already-paired profile (client-key create). */
  createReconnect(profile: string, record: PeerRecord): { session: PeerSession; channelId: string; roleToken: string } {
    // A reconnect replaces the old connection for this profile.
    this.liveByProfile.get(profile)?.dispose();
    const created = this.mailbox.createReconnect(profile);
    const caps = record.capabilities;
    const session = new PeerSession(
      this.mailbox,
      "reconnect",
      created.channel,
      caps,
      this.iceServers,
      (s) => this.makeLive(s),
      (s) => this.unregister(s),
    );
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
  }

  async peers(): Promise<PeerRecord[]> {
    return Object.values((await readPeers()).peers);
  }

  sessionForProfile(profile: string): PeerSession | null {
    return this.liveByProfile.get(profile) ?? null;
  }

  private unregister(session: PeerSession): void {
    this.sessions.delete(session.id);
    this.codes.delete(session.id);
    if (this.liveByProfile.get(session.profile) === session) this.liveByProfile.delete(session.profile);
  }
}
