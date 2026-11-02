/**
 * Persistent server identity and paired-client registry.
 *
 * Everything lives under the state dir (`BOB_STATE_DIR` or `~/.bobkat`):
 *   server-key   — the server's app-level identity key (0600)
 *   admin-key    — loopback admin/CLI key (0600)
 *   peers.json   — { profile: { keyHash, capabilities, pairedAt } }
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
}

export interface PeersFile {
  version: 1;
  serverKey: string;
  serverFingerprint: string;
  peers: Record<string, PeerRecord>;
}

const KEY_FILE = "server-key";
const ADMIN_FILE = "admin-key";
const PEERS_FILE = "peers.json";

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
