/**
 * Multiplexed device link: one authenticated SyncPeer carries several profile
 * workspaces, a catalog, consent and the phrase gate.
 *
 * Every data envelope is tagged with `profile` (the canonical profile UUID).
 * Engines see a normal `SyncPeer`; the transport routes by tag. Control frames
 * (`kind: "control"`) are handled here and never reach an engine.
 *
 * No catalog, consent or data frame moves before both sides confirm the SAS
 * phrase when `requirePhrase` is set. The desktop pairing path uses the CLI
 * approval as its confirmation, so it constructs the link with
 * `requirePhrase: false` only after the operator approved.
 */
import type { SyncEnvelope, SyncPeer } from "./engine";
import {
  normalizeCatalog,
  type ProfileCatalogEntry,
  type ProfilePreview,
} from "../profile-sync-model";

export interface ProfileLinkOptions {
  deviceId: string;
  deviceName: string;
  catalog: ProfileCatalogEntry[];
  consent: Record<string, boolean>;
  /** The profile legacy untagged frames belong to. */
  defaultProfileId?: string;
  /** Browser ↔ browser pairing: wait for both phrase confirmations. */
  requirePhrase: boolean;
  /** Engine replica id used by every virtual profile peer. */
  peerId: string;
  onCatalog?: (catalog: ProfileCatalogEntry[], deviceId: string, deviceName: string) => void;
  onConsent?: (consent: Record<string, boolean>) => void;
  onReady?: () => void;
  onPhraseRejected?: (reason: string) => void;
  onPreviewRequest?: (profileId: string) => Promise<ProfilePreview | null>;
  /** Control frames not owned by the link (hello/resume/ops/log). */
  onControl?: (control: Record<string, unknown>) => void;
  onClosed?: () => void;
}

interface PendingPreview {
  resolve: (preview: ProfilePreview | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PREVIEW_TIMEOUT_MS = 20_000;

export class ProfileLink {
  readonly peerId: string;
  private inner: SyncPeer;
  private opts: ProfileLinkOptions;
  private handlers = new Map<string, (envelope: SyncEnvelope) => void>();
  private closeHandlers = new Map<string, Array<() => void>>();
  private closed = false;
  private localPhrase = false;
  private remotePhrase = false;
  private ready = false;
  private catalog: ProfileCatalogEntry[];
  private consent: Record<string, boolean>;
  private pendingPreview = new Map<string, PendingPreview>();
  private buffered: Array<{ profile: string; envelope: SyncEnvelope }> = [];
  private phraseTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeControl: (() => void) | null = null;

  constructor(inner: SyncPeer, options: ProfileLinkOptions) {
    this.inner = inner;
    this.opts = options;
    this.peerId = options.peerId;
    this.catalog = normalizeCatalog(options.catalog);
    this.consent = { ...options.consent };
    // A transport with a separate control plane (the desktop/server
    // ServerConnection wraps one) delivers controls here; a raw WebRTC peer
    // delivers everything through onMessage.
    this.unsubscribeControl = inner.onControl?.((control) => this.onControl(control)) ?? null;
    inner.onMessage((envelope) => this.receive(envelope));
    inner.onClosed(() => this.close());
  }

  /** Send our catalog/consent (and resolve the phrase gate if not required). */
  start(): void {
    if (this.opts.requirePhrase) {
      this.phraseTimer = setTimeout(() => {
        this.phraseTimer = null;
        if (this.ready || this.closed) return;
        this.opts.onPhraseRejected?.("the phrase was not confirmed in time");
        this.close();
      }, 2 * 60_000);
      return;
    }
    this.localPhrase = true;
    this.remotePhrase = true;
    this.markReady();
  }

  /**
   * Record the local phrase confirmation and tell the peer. Only once both
   * confirmations have arrived does the link become ready.
   */
  confirmPhrase(): void {
    if (this.localPhrase) return;
    this.localPhrase = true;
    this.sendControl({ op: "phrase-ok" });
    if (this.remotePhrase) this.markReady();
  }

  /** Tell the peer the phrases do not match; no data can move afterwards. */
  rejectPhrase(reason = "the phrase does not match"): void {
    if (this.closed) return;
    this.sendControl({ op: "phrase-mismatch", reason });
    this.opts.onPhraseRejected?.(reason);
    this.close();
  }

  private markReady(): void {
    if (this.ready || this.closed) return;
    this.ready = true;
    if (this.phraseTimer) {
      clearTimeout(this.phraseTimer);
      this.phraseTimer = null;
    }
    this.sendCatalog();
    this.sendConsent();
    this.opts.onReady?.();
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Feed a control frame that arrived before the link was constructed. The
   * desktop peer creates its ProfileLink after the browser's `ready` frame; the
   * browser's catalog/consent can arrive in that window and must not be lost.
   */
  receiveControl(control: Record<string, unknown>): void {
    if (this.closed) return;
    this.onControl(control);
  }

  /**
   * Replace the local catalog. `send` is false when the change came from the
   * peer's own catalog (prevents a catalog echo loop).
   */
  setCatalog(catalog: ProfileCatalogEntry[], send = true): void {
    this.catalog = normalizeCatalog(catalog);
    if (send && this.ready) this.sendCatalog();
  }

  /** Replace this side's consent map and push it to the peer. */
  setConsent(consent: Record<string, boolean>): void {
    this.consent = { ...consent };
    if (this.ready) this.sendConsent();
  }

  /** Send the catalog now (used after a one-time auto-link rewrite). */
  sendCatalog(): void {
    if (this.closed) return;
    this.sendControl({
      op: "profile-catalog",
      deviceId: this.opts.deviceId,
      deviceName: this.opts.deviceName,
      profiles: this.catalog,
    });
  }

  private sendConsent(): void {
    if (this.closed) return;
    this.sendControl({ op: "profile-consent", profiles: this.consent });
  }

  /**
   * A virtual peer for one profile. Engines attach to this exactly like a
   * transport peer; closing it detaches that profile without touching the
   * device connection or any other profile.
   */
  peerFor(profileId: string): SyncPeer {
    const id = profileId.toLowerCase();
    let closed = false;
    return {
      id: this.peerId,
      send: (envelope) => {
        if (closed || this.closed) return;
        this.inner.send({ ...envelope, profile: id });
      },
      connected: () => !closed && !this.closed && this.inner.connected(),
      onMessage: (cb) => {
        this.handlers.set(id, cb);
        const queued = this.buffered.filter((entry) => entry.profile === id);
        this.buffered = this.buffered.filter((entry) => entry.profile !== id);
        for (const entry of queued) cb(entry.envelope);
      },
      onClosed: (cb) => {
        const list = this.closeHandlers.get(id) ?? [];
        list.push(cb);
        this.closeHandlers.set(id, list);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.handlers.delete(id);
        const list = this.closeHandlers.get(id) ?? [];
        this.closeHandlers.delete(id);
        for (const cb of list) cb();
      },
    };
  }

  /** Detach one profile's engine; the device link stays open. */
  detachProfile(profileId: string): void {
    const id = profileId.toLowerCase();
    this.handlers.delete(id);
    this.buffered = this.buffered.filter((entry) => entry.profile !== id);
    const list = this.closeHandlers.get(id) ?? [];
    this.closeHandlers.delete(id);
    for (const cb of list) cb();
  }

  requestPreview(profileId: string): Promise<ProfilePreview | null> {
    if (this.closed || !this.inner.connected()) return Promise.resolve(null);
    const request = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPreview.delete(request);
        resolve(null);
      }, PREVIEW_TIMEOUT_MS);
      this.pendingPreview.set(request, { resolve, timer });
      this.sendControl({ op: "profile-preview", request, profile: profileId });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.unsubscribeControl?.();
    this.unsubscribeControl = null;
    if (this.phraseTimer) {
      clearTimeout(this.phraseTimer);
      this.phraseTimer = null;
    }
    for (const pending of this.pendingPreview.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingPreview.clear();
    this.handlers.clear();
    this.buffered = [];
    const callbacks = [...this.closeHandlers.values()].flat();
    this.closeHandlers.clear();
    for (const cb of callbacks) cb();
    this.opts.onClosed?.();
  }

  private sendControl(control: Record<string, unknown>): void {
    if (this.closed) return;
    this.inner.send({ v: 1, kind: "control", from: this.peerId, control });
  }

  private receive(envelope: SyncEnvelope): void {
    if (this.closed) return;
    if (envelope.kind === "control") {
      this.onControl(envelope.control ?? {});
      return;
    }
    if (!this.ready) {
      // Data before the phrase gate is a protocol violation. Never deliver it,
      // even if the gate later opens.
      return;
    }
    const profile = (envelope.profile ?? this.opts.defaultProfileId ?? "").toLowerCase();
    if (!profile) return;
    const handler = this.handlers.get(profile);
    if (handler) {
      handler(envelope);
      return;
    }
    // The consent/attach step is async: keep early frames until the engine
    // registers its handler instead of dropping the first hashmap.
    if (this.buffered.length < 200) this.buffered.push({ profile, envelope });
  }

  private onControl(control: Record<string, unknown>): void {
    const op = String(control.op ?? "");
    if (op === "phrase-ok") {
      this.remotePhrase = true;
      // A desktop peer that already approved may send its confirmation before
      // the browser clicked; reply so both sides can settle without a second
      // human step on the desktop.
      if (!this.localPhrase && !this.opts.requirePhrase) {
        this.localPhrase = true;
        this.sendControl({ op: "phrase-ok" });
      }
      if (this.localPhrase && this.remotePhrase) this.markReady();
      return;
    }
    if (op === "phrase-mismatch") {
      this.opts.onPhraseRejected?.(String(control.reason ?? "the peer rejected the phrase"));
      this.close();
      return;
    }
    // Nothing but the phrase handshake is meaningful before both confirmations.
    // In particular, never forward stale ops/log controls from a pre-gate peer.
    if (!this.ready) return;
    if (
      op === "profile-catalog" ||
      op === "profile-consent" ||
      op === "profile-preview" ||
      op === "profile-preview-result"
    ) {
      if (!this.ready) return;
    }
    if (op === "profile-catalog") {
      const profiles = normalizeCatalog(control.profiles);
      const deviceId = typeof control.deviceId === "string" ? control.deviceId : this.opts.deviceId;
      const deviceName =
        typeof control.deviceName === "string" && control.deviceName.trim()
          ? control.deviceName.trim().slice(0, 120)
          : "peer";
      this.opts.onCatalog?.(profiles, deviceId, deviceName);
      return;
    }
    if (op === "profile-consent") {
      const raw = control.profiles;
      const consent: Record<string, boolean> = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === "boolean") consent[id.toLowerCase()] = value;
        }
      }
      this.opts.onConsent?.(consent);
      return;
    }
    if (op === "profile-preview") {
      void this.answerPreview(control);
      return;
    }
    if (op === "profile-preview-result") {
      const request = String(control.request ?? "");
      const pending = this.pendingPreview.get(request);
      if (!pending) return;
      this.pendingPreview.delete(request);
      clearTimeout(pending.timer);
      if (typeof control.error === "string") {
        pending.resolve(null);
        return;
      }
      const files = Number(control.files);
      const bytes = Number(control.bytes);
      pending.resolve(
        Number.isFinite(files) && Number.isFinite(bytes)
          ? {
              id: String(control.profile ?? ""),
              files: Math.max(0, files),
              bytes: Math.max(0, bytes),
              updatedAt: typeof control.updatedAt === "string" ? control.updatedAt : undefined,
            }
          : null,
      );
      return;
    }
    this.opts.onControl?.(control);
  }

  private async answerPreview(control: Record<string, unknown>): Promise<void> {
    const request = String(control.request ?? "");
    const profile = String(control.profile ?? "").toLowerCase();
    if (!request || !profile) return;
    let preview: ProfilePreview | null = null;
    try {
      preview = (await this.opts.onPreviewRequest?.(profile)) ?? null;
    } catch {
      preview = null;
    }
    if (this.closed) return;
    this.sendControl({
      op: "profile-preview-result",
      request,
      profile,
      ...(preview
        ? { files: preview.files, bytes: preview.bytes, updatedAt: preview.updatedAt }
        : { error: "not available" }),
    });
  }
}
