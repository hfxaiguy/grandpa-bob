/**
 * Pure profile-sync model: catalogs, one-time auto-linking, consent and the
 * flattened rows the Profiles dialog renders.
 *
 * The model deliberately keeps the wire catalog tiny: id, name and createdAt
 * (createdAt only exists for the one-time same-name link decision). Presence is
 * derived locally by comparing catalogs.
 */
/** Kept local so the Node bridge can import this module without the browser layer. */
const PROFILE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidProfileId(id: unknown): id is string {
  return typeof id === "string" && PROFILE_ID_RE.test(id);
}

/** The wire catalog shape (structurally the same as profiles.ts's entry). */
export interface ProfileCatalogEntry {
  id: string;
  name: string;
  createdAt: string;
}

/** Only the registry fields the dialog reads; ProfileRecord satisfies this. */
export interface LocalProfileLike {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  kind?: "opfs" | "desktop";
  folder?: string;
  visibleApps?: string[];
  seed?: { account: string; seedName: string };
}

export interface PeerProfileCatalog {
  peerId: string;
  deviceName: string;
  lastSeen: string;
  /** Whether this peer held an authenticated link at the last update. */
  online?: boolean;
  profiles: ProfileCatalogEntry[];
  /** This browser's veto for each profile id on this peer. */
  localAllow: Record<string, boolean>;
  /** The peer's veto, as last reported. */
  remoteAllow: Record<string, boolean>;
  /** Names already considered by the one-time auto-link rule. */
  linkedNames: string[];
  /** Profile ids the user explicitly unlinked; never auto-link them again. */
  unlinkedIds: string[];
}

export interface PeerSyncStore {
  version: 1;
  peers: Record<string, PeerProfileCatalog>;
}

export const DEVICE_ID_KEY = "bob:device-id";
export const DEVICE_NAME_KEY = "bob:device-name";
export const PEER_SYNC_KEY = "bob:profile-peers";

/** Human name this browser shows to paired peers (not an identity). */
export function normalizeDeviceName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").slice(0, 80);
}

export function loadDeviceName(
  storage: Storage | undefined = globalThis.localStorage,
): string {
  try {
    return normalizeDeviceName(storage?.getItem(DEVICE_NAME_KEY));
  } catch {
    return "";
  }
}

export function saveDeviceName(
  name: string,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  const value = normalizeDeviceName(name);
  try {
    if (value) storage?.setItem(DEVICE_NAME_KEY, value);
    else storage?.removeItem(DEVICE_NAME_KEY);
  } catch {
    /* private mode: the name lasts for this tab only */
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validCatalogEntry(raw: unknown): ProfileCatalogEntry | null {
  if (!isRecord(raw)) return null;
  if (!isValidProfileId(raw.id) || typeof raw.name !== "string" || !raw.name.trim()) return null;
  return {
    id: raw.id.toLowerCase(),
    name: raw.name.trim().slice(0, 64),
    createdAt:
      typeof raw.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt))
        ? raw.createdAt
        : new Date(0).toISOString(),
  };
}

export function normalizeCatalog(raw: unknown): ProfileCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ProfileCatalogEntry[] = [];
  for (const entry of raw) {
    const valid = validCatalogEntry(entry);
    if (!valid || seen.has(valid.id)) continue;
    seen.add(valid.id);
    out.push(valid);
  }
  return out;
}

export function emptyPeerStore(): PeerSyncStore {
  return { version: 1, peers: {} };
}

export function parsePeerStore(raw: unknown): PeerSyncStore {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.peers)) return emptyPeerStore();
  const peers: Record<string, PeerProfileCatalog> = {};
  for (const [peerId, value] of Object.entries(raw.peers)) {
    if (!isRecord(value)) continue;
    peers[peerId] = {
      peerId,
      deviceName: typeof value.deviceName === "string" ? value.deviceName : "peer",
      lastSeen: typeof value.lastSeen === "string" ? value.lastSeen : new Date(0).toISOString(),
      online: value.online === true,
      profiles: normalizeCatalog(value.profiles),
      localAllow: boolMap(value.localAllow),
      remoteAllow: boolMap(value.remoteAllow),
      linkedNames: stringList(value.linkedNames),
      unlinkedIds: stringList(value.unlinkedIds),
    };
  }
  return { version: 1, peers };
}

function boolMap(raw: unknown): Record<string, boolean> {
  if (!isRecord(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isValidProfileId(key) && typeof value === "boolean") out[key.toLowerCase()] = value;
  }
  return out;
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((value): value is string => typeof value === "string"))]
    : [];
}

export function loadPeerStore(storage: Storage | undefined = globalThis.localStorage): PeerSyncStore {
  try {
    const raw = storage?.getItem(PEER_SYNC_KEY);
    return raw ? parsePeerStore(JSON.parse(raw)) : emptyPeerStore();
  } catch {
    return emptyPeerStore();
  }
}

export function savePeerStore(
  store: PeerSyncStore,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(PEER_SYNC_KEY, JSON.stringify(store));
  } catch {
    /* private mode: consent survives only for this tab */
  }
}

export function ensureDeviceId(storage: Storage | undefined = globalThis.localStorage): string {
  try {
    const existing = storage?.getItem(DEVICE_ID_KEY);
    if (existing && /^[0-9a-f-]{16,64}$/i.test(existing)) return existing;
  } catch {
    /* private mode */
  }
  const id = globalThis.crypto?.randomUUID?.() ?? `device-${Math.random().toString(16).slice(2)}`;
  try {
    storage?.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

/** The profile id both sides should converge on for a same-name pair. */
export function canonicalProfileId(
  local: ProfileCatalogEntry,
  remote: ProfileCatalogEntry,
): string {
  const left = Date.parse(local.createdAt);
  const right = Date.parse(remote.createdAt);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
    return left < right ? local.id : remote.id;
  }
  return local.id.toLowerCase() <= remote.id.toLowerCase() ? local.id : remote.id;
}

export interface AutoLink {
  /** Canonical id both sides converge on. */
  id: string;
  /** Id the local registry must rewrite, when it differs. */
  adoptLocal?: { from: string; to: string };
  /** The remote id this catalog entry is keyed by before the rewrite. */
  remoteId: string;
  name: string;
}

/**
 * One-time same-name auto-link. Ids that already match are already linked;
 * names recorded in `linkedNames` are never reconsidered, and ids in
 * `unlinkedIds` are left alone.
 */
export function autoLinkProfiles(
  local: ProfileCatalogEntry[],
  remote: ProfileCatalogEntry[],
  state: Pick<PeerProfileCatalog, "linkedNames" | "unlinkedIds">,
): AutoLink[] {
  const localById = new Map(local.map((entry) => [entry.id.toLowerCase(), entry]));
  const localByName = new Map(local.map((entry) => [entry.name.toLowerCase(), entry]));
  const linkedNames = new Set(state.linkedNames.map((name) => name.toLowerCase()));
  const unlinked = new Set(state.unlinkedIds.map((id) => id.toLowerCase()));
  const out: AutoLink[] = [];
  for (const remoteEntry of remote) {
    const remoteId = remoteEntry.id.toLowerCase();
    if (localById.has(remoteId)) continue;
    if (unlinked.has(remoteId)) continue;
    const nameKey = remoteEntry.name.toLowerCase();
    if (linkedNames.has(nameKey)) continue;
    const localEntry = localByName.get(nameKey);
    if (!localEntry) continue;
    if (unlinked.has(localEntry.id.toLowerCase())) continue;
    const id = canonicalProfileId(localEntry, remoteEntry).toLowerCase();
    out.push({
      id,
      remoteId,
      name: localEntry.name,
      adoptLocal:
        localEntry.id.toLowerCase() === id ? undefined : { from: localEntry.id, to: id },
    });
  }
  return out;
}

export function sameProfileId(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Effective sync for one profile on one peer: both vetoes must be open. */
export function effectiveAllow(
  localAllow: Record<string, boolean>,
  remoteAllow: Record<string, boolean>,
  profileId: string,
  fallback = false,
): boolean {
  const id = profileId.toLowerCase();
  return (localAllow[id] ?? fallback) && (remoteAllow[id] ?? fallback);
}

/** Initial local consent after a catalog arrives: linked ids start open. */
export function defaultLocalConsent(
  catalog: ProfileCatalogEntry[],
  remote: ProfileCatalogEntry[],
  existing: Record<string, boolean> = {},
): Record<string, boolean> {
  const remoteIds = new Set(remote.map((entry) => entry.id.toLowerCase()));
  const out: Record<string, boolean> = { ...existing };
  for (const entry of catalog) {
    const id = entry.id.toLowerCase();
    if (!(id in out)) out[id] = remoteIds.has(id);
  }
  return out;
}

export interface ProfilePeerRow {
  peerId: string;
  deviceName: string;
  /** The profile exists on this peer. */
  present: boolean;
  localAllow: boolean;
  remoteAllow: boolean;
  /** Effective sync for this profile × peer. */
  allowed: boolean;
}

export interface ProfileRow {
  id: string;
  name: string;
  local?: LocalProfileLike;
  /** True when this browser has no workspace for the profile. */
  remoteOnly: boolean;
  peers: ProfilePeerRow[];
}

/**
 * Flatten the local registry and every paired peer's catalog into the rows the
 * Profiles dialog shows. Remote-only rows are included with `local` absent.
 */
export function buildProfileRows(
  local: LocalProfileLike[],
  peers: PeerProfileCatalog[],
): ProfileRow[] {
  const rows = new Map<string, ProfileRow>();
  for (const record of local) {
    const id = record.id.toLowerCase();
    rows.set(id, { id, name: record.name, local: record, remoteOnly: false, peers: [] });
  }
  for (const peer of peers) {
    const remoteIds = new Set(peer.profiles.map((entry) => entry.id.toLowerCase()));
    for (const entry of peer.profiles) {
      const id = entry.id.toLowerCase();
      let row = rows.get(id);
      if (!row) {
        row = { id, name: entry.name, remoteOnly: true, peers: [] };
        rows.set(id, row);
      }
      row.peers.push({
        peerId: peer.peerId,
        deviceName: peer.deviceName,
        present: true,
        localAllow: peer.localAllow[id] === true,
        remoteAllow: peer.remoteAllow[id] === true,
        allowed: effectiveAllow(peer.localAllow, peer.remoteAllow, id),
      });
    }
    // Local profiles this peer does not have still get a peer row so the user
    // can see the checkbox and why nothing is transferring.
    for (const row of rows.values()) {
      if (!row.local) continue;
      if (row.peers.some((p) => p.peerId === peer.peerId)) continue;
      row.peers.push({
        peerId: peer.peerId,
        deviceName: peer.deviceName,
        present: remoteIds.has(row.id),
        localAllow: peer.localAllow[row.id] === true,
        remoteAllow: peer.remoteAllow[row.id] === true,
        allowed: effectiveAllow(peer.localAllow, peer.remoteAllow, row.id),
      });
    }
  }
  // Peers that only exist remotely have no local row and no stale entries.
  return [...rows.values()].sort((a, b) => {
    if (a.remoteOnly !== b.remoteOnly) return a.remoteOnly ? 1 : -1;
    if (a.name === "default") return -1;
    if (b.name === "default") return 1;
    return a.name.localeCompare(b.name);
  });
}

/** One row in the "paired devices" list. */
export interface PairedDeviceRow {
  peerId: string;
  deviceName: string;
  online: boolean;
  lastSeen: string;
  profiles: ProfileCatalogEntry[];
}

/**
 * Every device this browser has paired with, connected first and then by most
 * recent contact. The peer store is device-wide, so the list spans profiles.
 */
export function pairedDevices(store: PeerSyncStore): PairedDeviceRow[] {
  const seenAt = (iso: string): number => {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return Object.values(store.peers)
    .map((peer) => ({
      peerId: peer.peerId,
      deviceName: normalizeDeviceName(peer.deviceName) || "peer",
      online: peer.online === true,
      lastSeen: peer.lastSeen,
      profiles: [...peer.profiles].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      const recency = seenAt(b.lastSeen) - seenAt(a.lastSeen);
      return recency || a.deviceName.localeCompare(b.deviceName);
    });
}

/** One-time defaults for a freshly paired peer. */
export function upsertPeer(
  store: PeerSyncStore,
  input: {
    peerId: string;
    deviceName: string;
    profiles: ProfileCatalogEntry[];
    catalog: ProfileCatalogEntry[];
    links: AutoLink[];
  },
): PeerSyncStore {
  const existing = store.peers[input.peerId];
  const linksById = new Map(input.links.map((link) => [link.remoteId, link]));
  const linkedNames = new Set(existing?.linkedNames ?? []);
  const unlinkedIds = new Set(existing?.unlinkedIds ?? []);
  for (const link of input.links) {
    linkedNames.add(link.name);
    if (link.adoptLocal) unlinkedIds.add(link.adoptLocal.from);
  }
  // Map remote catalog ids onto the canonical id the local side adopted, so
  // consent and presence keep lining up after an auto-link rewrite.
  const profiles = input.profiles.map((entry) => {
    const link = linksById.get(entry.id.toLowerCase());
    return link && link.id !== entry.id ? { ...entry, id: link.id } : entry;
  });
  // The local registry may not have been rewritten yet by the caller; map the
  // local catalog through the same auto-link decisions before defaulting
  // consent, so an adopted id does not look remote-only for one pass.
  const adopt = new Map(
    input.links
      .filter((link): link is AutoLink & { adoptLocal: { from: string; to: string } } =>
        !!link.adoptLocal,
      )
      .map((link) => [link.adoptLocal.from.toLowerCase(), link.adoptLocal.to]),
  );
  const localCatalog = input.catalog.map((entry) => {
    const to = adopt.get(entry.id.toLowerCase());
    return to ? { ...entry, id: to } : entry;
  });
  const localAllow = defaultLocalConsent(
    localCatalog,
    profiles,
    existing?.localAllow ?? {},
  );
  const remoteAllow = { ...(existing?.remoteAllow ?? {}) };
  // Never invent the peer's consent: it arrives as its own message and until
  // then the profile is not allowed (both vetoes must be explicit).
  for (const entry of profiles) {
    if (!(entry.id in remoteAllow)) remoteAllow[entry.id] = false;
  }
  return {
    version: 1,
    peers: {
      ...store.peers,
      [input.peerId]: {
        peerId: input.peerId,
        deviceName: input.deviceName,
        lastSeen: new Date().toISOString(),
        online: true,
        profiles,
        localAllow,
        remoteAllow,
        linkedNames: [...linkedNames],
        unlinkedIds: [...unlinkedIds],
      },
    },
  };
}

/** Migrate consent after a local registry id rewrite. */
export function remapPeerConsent(store: PeerSyncStore, fromId: string, toId: string): PeerSyncStore {
  const from = fromId.toLowerCase();
  const to = toId.toLowerCase();
  const peers: Record<string, PeerProfileCatalog> = {};
  for (const [peerId, peer] of Object.entries(store.peers)) {
    const localAllow = { ...peer.localAllow };
    const remoteAllow = { ...peer.remoteAllow };
    if (from in localAllow) {
      localAllow[to] = localAllow[to] ?? localAllow[from];
      delete localAllow[from];
    }
    if (from in remoteAllow) {
      remoteAllow[to] = remoteAllow[to] ?? remoteAllow[from];
      delete remoteAllow[from];
    }
    peers[peerId] = { ...peer, localAllow, remoteAllow };
  }
  return { version: 1, peers };
}

/** The peer-side consent map to send on the wire (own vetoes only). */
export function consentPayload(peer: PeerProfileCatalog | undefined): Record<string, boolean> {
  return { ...(peer?.localAllow ?? {}) };
}

/** Preview metadata for a remote-only profile (requested on demand). */
export interface ProfilePreview {
  id: string;
  files: number;
  bytes: number;
  updatedAt?: string;
}
