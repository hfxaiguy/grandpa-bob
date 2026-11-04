/**
 * Desktop/server profile catalog.
 *
 * The bridge keeps one record per synced profile under the state dir, with a
 * stable UUID, the mirror folder and per-device consent. Every mirror folder
 * also carries `.bob-profile.json`, so a folder can be moved or discovered
 * without losing its identity.
 *
 * Existing installs migrate by name: `peers.json` records and
 * `~/.bobkat/folders/<name>` directories become profiles on first read.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "../state-dir.js";
import { defaultMirrorDir, readPeers } from "./store.js";

export interface BridgeProfile {
  id: string;
  name: string;
  /** Absolute folder on this machine. */
  folder: string;
  createdAt: string;
  /** Per paired-device veto. Absent means allow (headless default). */
  allow?: Record<string, boolean>;
}

export interface BridgeProfilesFile {
  version: 1;
  profiles: BridgeProfile[];
}

export interface ProfileManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
}

const PROFILE_RE = /^[a-z0-9._-]{1,64}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANIFEST = ".bob-profile.json";
const PROFILES_FILE = "profiles.json";
const DEVICE_FILE = "device-id";

function validName(name: unknown): name is string {
  return typeof name === "string" && PROFILE_RE.test(name) && name !== "." && name !== "..";
}

function validId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

function manifestPath(folder: string): string {
  return path.join(folder, MANIFEST);
}

export async function readProfileManifest(folder: string): Promise<ProfileManifest | null> {
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath(folder), "utf8")) as Partial<ProfileManifest>;
    if (raw.version === 1 && validId(raw.id) && validName(raw.name)) {
      return {
        version: 1,
        id: raw.id.toLowerCase(),
        name: raw.name,
        createdAt:
          typeof raw.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt))
            ? raw.createdAt
            : new Date().toISOString(),
      };
    }
  } catch {
    /* no manifest yet */
  }
  return null;
}

export async function writeProfileManifest(profile: BridgeProfile): Promise<void> {
  await fs.mkdir(profile.folder, { recursive: true });
  const manifest: ProfileManifest = {
    version: 1,
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt,
  };
  await fs.writeFile(manifestPath(profile.folder), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readFile(): Promise<BridgeProfilesFile> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(PROFILES_FILE), "utf8")) as Partial<BridgeProfilesFile>;
    if (raw.version === 1 && Array.isArray(raw.profiles)) {
      const profiles: BridgeProfile[] = [];
      const seen = new Set<string>();
      for (const entry of raw.profiles) {
        if (!entry || !validId(entry.id) || !validName(entry.name) || typeof entry.folder !== "string") continue;
        if (seen.has(entry.id.toLowerCase())) continue;
        seen.add(entry.id.toLowerCase());
        profiles.push({
          id: entry.id.toLowerCase(),
          name: entry.name,
          folder: entry.folder,
          createdAt:
            typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
          allow:
            entry.allow && typeof entry.allow === "object" && !Array.isArray(entry.allow)
              ? Object.fromEntries(
                  Object.entries(entry.allow).filter((entry): entry is [string, boolean] =>
                    typeof entry[1] === "boolean",
                  ),
                )
              : undefined,
        });
      }
      return { version: 1, profiles };
    }
  } catch {
    /* first boot */
  }
  return { version: 1, profiles: [] };
}

async function writeFile(file: BridgeProfilesFile): Promise<void> {
  const target = statePath(PROFILES_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, target);
}

/** Add one profile (by id or name) and write its folder manifest. */
export async function ensureBridgeProfile(
  name: string,
  opts: { id?: string; folder?: string; createdAt?: string; allow?: Record<string, boolean> } = {},
): Promise<BridgeProfile> {
  if (!validName(name)) throw new Error(`invalid profile name: ${name}`);
  const file = await readFile();
  // An explicit id means "this exact remote profile": never rename a local
  // same-name profile into it. Name lookup is for the migration/CLI path.
  let profile = opts.id
    ? file.profiles.find((entry) => entry.id === opts.id!.toLowerCase())
    : file.profiles.find((entry) => entry.name === name);
  if (!profile) {
    let folder = opts.folder ?? defaultMirrorDir(name);
    // A name collision with a different id gets a suffixed folder; the label
    // stays the profile's own name.
    const taken = new Set(file.profiles.map((entry) => path.resolve(entry.folder)));
    if (taken.has(path.resolve(folder))) folder = path.join(path.dirname(folder), `${name}-${(opts.id ?? randomUUID()).slice(0, 4)}`);
    const manifest = await readProfileManifest(folder);
    profile = {
      id: opts.id?.toLowerCase() ?? manifest?.id ?? randomUUID().toLowerCase(),
      name,
      folder,
      createdAt: opts.createdAt ?? manifest?.createdAt ?? new Date().toISOString(),
      ...(opts.allow ? { allow: opts.allow } : {}),
    };
    file.profiles.push(profile);
    await writeFile(file);
  } else {
    let changed = false;
    if (opts.folder && path.resolve(profile.folder) !== path.resolve(opts.folder)) {
      profile.folder = opts.folder;
      changed = true;
    }
    if (opts.allow) {
      profile.allow = { ...(profile.allow ?? {}), ...opts.allow };
      changed = true;
    }
    if (changed) await writeFile(file);
  }
  await writeProfileManifest(profile);
  return profile;
}

/** Read every profile, adopting peers.json records and folder roots by name. */
export async function listBridgeProfiles(): Promise<BridgeProfile[]> {
  const file = await readFile();
  const byName = new Map(file.profiles.map((entry) => [entry.name, entry]));
  let changed = false;

  const peers = await readPeers();
  for (const [name, record] of Object.entries(peers.peers)) {
    if (!validName(name) || byName.has(name)) continue;
    const folder =
      record.capabilities.mirrorPath ??
      defaultMirrorDir(record.capabilities.mirror ?? name);
    const manifest = await readProfileManifest(folder);
    const profile: BridgeProfile = {
      id: manifest?.id ?? randomUUID().toLowerCase(),
      name,
      folder,
      createdAt: manifest?.createdAt ?? record.pairedAt ?? new Date().toISOString(),
    };
    file.profiles.push(profile);
    byName.set(name, profile);
    changed = true;
  }

  try {
    const root = statePath("folders");
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validName(entry.name) || byName.has(entry.name)) continue;
      const folder = path.join(root, entry.name);
      const manifest = await readProfileManifest(folder);
      const profile: BridgeProfile = {
        id: manifest?.id ?? randomUUID().toLowerCase(),
        name: entry.name,
        folder,
        createdAt: manifest?.createdAt ?? new Date().toISOString(),
      };
      file.profiles.push(profile);
      byName.set(entry.name, profile);
      changed = true;
    }
  } catch {
    /* no folders yet */
  }

  if (changed) await writeFile(file);
  for (const profile of file.profiles) {
    await writeProfileManifest(profile).catch(() => undefined);
  }
  return file.profiles;
}

export async function bridgeProfileById(id: string): Promise<BridgeProfile | null> {
  const profile = (await listBridgeProfiles()).find((entry) => entry.id === id.toLowerCase());
  return profile ?? null;
}

/** Rewrite a profile's UUID after the one-time same-name auto-link. */
export async function relinkBridgeProfile(fromId: string, toId: string): Promise<BridgeProfile | null> {
  const from = fromId.toLowerCase();
  const to = toId.toLowerCase();
  if (!validId(to)) throw new Error(`invalid profile id: ${to}`);
  const file = await readFile();
  if (file.profiles.some((entry) => entry.id === to && entry.id !== from)) {
    throw new Error(`profile id already exists: ${to}`);
  }
  const profile = file.profiles.find((entry) => entry.id === from);
  if (!profile) return null;
  profile.id = to;
  await writeFile(file);
  await writeProfileManifest(profile);
  return profile;
}

/** Reset every device veto for a profile (used by `--revoke`). */
export async function clearBridgeProfileConsent(profileId: string): Promise<void> {
  const file = await readFile();
  const profile = file.profiles.find((entry) => entry.id === profileId.toLowerCase());
  if (!profile || !profile.allow) return;
  delete profile.allow;
  await writeFile(file);
}

export async function setBridgeProfileConsent(
  profileId: string,
  deviceId: string,
  allow: boolean,
): Promise<void> {
  const file = await readFile();
  const profile = file.profiles.find((entry) => entry.id === profileId.toLowerCase());
  if (!profile) return;
  profile.allow = { ...(profile.allow ?? {}), [deviceId]: allow };
  await writeFile(file);
}

/** This bridge's stable device identity (sent in the catalog). */
export async function bridgeDeviceId(): Promise<string> {
  const file = statePath(DEVICE_FILE);
  try {
    const raw = (await fs.readFile(file, "utf8")).trim();
    if (validId(raw)) return raw.toLowerCase();
  } catch {
    /* first boot */
  }
  const id = randomUUID().toLowerCase();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/** Catalog entries exactly as the browser model expects them. */
export async function bridgeCatalog(): Promise<
  Array<{ id: string; name: string; createdAt: string }>
> {
  return (await listBridgeProfiles()).map((profile) => ({
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt,
  }));
}

/** The bridge's own allow-list for one device. Absent means allow. */
export async function bridgeConsent(deviceId: string): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const profile of await listBridgeProfiles()) {
    // "*" is the operator's device-agnostic default set by
    // `npm run pair -- --deny/--allow`.
    out[profile.id] = profile.allow?.[deviceId] ?? profile.allow?.["*"] ?? true;
  }
  return out;
}
