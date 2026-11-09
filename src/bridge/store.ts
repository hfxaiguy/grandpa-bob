/**
 * Persistent server identity and paired-client registry.
 *
 * Everything lives under the state dir (`BOB_STATE_DIR` or `~/.bobkat`):
 *   server-key   — the server's app-level identity key (0600)
 *   admin-key    — loopback admin/CLI key (0600)
 *   peers.json   — { profile: { keyHash, capabilities, pairedAt } }
 *   relay-channels.json — live BobSwap sync channels to resume after a restart
 *   peers/<p>/   — per-profile engine journals
 *   folders/<p>/ — default mirror folders
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "../state-dir.js";

export interface PeerCapabilities {
  /** Registered mirror folder name (defaults to the profile name). */
  mirror?: string;
  /** Absolute folder path on this machine (not sent to browsers). */
  mirrorPath?: string;
  /** Allowlisted executables (ShellTools policy). */
  exec: string[];
}

export interface PeerRecord {
  profile: string;
  keyHash: string;
  capabilities: PeerCapabilities;
  pairedAt: string;
  fingerprint: string;
  /**
   * Profile whose `pair:<profile>` secret produced `fingerprint`. A wildcard
   * pairing uses `*`, so every profile on the device can verify the same
   * server proof after a profile switch.
   */
  proofProfile?: string;
}

export interface PeersFile {
  version: 1;
  serverKey: string;
  serverFingerprint: string;
  peers: Record<string, PeerRecord>;
}

/**
 * A relay signaling channel that outlives the process that created it. BobSwap
 * keeps the channel alive while either role renews it, and the browser stores
 * its half; persisting ours is what makes `npm run bob` restarts free as long
 * as they happen inside the remaining TTL.
 */
export interface RelayChannelRecord {
  baseUrl: string;
  channelId: string;
  roleToken: string;
  /** Profile the browser was on when this pairing completed. */
  profile: string;
  /** `peers.json` key that authenticates the device. */
  authProfile: string;
  capabilities: PeerCapabilities;
  iceServers: unknown[];
  /** ISO-8601 expiry last reported by create/renew (advisory: renew decides). */
  expiresAt?: string;
  savedAt: string;
}

export interface RelayChannelsFile {
  version: 1;
  channels: RelayChannelRecord[];
}

const KEY_FILE = "server-key";
const ADMIN_FILE = "admin-key";
const PEERS_FILE = "peers.json";
const RELAY_FILE = "relay-channels.json";
/** Bound the file: one record per live pairing, oldest pruned first. */
const RELAY_KEEP = 8;

async function readOrCreateSecret(name: string): Promise<string> {
  const file = statePath(name);
  try {
    const raw = (await fs.readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{64}$/.test(raw)) return raw;
  } catch {
    /* first boot */
  }
  const secret = randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/** Server identity key (persisted; reconnects pin its fingerprint). */
export async function serverKey(): Promise<string> {
  return readOrCreateSecret(KEY_FILE);
}

/** Loopback admin key for `npm run pair` (never sent to browsers). */
export async function adminKey(): Promise<string> {
  return readOrCreateSecret(ADMIN_FILE);
}

export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function readPeers(): Promise<PeersFile> {
  const key = await serverKey();
  try {
    const raw = JSON.parse(await fs.readFile(statePath(PEERS_FILE), "utf8")) as Partial<PeersFile>;
    if (raw && raw.version === 1 && raw.peers && typeof raw.peers === "object") {
      return { version: 1, serverKey: key, serverFingerprint: secretFingerprint(key), peers: raw.peers };
    }
  } catch {
    /* first boot */
  }
  return { version: 1, serverKey: key, serverFingerprint: secretFingerprint(key), peers: {} };
}

export async function writePeers(peers: PeersFile): Promise<void> {
  const file = statePath(PEERS_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(peers, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function savePeer(record: PeerRecord): Promise<PeersFile> {
  const peers = await readPeers();
  peers.peers[record.profile] = record;
  await writePeers(peers);
  return peers;
}

export async function removePeer(profile: string): Promise<PeersFile> {
  const peers = await readPeers();
  delete peers.peers[profile];
  await writePeers(peers);
  return peers;
}

function normalizeRelayChannel(raw: unknown): RelayChannelRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.channelId !== "string" || !value.channelId) return null;
  if (typeof value.baseUrl !== "string" || !value.baseUrl) return null;
  if (typeof value.roleToken !== "string" || !value.roleToken) return null;
  if (typeof value.profile !== "string" || !value.profile) return null;
  const caps =
    value.capabilities && typeof value.capabilities === "object"
      ? (value.capabilities as Record<string, unknown>)
      : {};
  return {
    baseUrl: value.baseUrl,
    channelId: value.channelId,
    roleToken: value.roleToken,
    profile: value.profile,
    authProfile:
      typeof value.authProfile === "string" && value.authProfile ? value.authProfile : value.profile,
    capabilities: {
      mirror: typeof caps.mirror === "string" ? caps.mirror : undefined,
      mirrorPath: typeof caps.mirrorPath === "string" ? caps.mirrorPath : undefined,
      exec: Array.isArray(caps.exec) ? caps.exec.map(String) : [],
    },
    iceServers: Array.isArray(value.iceServers) ? value.iceServers : [],
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : undefined,
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date(0).toISOString(),
  };
}

export async function readRelayChannels(): Promise<RelayChannelsFile> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(RELAY_FILE), "utf8")) as Partial<RelayChannelsFile>;
    if (raw && raw.version === 1 && Array.isArray(raw.channels)) {
      return {
        version: 1,
        channels: raw.channels
          .map(normalizeRelayChannel)
          .filter((record): record is RelayChannelRecord => !!record),
      };
    }
  } catch {
    /* first boot */
  }
  return { version: 1, channels: [] };
}

export async function writeRelayChannels(file: RelayChannelsFile): Promise<void> {
  const pathName = statePath(RELAY_FILE);
  await fs.mkdir(path.dirname(pathName), { recursive: true });
  const tmp = `${pathName}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, pathName);
}

/** Upsert a channel (keyed by id) and prune the oldest beyond the cap. */
export async function saveRelayChannel(record: RelayChannelRecord): Promise<void> {
  const file = await readRelayChannels();
  file.channels = file.channels.filter((entry) => entry.channelId !== record.channelId);
  file.channels.push(record);
  file.channels.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  file.channels = file.channels.slice(0, RELAY_KEEP);
  await writeRelayChannels(file);
}

export async function updateRelayChannelExpiry(
  channelId: string,
  expiresAt: string | undefined,
): Promise<void> {
  const file = await readRelayChannels();
  const record = file.channels.find((entry) => entry.channelId === channelId);
  if (!record) return;
  if (expiresAt) record.expiresAt = expiresAt;
  record.savedAt = new Date().toISOString();
  await writeRelayChannels(file);
}

export async function removeRelayChannel(channelId: string): Promise<void> {
  const file = await readRelayChannels();
  const next = file.channels.filter((entry) => entry.channelId !== channelId);
  if (next.length === file.channels.length) return;
  file.channels = next;
  await writeRelayChannels(file);
}

/** Revoking a profile also forgets any relay channel that authenticated it. */
export async function removeRelayChannelsForProfile(profile: string): Promise<void> {
  const file = await readRelayChannels();
  const next = file.channels.filter(
    (entry) => entry.authProfile !== profile && entry.profile !== profile,
  );
  if (next.length === file.channels.length) return;
  file.channels = next;
  await writeRelayChannels(file);
}

export function defaultMirrorDir(profile: string): string {
  return statePath("folders", profile);
}

export function peerJournalDir(profile: string): string {
  return statePath("peers", profile);
}

/**
 * The desktop copy of a profile's run log (fed by the paired tab's log event
 * stream, see `peer-log.ts`). Deliberately outside the mirror folder: the tab
 * stays the only writer of `logs/grandma-kat.db`, and the mirror folder must
 * remain a plain synced copy.
 */
export function peerLogPath(profile: string): string {
  // Defense in depth: every current caller validates first, but this path is a
  // filesystem boundary (statePath joins segments without a sandbox).
  if (!/^[a-z0-9._-]{1,64}$/.test(profile) || profile === "." || profile === "..") {
    throw new Error("invalid profile name");
  }
  return statePath("peers", profile, "logs", "grandma-kat.db");
}
