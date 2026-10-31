/**
 * Browser workspace profiles.
 *
 * Every profile is a self-contained workspace directory under
 * `/profiles/<name>/` in OPFS (the origin's private file system). The fs root
 * (`platform/opfs-root.ts`) is rebound to that directory, so the agent, sqlite,
 * git, shells and the transfer tools all keep operating on `/workspace/...`
 * without knowing profiles exist.
 *
 * `/profiles.json` at the origin root is the registry; the active profile name
 * lives in localStorage (`bob:profile`) and is applied on the next reload.
 *
 * Migration: an installation from before profiles (data directly in the OPFS
 * root) is moved into `/profiles/default/` once. The move is guarded by a
 * progress marker so an interrupted boot resumes instead of duplicating or
 * losing files, and it never deletes the originals before the copy verifies.
 */
import {
  importWorkspace,
  summarizeWorkspace,
  validateWorkspaceArchive,
  type WorkspaceArchive,
} from "./workspace-transfer";

export const DEFAULT_PROFILE = "default";
export const PROFILE_DIR = "profiles";
export const REGISTRY_FILE = "profiles.json";
export const MIGRATION_FILE = "migration.json";
const ACTIVE_KEY = "bob:profile";

/** Directory iteration is available in browsers but missing from some DOM libs. */
interface IterableDirHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

/** Profile names are safe path segments (and match the seed-service charset). */
const PROFILE_NAME_RE = /^[a-z0-9._-]{1,64}$/;

export interface SeedVersionRef {
  /** The seed service's `[seed-id-and-version]` segment. */
  version: string;
  sha256: string;
  /** The archive's own createdAt (what freshness checks compare). */
  createdAt: string;
  /** Last time this profile checked the service for a newer build. */
  checkedAt?: string;
}

/** A seed on a BobSwap service that this profile tracks for updates. */
export interface SeedBinding {
  baseUrl: string;
  account: string;
  seedName: string;
  lastVersion?: SeedVersionRef;
}

export interface ProfileRecord {
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  seed?: SeedBinding;
  /**
   * The workspace always lives in this origin's OPFS. `kind: "desktop"` binds
   * a synced mirror folder on the machine running the storage bridge —
   * `folder` names a root registered there (`POST /roots`), resolved by the
   * bridge per request via the `x-bob-root` header. The folder is a copy, not
   * the live workspace; OPFS remains canonical.
   */
  kind?: "opfs" | "desktop";
  folder?: string;
}

export interface ProfileRegistry {
  version: 1;
  profiles: ProfileRecord[];
}

interface MigrationMarker {
  version: 1;
  startedAt: string;
  /** Archive-relative paths already copied into `/profiles/default/`. */
  copied: string[];
}

// ── pure helpers (unit-tested outside the browser) ───────────────────────

export function isValidProfileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    PROFILE_NAME_RE.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

/** Seed-service path segments are slugs; `latest` is reserved on the service. */
export function isValidSeedName(name: unknown): name is string {
  return isValidProfileName(name) && name !== "latest";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validSeedBinding(raw: unknown): SeedBinding | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim()) return null;
  if (!isValidSeedName(raw.account) || !isValidSeedName(raw.seedName)) return null;
  const binding: SeedBinding = {
    baseUrl: raw.baseUrl.replace(/\/+$/, ""),
    account: raw.account,
    seedName: raw.seedName,
  };
  const last = raw.lastVersion;
  if (isRecord(last) && typeof last.version === "string" && typeof last.sha256 === "string") {
    binding.lastVersion = {
      version: last.version,
      sha256: last.sha256,
      createdAt: typeof last.createdAt === "string" ? last.createdAt : "",
      checkedAt: typeof last.checkedAt === "string" ? last.checkedAt : undefined,
    };
  }
  return binding;
}

/** Validate a parsed `/profiles.json`; throws a user-facing message. */
export function parseProfileRegistry(raw: unknown): ProfileRegistry {
  if (!isRecord(raw)) throw new Error("not a profile registry (expected a JSON object)");
  if (raw.version !== 1) throw new Error(`unsupported profile registry version: ${String(raw.version)}`);
  if (!Array.isArray(raw.profiles)) throw new Error("profile registry is missing the profiles list");
  const seen = new Set<string>();
  const profiles = raw.profiles.map((entry, index): ProfileRecord => {
    if (!isRecord(entry)) throw new Error(`profile entry ${index}: not an object`);
    if (!isValidProfileName(entry.name)) throw new Error(`profile entry ${index}: invalid name`);
    if (seen.has(entry.name)) throw new Error(`profile entry ${index}: duplicate name ${entry.name}`);
    seen.add(entry.name);
    const record: ProfileRecord = {
      name: entry.name,
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
    };
    if (typeof entry.lastUsedAt === "string") record.lastUsedAt = entry.lastUsedAt;
    const binding = validSeedBinding(entry.seed);
    if (binding) record.seed = binding;
    if (entry.kind === "desktop") {
      // A desktop profile's workspace is a bridge folder, not OPFS storage:
      // the OPFS directory (if any) only holds this profile's run log.
      if (!isValidProfileName(entry.folder)) {
        throw new Error(`profile entry ${index}: desktop profile needs a valid folder name`);
      }
      record.kind = "desktop";
      record.folder = entry.folder;
    } else if (entry.kind === "opfs") {
      record.kind = "opfs";
    }
    return record;
  });
  if (!seen.has(DEFAULT_PROFILE)) {
    profiles.unshift({ name: DEFAULT_PROFILE, createdAt: new Date().toISOString() });
  }
  return { version: 1, profiles };
}

/** Archive directory segments for a profile, e.g. `["profiles", "default"]`. */
export function profileSegmentsFor(name: string): string[] {
  if (!isValidProfileName(name)) throw new Error(`invalid profile name: ${name}`);
  return [PROFILE_DIR, name];
}

/** `2026-10-23T00:57:33.870Z` → `20261023T005733Z` (version-segment safe). */
export function compactTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${iso}`);
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

/**
 * The seed version segment the service validates: the first 12 hex of the
 * archive sha plus its compact createdAt, e.g. `3f9a1b2c4d5e-20261023T005733Z`.
 */
export function seedVersionTag(sha256: string, createdAt: string): string {
  const sha = String(sha256).toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(sha)) throw new Error("invalid sha256 for a seed version tag");
  return `${sha.slice(0, 12)}-${compactTimestamp(createdAt)}`;
}

/** Replace a profile record immutably (pure; used by the registry mutators). */
export function patchRegistry(
  registry: ProfileRegistry,
  name: string,
  patch: (record: ProfileRecord) => ProfileRecord | null,
): ProfileRegistry {
  const index = registry.profiles.findIndex((profile) => profile.name === name);
  if (index === -1) throw new Error(`unknown profile: ${name}`);
  const next = patch(registry.profiles[index]);
  const profiles = [...registry.profiles];
  if (next === null) profiles.splice(index, 1);
  else profiles[index] = next;
  return { version: 1, profiles };
}

// ── OPFS side ────────────────────────────────────────────────────────────

async function originRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function hasEntry(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    /* fall through */
  }
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<unknown | null> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writeJsonFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(`${JSON.stringify(value, null, 2)}\n`);
  await writable.close();
}

/** Write a raw text file through a directory handle (no fs binding). */
async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/**
 * `profiles.json` is tiny but is rewritten on boot (lastUsedAt) and on every
 * profile change. In Gecko a `createWritable()` can wedge or be torn down by a
 * reload between the truncate and the close, leaving a zero-byte file — which
 * reads as "no registry" and silently drops every profile (and its seed
 * binding). localStorage is atomic, so the registry keeps a mirror there:
 * written before the file, used when the file is missing/corrupt, and the
 * trigger for repairing the file on the next boot.
 */
const REGISTRY_MIRROR_KEY = "bob:profile-registry";

function readRegistryMirror(): ProfileRegistry | null {
  try {
    const raw = localStorage.getItem(REGISTRY_MIRROR_KEY);
    return raw ? parseProfileRegistry(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeRegistryMirror(registry: ProfileRegistry): void {
  try {
    localStorage.setItem(REGISTRY_MIRROR_KEY, JSON.stringify(registry));
  } catch {
    /* private mode / quota: the OPFS file is still the primary copy */
  }
}

/** The registry as stored in OPFS, without the localStorage fallback. */
async function readRegistryFile(): Promise<ProfileRegistry | null> {
  const raw = await readJsonFile(await originRoot(), REGISTRY_FILE);
  if (raw === null) return null;
  try {
    return parseProfileRegistry(raw);
  } catch {
    // A corrupt file must not read as a pre-profile install (that would drop
    // every registered profile); the mirror/directory scan recovers instead.
    return null;
  }
}

/**
 * Rebuild a registry from the profile directories when both the file and the
 * mirror are unusable. Names survive; seed bindings cannot be recovered.
 */
async function registryFromDirs(): Promise<ProfileRegistry | null> {
  let root: FileSystemDirectoryHandle;
  let profilesDir: FileSystemDirectoryHandle;
  try {
    root = await originRoot();
    profilesDir = await root.getDirectoryHandle(PROFILE_DIR);
  } catch {
    return null;
  }
  const names: string[] = [];
  for await (const [name, handle] of (profilesDir as unknown as IterableDirHandle).entries()) {
    if (handle.kind === "directory" && isValidProfileName(name) && !names.includes(name)) {
      names.push(name);
    }
  }
  if (!names.length) return null;
  if (!names.includes(DEFAULT_PROFILE)) names.unshift(DEFAULT_PROFILE);
  const mirror = readRegistryMirror();
  return {
    version: 1,
    profiles: names.map(
      (name) =>
        mirror?.profiles.find((profile) => profile.name === name) ?? {
          name,
          createdAt: new Date().toISOString(),
        },
    ),
  };
}

/** Read the registry, or null when the installation predates profiles. */
export async function readRegistry(): Promise<ProfileRegistry | null> {
  return (await readRegistryFile()) ?? readRegistryMirror();
}

export async function writeRegistry(registry: ProfileRegistry): Promise<void> {
  // Mirror first: if the OPFS write is interrupted, the next boot still knows
  // every profile and can put the file back.
  writeRegistryMirror(registry);
  await writeJsonFile(await originRoot(), REGISTRY_FILE, registry);
}

export async function profileHandle(
  name: string,
  create = true,
): Promise<FileSystemDirectoryHandle> {
  let dir = await originRoot();
  for (const part of profileSegmentsFor(name)) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

/** The active profile name, validated against the registry (default fallback). */
export function resolveActiveProfileName(registry: ProfileRegistry): string {
  let stored = "";
  try {
    stored = localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    /* private mode */
  }
  const exists = (name: string): boolean => registry.profiles.some((p) => p.name === name);
  if (isValidProfileName(stored) && exists(stored)) return stored;
  return DEFAULT_PROFILE;
}

export function activateProfile(name: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, name);
  } catch {
    /* private mode: the swap applies to this boot only */
  }
}

/** Mark a profile as used now (registry write). */
export async function touchProfile(name: string): Promise<ProfileRegistry> {
  const registry = await loadRegistry();
  const next = patchRegistry(registry, name, (record) => ({
    ...record,
    lastUsedAt: new Date().toISOString(),
  }));
  try {
    await writeRegistry(next);
  } catch (err) {
    // lastUsedAt is cosmetic. A wedged browser storage backend reports this
    // as a bare failure (Gecko: `UnknownError: Unknown failure`), and failing
    // boot over a timestamp write would take the whole app down. One retry
    // clears a transient lock from a just-torn-down page; beyond that, boot
    // with the in-memory registry and let the next registry write land it.
    await sleep(300);
    try {
      await writeRegistry(next);
    } catch (retryErr) {
      console.warn("could not touch the profile registry", retryErr);
    }
  }
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadRegistry(): Promise<ProfileRegistry> {
  const registry = await readRegistry();
  if (!registry) throw new Error("no profile registry — run bootProfiles() first");
  return registry;
}

// ── migration ────────────────────────────────────────────────────────────

const RESERVED_ROOT_ENTRIES = new Set([PROFILE_DIR, REGISTRY_FILE, MIGRATION_FILE]);

async function rootEntryNames(): Promise<string[]> {
  const root = await originRoot();
  const names: string[] = [];
  for await (const [name] of (root as unknown as IterableDirHandle).entries()) {
    names.push(name);
  }
  return names.filter((name) => !RESERVED_ROOT_ENTRIES.has(name));
}

async function readMarker(): Promise<MigrationMarker | null> {
  const raw = await readJsonFile(await originRoot(), MIGRATION_FILE);
  if (!isRecord(raw) || raw.version !== 1) return null;
  return {
    version: 1,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : new Date().toISOString(),
    copied: Array.isArray(raw.copied) ? raw.copied.filter((p): p is string => typeof p === "string") : [],
  };
}

async function saveMarker(marker: MigrationMarker): Promise<void> {
  await writeJsonFile(await originRoot(), MIGRATION_FILE, marker);
}

async function copyInto(
  srcDir: FileSystemDirectoryHandle,
  dstDir: FileSystemDirectoryHandle,
  prefix: string,
  marker: MigrationMarker,
): Promise<void> {
  for await (const [name, handle] of (srcDir as unknown as IterableDirHandle).entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      const srcChild = await srcDir.getDirectoryHandle(name);
      const dstChild = await dstDir.getDirectoryHandle(name, { create: true });
      await copyInto(srcChild, dstChild, rel, marker);
      continue;
    }
    if (marker.copied.includes(rel)) continue;
    const file = await (await srcDir.getFileHandle(name)).getFile();
    const target = await dstDir.getFileHandle(name, { create: true });
    const writable = await target.createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();
    marker.copied.push(rel);
    await saveMarker(marker);
  }
}

async function removeRootEntries(names: string[]): Promise<void> {
  const root = await originRoot();
  for (const name of names) {
    await root.removeEntry(name, { recursive: true });
  }
}

async function migrate(rootNames: string[], marker: MigrationMarker): Promise<ProfileRegistry> {
  const root = await originRoot();
  const profilesDir = await root.getDirectoryHandle(PROFILE_DIR, { create: true });
  const dest = await profilesDir.getDirectoryHandle(DEFAULT_PROFILE, { create: true });

  await saveMarker(marker);
  for (const name of rootNames) {
    const kind = await root.getDirectoryHandle(name).then(
      () => "directory" as const,
      () => "file" as const,
    );
    if (kind === "directory") {
      const srcDir = await root.getDirectoryHandle(name);
      const dstDir = await dest.getDirectoryHandle(name, { create: true });
      await copyInto(srcDir, dstDir, name, marker);
    } else if (!marker.copied.includes(name)) {
      const file = await (await root.getFileHandle(name)).getFile();
      const target = await dest.getFileHandle(name, { create: true });
      const writable = await target.createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      marker.copied.push(name);
      await saveMarker(marker);
    }
  }

  // Verify before deleting anything. One extra copy pass covers files that a
  // failed earlier boot left out; a second mismatch aborts the boot instead of
  // destroying data.
  let source = await summarizeRoot(rootNames);
  let copy = await summarizeWorkspace(dest);
  if (source.files !== copy.files || source.bytes !== copy.bytes) {
    for (const name of rootNames) {
      const srcDir = await root.getDirectoryHandle(name).catch(() => null);
      if (srcDir) await copyInto(srcDir, dest, name, marker);
      else if (!marker.copied.includes(name)) {
        const file = await (await root.getFileHandle(name)).getFile();
        const target = await dest.getFileHandle(name, { create: true });
        const writable = await target.createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();
        marker.copied.push(name);
        await saveMarker(marker);
      }
    }
    source = await summarizeRoot(rootNames);
    copy = await summarizeWorkspace(dest);
    if (source.files !== copy.files || source.bytes !== copy.bytes) {
      throw new Error(
        `profile migration verification failed (${source.files} files/${source.bytes} B vs ` +
          `${copy.files} files/${copy.bytes} B) — originals kept; fix or remove ` +
          `/${MIGRATION_FILE} to retry`,
      );
    }
  }

  await removeRootEntries(rootNames);
  const registry: ProfileRegistry = {
    version: 1,
    profiles: [{ name: DEFAULT_PROFILE, createdAt: marker.startedAt, lastUsedAt: new Date().toISOString() }],
  };
  await writeRegistry(registry);
  await root.removeEntry(MIGRATION_FILE).catch(() => undefined);
  return registry;
}

async function summarizeRoot(names: string[]): Promise<{ files: number; bytes: number }> {
  const root = await originRoot();
  let files = 0;
  let bytes = 0;
  for (const name of names) {
    const dir = await root.getDirectoryHandle(name).catch(() => null);
    if (dir) {
      const sum = await summarizeWorkspace(dir);
      files += sum.files;
      bytes += sum.bytes;
    } else {
      const file = await (await root.getFileHandle(name)).getFile();
      files++;
      bytes += file.size;
    }
  }
  return { files, bytes };
}

/**
 * Prepare the installation for profiles and return the registry.
 *
 * - existing registry: returned as-is (default guaranteed by the parser);
 * - pre-profile data: moved into `/profiles/default/` (guarded, resumable);
 * - missing/corrupt registry after migration: rebuilt from the profile
 *   directories and the localStorage mirror (never silently reset);
 * - fresh install: an empty `default` profile is registered.
 */
export async function bootProfiles(): Promise<{
  registry: ProfileRegistry;
  migrated: boolean;
  resumed: boolean;
}> {
  const onDisk = await readRegistryFile();
  if (onDisk) {
    await profileHandle(DEFAULT_PROFILE);
    return { registry: onDisk, migrated: false, resumed: false };
  }

  // A pre-profile installation (or an interrupted migration) must still take
  // the migration path; only once the origin root is clean can the profile
  // directories be trusted as the recovered registry.
  const marker = await readMarker();
  const rootNames = await rootEntryNames();
  if (marker || rootNames.length > 0) {
    const registry = await migrate(
      rootNames,
      marker ?? { version: 1, startedAt: new Date().toISOString(), copied: [] },
    );
    return { registry, migrated: true, resumed: marker !== null };
  }

  // Missing/corrupt registry with migrated data: rebuild it from the profile
  // directories (and the mirror, for seed bindings) instead of treating the
  // installation as fresh. Losing the file must not lose the profiles.
  const recovered = (await registryFromDirs()) ?? readRegistryMirror();
  if (recovered) {
    await profileHandle(DEFAULT_PROFILE);
    try {
      await writeRegistry(recovered);
    } catch (err) {
      // Boot with the recovered registry; the mirror still carries it and the
      // next boot retries the file.
      console.warn("could not repair profiles.json", err);
    }
    return { registry: recovered, migrated: false, resumed: false };
  }

  const registry: ProfileRegistry = {
    version: 1,
    profiles: [{ name: DEFAULT_PROFILE, createdAt: new Date().toISOString() }],
  };
  await profileHandle(DEFAULT_PROFILE);
  await writeRegistry(registry);
  return { registry, migrated: false, resumed: false };
}

// ── profile CRUD ─────────────────────────────────────────────────────────

async function copyTree(
  src: FileSystemDirectoryHandle,
  dst: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const [name, handle] of (src as unknown as IterableDirHandle).entries()) {
    if (handle.kind === "directory") {
      const child = await dst.getDirectoryHandle(name, { create: true });
      await copyTree(await src.getDirectoryHandle(name), child);
      continue;
    }
    const file = await (await src.getFileHandle(name)).getFile();
    const target = await dst.getFileHandle(name, { create: true });
    const writable = await target.createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();
  }
}

export type NewProfileSource =
  | { kind: "blank" }
  | { kind: "duplicate"; from: FileSystemDirectoryHandle }
  | {
      /**
       * Seed the new profile immediately. The caller fetches and validates the
       * archive first, so a failed pull cannot leave a half-created profile;
       * this branch overlays it and stamps the workspace as seeded.
       */
      kind: "seed";
      archive: WorkspaceArchive;
      sha256: string;
      /** Persisted with the profile so update offers work from the start. */
      binding: SeedBinding;
      /** Per-file write progress while the archive is overlaid. */
      onProgress?: (done: number, total: number) => void;
    };

/** Freshness markers live next to the workspace (`<profile>/workspace`). */
const SEED_STAMP_FILE = ".seeded";
const SEED_SHA_FILE = ".seed-sha";

/**
 * Write a seed's freshness markers into a profile that is not the active one.
 * The boot seeder uses `/workspace` paths while this runs before a switch, so
 * it writes through the profile's directory handle instead.
 */
async function stampSeededProfile(
  dest: FileSystemDirectoryHandle,
  archive: WorkspaceArchive,
  sha256: string,
): Promise<void> {
  const workspace = await dest.getDirectoryHandle("workspace", { create: true });
  const raw = typeof archive.createdAt === "string" ? archive.createdAt : "";
  const stamp = raw && !Number.isNaN(Date.parse(raw)) ? raw : new Date().toISOString();
  await writeTextFile(workspace, SEED_STAMP_FILE, stamp);
  await writeTextFile(workspace, SEED_SHA_FILE, sha256.toLowerCase());
}

/** Create a profile directory and registry entry (does not switch to it). */
export async function createProfile(
  name: string,
  source: NewProfileSource = { kind: "blank" },
): Promise<ProfileRecord> {
  if (!isValidProfileName(name)) {
    throw new Error("profile names use lowercase letters, digits, dot, dash or underscore (max 64)");
  }
  const registry = await loadRegistry();
  if (registry.profiles.some((profile) => profile.name === name)) {
    throw new Error(`profile already exists: ${name}`);
  }
  let dest = await profileHandle(name);
  if (source.kind === "duplicate") await copyTree(source.from, dest);
  if (source.kind === "seed") {
    try {
      // Start from an empty directory: a leftover from a crash must not merge
      // its files into the seed.
      const profiles = await (await originRoot()).getDirectoryHandle(PROFILE_DIR);
      await profiles.removeEntry(name, { recursive: true }).catch(() => undefined);
      dest = await profileHandle(name);
      const archive = validateWorkspaceArchive(source.archive);
      await importWorkspace(archive, dest, source.onProgress);
      await stampSeededProfile(dest, archive, source.sha256);
    } catch (err) {
      // The registry is not written yet. Drop the partial directory so a
      // later directory scan cannot recover a half-seeded profile.
      const profiles = await (await originRoot()).getDirectoryHandle(PROFILE_DIR);
      await profiles.removeEntry(name, { recursive: true }).catch(() => undefined);
      throw err;
    }
  }
  const record: ProfileRecord = { name, createdAt: new Date().toISOString() };
  if (source.kind === "seed") record.seed = source.binding;
  const next: ProfileRegistry = { version: 1, profiles: [...registry.profiles, record] };
  await writeRegistry(next);
  return record;
}

/**
 * Bind a desktop mirror folder to an existing OPFS profile. The folder must
 * already be registered on the bridge (`POST /roots`); this only writes the
 * registry binding — the workspace itself stays in OPFS and syncs both ways.
 */
export async function bindDesktopMirror(name: string, folder: string): Promise<ProfileRecord> {
  if (!isValidProfileName(folder)) {
    throw new Error("folder names use lowercase letters, digits, dot, dash or underscore (max 64)");
  }
  const registry = await loadRegistry();
  const next = patchRegistry(registry, name, (record) => ({ ...record, kind: "desktop", folder }));
  await writeRegistry(next);
  return next.profiles.find((profile) => profile.name === name)!;
}

/** Remove a profile's desktop mirror binding (the OPFS workspace is untouched). */
export async function unbindDesktopMirror(name: string): Promise<ProfileRegistry> {
  const registry = await loadRegistry();
  const next = patchRegistry(registry, name, (record) => {
    const copy = { ...record };
    delete copy.kind;
    delete copy.folder;
    return copy;
  });
  await writeRegistry(next);
  return next;
}

/** Delete a non-default, non-active profile and its workspace directory. */
export async function deleteProfile(name: string): Promise<ProfileRegistry> {
  if (name === DEFAULT_PROFILE) throw new Error("the default profile cannot be deleted");
  if (resolveActiveProfileName(await loadRegistry()) === name) {
    throw new Error("switch away from a profile before deleting it");
  }
  const registry = await loadRegistry();
  const root = await originRoot();
  const profilesDir = await root.getDirectoryHandle(PROFILE_DIR);
  await profilesDir.removeEntry(name, { recursive: true });
  const next = patchRegistry(registry, name, () => null);
  await writeRegistry(next);
  return next;
}

/** Persist a seed binding for a profile (null clears it). */
export async function setSeedBinding(
  name: string,
  binding: SeedBinding | null,
): Promise<ProfileRegistry> {
  const registry = await loadRegistry();
  const next = patchRegistry(registry, name, (record) => {
    const updated = { ...record };
    if (binding) updated.seed = binding;
    else delete updated.seed;
    return updated;
  });
  await writeRegistry(next);
  return next;
}

/** Record the last pulled seed version (kept next to the binding). */
export async function recordSeedVersion(
  name: string,
  version: SeedVersionRef,
): Promise<ProfileRegistry> {
  const registry = await loadRegistry();
  const record = registry.profiles.find((profile) => profile.name === name);
  if (!record?.seed) throw new Error(`profile ${name} has no seed binding`);
  const updated: SeedBinding = { ...record.seed, lastVersion: version };
  return setSeedBinding(name, updated);
}
