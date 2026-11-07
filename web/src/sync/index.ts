/**
 * Multi-profile sync manager.
 *
 * One device can sync several profiles at once. Each profile gets its own
 * SyncEngine over its own OPFS root; one authenticated peer link multiplexes
 * them (see `profile-link.ts`). Same-origin tabs keep using a BroadcastChannel
 * per profile, so a profile switch is not required for pairing any more.
 *
 * The manager keeps the old single-profile `SyncHandle` surface for the active
 * profile (`engine`, `state`, `syncNow`, `onState`) so boot, the agent and the
 * status chip do not need to know about the matrix.
 */
import { SyncEngine, emptyTransfer, type SyncPeer, type SyncState } from "./engine";
import type { Platform } from "../platform/types";
import { createProfilePlatform } from "../platform/browser";
import { broadcastPeer } from "./transport-broadcast";
import { watchCommits } from "./commit-watch";
import {
  ManualSignaling,
  BobSwapSignaling,
  rtcPeer,
  type SignalingProvider,
} from "./transport-webrtc";
import { ProfileLink } from "./profile-link";
import {
  autoLinkProfiles,
  ensureDeviceId,
  effectiveAllow,
  loadDeviceName,
  loadPeerStore,
  normalizeDeviceName,
  remapPeerConsent,
  saveDeviceName,
  savePeerStore,
  upsertPeer,
  type PeerProfileCatalog,
  type PeerSyncStore,
  type ProfilePreview,
} from "../profile-sync-model";
import {
  profileCatalogEntry,
  profileHandle,
  type ProfileCatalogEntry,
} from "../profiles";
import { summarizeWorkspace } from "../workspace-transfer";

export interface SyncProfileTarget {
  id: string;
  name: string;
  /** Feeds the one-time same-name auto-link decision. */
  createdAt?: string;
}

export interface SyncOptions {
  /** Stable replica id (conflict tie-break). */
  id: string;
  /** Legacy channel name for the active profile (used if `profiles` is absent). */
  channelName?: string;
  activeProfile?: string;
  /** Initial catalog; `catalog()` wins when supplied so new profiles appear. */
  profiles?: SyncProfileTarget[];
  /** Live catalog from the profile registry. */
  catalog?: () => SyncProfileTarget[];
  /** Active-profile DB dump replay (legacy hook). */
  onApplied?: (paths: string[], previous: Record<string, string>) => void | Promise<void>;
  /** Per-profile DB dump replay (inactive profiles included). */
  onAppliedProfile?: (
    profileName: string,
    paths: string[],
    previous: Record<string, string>,
  ) => void | Promise<void>;
  /** Rewrite a local profile id after a one-time name auto-link. */
  relinkProfile?: (fromId: string, toId: string) => void | Promise<void>;
  /** Injectable for tests; defaults to the browser OPFS profile platform. */
  createPlatform?: (profileName: string) => Platform;
  /** Human label shown under a peer profile row. */
  deviceName?: string;
}

export type PendingPairing = {
  /** Resolves with the verification phrase once the transport is open. */
  done: Promise<string>;
  /** Resolves once BOTH sides confirmed the phrase (catalog may now move). */
  ready: Promise<void>;
  /** Feed the blob the other side produced (manual pairing). */
  accept: (blob: string) => void;
  /** Both users compare the phrase, then each presses this. */
  confirm: () => void;
  /** The phrase does not match: abort without moving data. */
  reject: (reason?: string) => void;
};

export interface AttachDeviceOptions {
  kind?: "pair" | "desktop";
  /** Known remote device id (desktop links report it in the catalog). */
  deviceId?: string;
  deviceName?: string;
  /** Browser ↔ browser needs both phrase buttons; desktop already approved. */
  requirePhrase?: boolean;
  /** A new pairing starts from default consent, even for a known device. */
  freshPairing?: boolean;
  onReady?: () => void;
  onPhraseRejected?: (reason: string) => void;
}

export interface SyncHandle {
  /** The ACTIVE profile's engine (existing consumers rely on this). */
  engine: SyncEngine;
  state(): SyncState;
  onState(cb: (state: SyncState) => void): () => void;
  /** The human name this browser sends to peers. */
  deviceName(): string;
  /** Rename this browser; pushes the new name to every open link. */
  setDeviceName(name: string): void;
  /** Attach a raw peer to the active profile only (legacy). */
  attach(peer: SyncPeer): void;
  /** Attach a multiplexed device link. */
  attachDevice(peer: SyncPeer, options?: AttachDeviceOptions): DeviceHandle;
  detach(peerId?: string): void;
  syncNow(): Promise<{ peers: number; completed: number }>;
  startManualPairing(role: "offerer" | "joiner", onOutgoing: (blob: string) => void, onStatus?: (text: string) => void): PendingPairing;
  pairBobSwap(channel: {
    baseUrl: string;
    readKey?: string;
    id: string;
    roleToken: string;
    role: "offerer" | "answerer" | "joiner";
    iceServers?: RTCIceServer[];
    onStatus?: (text: string) => void;
  }): Promise<PendingPairing>;
  unpair(): void;
  stop(): void;
  /** Current peers + permissions (drives the Profiles dialog). */
  peers(): PeerSyncStore;
  onPeersChanged(cb: () => void): () => void;
  setProfileConsent(peerId: string, profileId: string, allow: boolean): void;
  unlinkProfile(peerId: string, profileId: string): void;
  /** Local deletion: close every peer's consent so nothing is pushed back in. */
  removeProfile(profileId: string): void;
  requestPreview(peerId: string, profileId: string): Promise<ProfilePreview | null>;
  /** Re-apply consent after a profile was created/deleted. */
  refreshProfiles(): void;
  /** Merge a new catalog entry into every link (profile add/rename/delete). */
  pushCatalog(): void;
  /** Confirm/reject the phrase on a pending device link. */
  confirmPhrase(peerKey?: string): void;
  rejectPhrase(peerKey?: string, reason?: string): void;
  /** Pending device links keyed by their temporary id. */
  pendingLinks(): string[];
}

export interface DeviceHandle {
  id: string;
  link: ProfileLink;
  confirmPhrase(): void;
  rejectPhrase(reason?: string): void;
  close(): void;
}

interface ProfileRuntime {
  target: SyncProfileTarget;
  engine: SyncEngine;
  platform: Platform;
  unwatch: () => void;
  broadcast: SyncPeer | null;
}

interface DeviceSession {
  key: string;
  kind: "pair" | "desktop";
  deviceId: string;
  deviceName: string;
  link: ProfileLink;
  attached: Map<string, SyncPeer>;
  freshPairing: boolean;
  /** Consent can race an async auto-link; keep it until the peer record exists. */
  pendingConsent?: Record<string, boolean>;
}

let active: SyncHandle | null = null;

export function activeSync(): SyncHandle | null {
  return active;
}

/** The label a browser uses until the user gives it a name. */
export function defaultDeviceName(): string {
  const host =
    typeof location !== "undefined" && location.hostname ? location.hostname : "";
  return normalizeDeviceName(host ? `browser · ${host}` : "browser") || "browser";
}

export async function startSync(
  platform: Platform,
  opts: SyncOptions,
): Promise<SyncHandle> {
  // `platform` is retained for callers/tests; the per-profile platforms below
  // are what the engines actually use.
  void platform;
  if (active) active.stop();
  const manager = new MultiProfileSync(opts);
  active = manager;
  return manager;
}

class MultiProfileSync implements SyncHandle {
  engine!: SyncEngine;
  private opts: SyncOptions;
  private runtimes = new Map<string, ProfileRuntime>();
  private sessions = new Map<string, DeviceSession>();
  private store: PeerSyncStore = loadPeerStore();
  private stateListeners = new Set<(state: SyncState) => void>();
  private peerListeners = new Set<() => void>();
  private activeProfile: string;
  private deviceId = ensureDeviceId();
  private selfName: string;
  private current: SyncState = {
    status: "idle",
    detail: "",
    conflicts: [],
    lastSyncAt: null,
    transfer: emptyTransfer(),
  };
  private stopped = false;

  constructor(opts: SyncOptions) {
    this.opts = opts;
    this.activeProfile = opts.activeProfile ?? opts.profiles?.[0]?.name ?? "default";
    this.selfName =
      opts.deviceName ?? (loadDeviceName() || defaultDeviceName());
    const activeTarget =
      this.catalog().find((target) => target.name === this.activeProfile) ?? {
        // Boot fallback for a registry that has not been handed over yet.
        id: (globalThis.crypto?.randomUUID?.() ?? this.deviceId).toLowerCase(),
        name: this.activeProfile,
      };
    this.engine = this.runtimeFor(activeTarget).engine;
  }

  private catalog(): SyncProfileTarget[] {
    const targets = this.opts.catalog?.() ?? this.opts.profiles ?? [];
    return targets.map((target) => ({ id: target.id.toLowerCase(), name: target.name }));
  }

  private catalogEntries(): ProfileCatalogEntry[] {
    return this.catalog().map((target) => ({
      id: target.id,
      name: target.name,
      createdAt: target.createdAt ?? new Date(0).toISOString(),
    }));
  }

  private runtimeFor(target: SyncProfileTarget): ProfileRuntime {
    const existing = this.runtimes.get(target.name);
    if (existing) return existing;
    const platform = this.opts.createPlatform?.(target.name) ?? createProfilePlatform(target.name);
    const engine = new SyncEngine(platform, this.opts.id, {
      onApplied: (paths, previous) =>
        target.name === this.activeProfile
          ? this.opts.onApplied?.(paths, previous)
          : this.opts.onAppliedProfile?.(target.name, paths, previous),
    });
    const unwatch = watchCommits(platform, (paths) => {
      void engine.noteMutation(paths);
    });
    const broadcast =
      target.name === this.activeProfile
        ? broadcastPeer(`bob-sync:opfs:${target.name}`, engine)
        : null;
    if (broadcast) engine.attach(broadcast);
    engine.onState((next) => {
      if (target.name !== this.activeProfile) return;
      this.current = next;
      for (const cb of this.stateListeners) cb(next);
    });
    const runtime = { target, engine, platform, unwatch, broadcast };
    this.runtimes.set(target.name, runtime);
    if (target.name === this.activeProfile) this.engine = engine;
    return runtime;
  }

  private runtimeByProfileId(profileId: string): ProfileRuntime | null {
    const id = profileId.toLowerCase();
    for (const runtime of this.runtimes.values()) {
      if (runtime.target.id.toLowerCase() === id) return runtime;
    }
    const target = this.catalog().find((entry) => entry.id.toLowerCase() === id);
    return target ? this.runtimeFor(target) : null;
  }

  state(): SyncState {
    return this.current;
  }

  onState(cb: (state: SyncState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this.current);
    return () => this.stateListeners.delete(cb);
  }

  deviceName(): string {
    return this.selfName;
  }

  setDeviceName(name: string): void {
    const normalized = normalizeDeviceName(name);
    this.selfName = normalized || defaultDeviceName();
    saveDeviceName(normalized);
    for (const session of this.sessions.values()) {
      session.link.setDeviceName(this.selfName);
    }
    this.notifyPeers();
  }

  attach(peer: SyncPeer): void {
    this.runtimeFor(this.activeTarget()).engine.attach(peer);
  }

  private activeTarget(): SyncProfileTarget {
    return (
      this.catalog().find((target) => target.name === this.activeProfile) ?? {
        id: (globalThis.crypto?.randomUUID?.() ?? this.deviceId).toLowerCase(),
        name: this.activeProfile,
      }
    );
  }

  attachDevice(peer: SyncPeer, options: AttachDeviceOptions = {}): DeviceHandle {
    const temporary = options.deviceId ?? `pending:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    const session: DeviceSession = {
      key: temporary,
      kind: options.kind ?? "pair",
      deviceId: options.deviceId ?? "",
      deviceName: options.deviceName ?? "peer",
      link: null as unknown as ProfileLink,
      attached: new Map(),
      freshPairing: options.freshPairing === true,
    };
    const link = new ProfileLink(peer, {
      deviceId: this.deviceId,
      deviceName: this.selfName,
      catalog: this.catalogEntries(),
      consent: {},
      defaultProfileId: this.activeTarget().id,
      peerId: this.opts.id,
      requirePhrase: options.requirePhrase === true,
      onCatalog: (catalog, remoteId, remoteName) => {
        void this.handleCatalog(session, catalog, remoteId, remoteName);
      },
      onConsent: (consent) => {
        this.handleConsent(session, consent);
      },
      onReady: () => {
        options.onReady?.();
        this.applyConsent(session);
      },
      onPhraseRejected: (reason) => {
        console.warn(`[sync] phrase rejected: ${reason}`);
        options.onPhraseRejected?.(reason);
        link.close();
        this.sessions.delete(session.key);
      },
      onPreviewRequest: (profileId) => this.previewFor(profileId),
      onClosed: () => {
        this.sessions.delete(session.key);
        session.attached.clear();
        const peer = this.store.peers[session.key];
        if (peer) {
          this.store = {
            version: 1,
            peers: {
              ...this.store.peers,
              [session.key]: { ...peer, online: false, lastSeen: new Date().toISOString() },
            },
          };
          savePeerStore(this.store);
        }
        this.notifyPeers();
      },
    });
    session.link = link;
    this.sessions.set(session.key, session);
    link.start();
    return {
      id: session.key,
      link,
      confirmPhrase: () => link.confirmPhrase(),
      rejectPhrase: (reason) => link.rejectPhrase(reason),
      close: () => {
        link.close();
        this.sessions.delete(session.key);
      },
    };
  }

  private async handleCatalog(
    session: DeviceSession,
    remoteCatalog: ProfileCatalogEntry[],
    remoteDeviceId: string,
    remoteDeviceName: string,
  ): Promise<void> {
    if (this.stopped) return;
    const peerKey = remoteDeviceId || session.key;
    if (session.freshPairing) {
      session.freshPairing = false;
      if (this.store.peers[peerKey]) {
        const peers = { ...this.store.peers };
        delete peers[peerKey];
        this.store = { version: 1, peers };
      }
    }
    const previous = this.store.peers[peerKey] ?? this.store.peers[session.key];
    const local = this.catalog();
    const localEntries: ProfileCatalogEntry[] = local.map((target) => ({
      id: target.id,
      name: target.name,
      createdAt: target.createdAt ?? new Date(0).toISOString(),
    }));
    const links = autoLinkProfiles(localEntries, remoteCatalog, {
      linkedNames: previous?.linkedNames ?? [],
      unlinkedIds: previous?.unlinkedIds ?? [],
    });
    for (const link of links) {
      if (!link.adoptLocal) continue;
      try {
        await this.opts.relinkProfile?.(link.adoptLocal.from, link.adoptLocal.to);
        this.store = remapPeerConsent(this.store, link.adoptLocal.from, link.adoptLocal.to);
      } catch (err) {
        console.warn("[sync] could not auto-link profile id:", err);
      }
    }
    this.store = upsertPeer(this.store, {
      peerId: peerKey,
      deviceName: remoteDeviceName,
      profiles: remoteCatalog,
      catalog: localEntries,
      links,
    });
    if (session.pendingConsent) {
      const peer = this.store.peers[peerKey];
      if (peer) {
        this.store = {
          version: 1,
          peers: {
            ...this.store.peers,
            [peerKey]: { ...peer, remoteAllow: { ...session.pendingConsent } },
          },
        };
      }
      session.pendingConsent = undefined;
    }
    savePeerStore(this.store);
    // Re-key a pending session now that the peer's stable device id is known.
    if (session.key !== peerKey) {
      this.sessions.delete(session.key);
      session.key = peerKey;
      this.sessions.set(peerKey, session);
    }
    session.deviceId = remoteDeviceId;
    session.deviceName = remoteDeviceName;
    // A rewrite may have changed local ids: publish the canonical catalog.
    if (links.some((link) => link.adoptLocal)) session.link.setCatalog(this.catalogEntries());
    else session.link.setCatalog(this.catalogEntries(), false);
    const peer = this.store.peers[peerKey];
    session.link.setConsent(peer?.localAllow ?? {});
    this.applyConsent(session);
    this.notifyPeers();
  }

  private handleConsent(session: DeviceSession, remoteAllow: Record<string, boolean>): void {
    const peerKey = session.key;
    const peer = this.store.peers[peerKey];
    if (!peer) {
      session.pendingConsent = remoteAllow;
      return;
    }
    this.store = {
      version: 1,
      peers: {
        ...this.store.peers,
        [peerKey]: { ...peer, remoteAllow: { ...remoteAllow }, lastSeen: new Date().toISOString() },
      },
    };
    savePeerStore(this.store);
    this.applyConsent(session);
    this.notifyPeers();
  }

  private applyConsent(session: DeviceSession): void {
    const peer = this.store.peers[session.key];
    if (!peer) return;
    for (const target of this.catalog()) {
      const allowed = effectiveAllow(peer.localAllow, peer.remoteAllow, target.id);
      const attached = session.attached.get(target.id.toLowerCase());
      if (allowed) {
        if (!attached) {
          const runtime = this.runtimeFor(target);
          const virtual = session.link.peerFor(target.id);
          session.attached.set(target.id.toLowerCase(), virtual);
          runtime.engine.attach(virtual);
        }
      } else if (attached) {
        session.attached.delete(target.id.toLowerCase());
        session.link.detachProfile(target.id);
      }
    }
    // Detach profiles that disappeared from the local registry.
    const ids = new Set(this.catalog().map((target) => target.id.toLowerCase()));
    for (const [id, virtual] of session.attached) {
      if (ids.has(id)) continue;
      session.attached.delete(id);
      session.link.detachProfile(id);
      void virtual;
    }
  }

  private async previewFor(profileId: string): Promise<ProfilePreview | null> {
    const id = profileId.toLowerCase();
    // Metadata is only answered for a profile both sides allowed.
    const peer = [...this.sessions.values()]
      .map((session) => this.store.peers[session.key])
      .find((entry) => entry && entry.localAllow[id] === true && entry.remoteAllow[id] === true);
    if (!peer) return null;
    const target = this.catalog().find((entry) => entry.id.toLowerCase() === id);
    if (!target) return null;
    try {
      const summary = await summarizeWorkspace(await profileHandle(target.name));
      return {
        id,
        files: summary.files,
        bytes: summary.bytes,
        updatedAt: summary.updatedAt,
      };
    } catch {
      return null;
    }
  }

  peers(): PeerSyncStore {
    return this.store;
  }

  onPeersChanged(cb: () => void): () => void {
    this.peerListeners.add(cb);
    return () => this.peerListeners.delete(cb);
  }

  private notifyPeers(): void {
    for (const cb of this.peerListeners) cb();
  }

  setProfileConsent(peerId: string, profileId: string, allow: boolean): void {
    const peer = this.store.peers[peerId];
    if (!peer) return;
    const id = profileId.toLowerCase();
    this.store = {
      version: 1,
      peers: {
        ...this.store.peers,
        [peerId]: {
          ...peer,
          localAllow: { ...peer.localAllow, [id]: allow },
          lastSeen: new Date().toISOString(),
        },
      },
    };
    savePeerStore(this.store);
    const session = this.sessions.get(peerId);
    if (session) {
      session.link.setConsent(this.store.peers[peerId].localAllow);
      this.applyConsent(session);
    }
    this.notifyPeers();
  }

  unlinkProfile(peerId: string, profileId: string): void {
    const peer = this.store.peers[peerId];
    if (!peer) return;
    const id = profileId.toLowerCase();
    const unlinked = new Set(peer.unlinkedIds);
    unlinked.add(id);
    this.store = {
      version: 1,
      peers: {
        ...this.store.peers,
        [peerId]: {
          ...peer,
          unlinkedIds: [...unlinked],
          localAllow: { ...peer.localAllow, [id]: false },
        },
      },
    };
    savePeerStore(this.store);
    this.setProfileConsent(peerId, id, false);
    this.notifyPeers();
  }

  removeProfile(profileId: string): void {
    const id = profileId.toLowerCase();
    for (const peer of Object.values(this.store.peers)) {
      this.unlinkProfile(peer.peerId, id);
    }
  }

  requestPreview(peerId: string, profileId: string): Promise<ProfilePreview | null> {
    const session = this.sessions.get(peerId);
    if (!session?.link.isReady()) return Promise.resolve(null);
    // Asking for a preview is an explicit local allow. Send it first so the
    // peer never answers "not available" because the consent frame raced the
    // request (or because the dialog called Preview without ticking the box).
    const id = profileId.toLowerCase();
    const peer = this.store.peers[peerId];
    if (peer && peer.localAllow[id] !== true) this.setProfileConsent(peerId, id, true);
    return session.link.requestPreview(id);
  }

  refreshProfiles(): void {
    for (const session of this.sessions.values()) {
      session.link.setCatalog(this.catalogEntries());
      this.applyConsent(session);
    }
    // No notifyPeers() here: pushing a catalog does not change peer records.
    // Notifying would re-enter the Profiles dialog, whose refresh pushes the
    // catalog again (and re-renders the row list).
  }

  pushCatalog(): void {
    this.refreshProfiles();
  }

  confirmPhrase(peerKey?: string): void {
    for (const session of this.sessions.values()) {
      if (peerKey && session.key !== peerKey) continue;
      if (session.kind !== "pair") continue;
      session.link.confirmPhrase();
    }
  }

  rejectPhrase(peerKey?: string, reason?: string): void {
    for (const session of this.sessions.values()) {
      if (peerKey && session.key !== peerKey) continue;
      session.link.rejectPhrase(reason);
    }
  }

  pendingLinks(): string[] {
    return [...this.sessions.keys()];
  }

  detach(peerId?: string): void {
    for (const [key, session] of this.sessions) {
      if (peerId && key !== peerId) continue;
      session.link.close();
      this.sessions.delete(key);
    }
  }

  async syncNow(): Promise<{ peers: number; completed: number }> {
    let peers = 0;
    let completed = 0;
    for (const runtime of this.runtimes.values()) {
      const result = await runtime.engine.reconcileAll().catch(() => ({ peers: 0, completed: 0 }));
      peers += result.peers;
      completed += result.completed;
    }
    return { peers, completed };
  }

  private pendingPairing(
    open: () => Promise<{ peer: SyncPeer; phrase: string }>,
    onStatus?: (text: string) => void,
  ): PendingPairing {
    let handle: DeviceHandle | null = null;
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const done = open().then(({ peer, phrase }) => {
      handle = this.attachDevice(peer, {
        kind: "pair",
        requirePhrase: true,
        freshPairing: true,
        onReady: () => {
          onStatus?.("phrase confirmed — exchanging profiles");
          resolveReady();
        },
        onPhraseRejected: (reason) => rejectReady(new Error(reason)),
      });
      return phrase;
    });
    return {
      done,
      ready,
      accept: () => undefined,
      confirm: () => handle?.confirmPhrase(),
      reject: (reason) => handle?.rejectPhrase(reason),
    };
  }

  startManualPairing(
    role: "offerer" | "joiner",
    onOutgoing: (blob: string) => void,
    onStatus?: (text: string) => void,
  ): PendingPairing {
    const provider = new ManualSignaling(role, onStatus);
    void provider.outgoing.then(onOutgoing).catch((err) => onOutgoing(`error: ${String(err)}`));
    const pending = this.pendingPairing(
      () =>
        rtcPeer(provider, this.opts.id, {
          createChannel: role === "offerer",
          onState: onStatus,
        }),
      onStatus,
    );
    return { ...pending, accept: (blob: string) => provider.accept(blob) };
  }

  async pairBobSwap(channel: {
    baseUrl: string;
    readKey?: string;
    id: string;
    roleToken: string;
    role: "offerer" | "answerer" | "joiner";
    iceServers?: RTCIceServer[];
    onStatus?: (text: string) => void;
  }): Promise<PendingPairing> {
    const provider: SignalingProvider = new BobSwapSignaling(
      { baseUrl: channel.baseUrl, readKey: channel.readKey },
      { id: channel.id, roleToken: channel.roleToken, role: channel.role },
      channel.onStatus,
    );
    const { peer, phrase } = await rtcPeer(provider, this.opts.id, {
      iceServers: channel.iceServers,
      createChannel: channel.role === "offerer",
      onState: channel.onStatus,
    });
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const handle = this.attachDevice(peer, {
      kind: "pair",
      requirePhrase: true,
      freshPairing: true,
      onReady: () => {
        channel.onStatus?.("phrase confirmed — exchanging profiles");
        resolveReady();
      },
      onPhraseRejected: (reason) => rejectReady(new Error(reason)),
    });
    return {
      done: Promise.resolve(phrase),
      ready,
      accept: () => undefined,
      confirm: () => handle.confirmPhrase(),
      reject: (reason) => handle.rejectPhrase(reason),
    };
  }

  unpair(): void {
    const peers = { ...this.store.peers };
    for (const [key, session] of this.sessions) {
      if (session.kind !== "pair") continue;
      session.link.close();
      this.sessions.delete(key);
      // Re-pairing starts from defaults; do not inherit stale vetoes.
      delete peers[key];
    }
    this.store = { version: 1, peers };
    savePeerStore(this.store);
    this.notifyPeers();
  }

  stop(): void {
    this.stopped = true;
    for (const session of this.sessions.values()) session.link.close();
    this.sessions.clear();
    for (const runtime of this.runtimes.values()) {
      runtime.unwatch();
      runtime.broadcast?.close();
      runtime.engine.detach();
    }
    this.runtimes.clear();
    this.stateListeners.clear();
    this.peerListeners.clear();
    if (active === (this as unknown as SyncHandle)) active = null;
  }
}
