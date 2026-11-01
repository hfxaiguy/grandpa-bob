/**
 * Browser target entry point.
 *
 * Renders the *exact* Node admin pages (src/ui/pages.ts) inside an iframe and
 * serves their /api/* calls from an in-browser backend (AgentClient + Platform)
 * via a fetch/EventSource shim.
 *
 * The workspace always lives in the tab's OPFS sandbox. A desktop profile is
 * an OPFS profile with a synced folder on the machine running the storage
 * bridge; the bridge also carries the desktop-only operations. There is no
 * storage-backend choice to make.
 */
import "./shims/process";
import { setActiveFs, setFsIndex } from "./shims/node-fs-promises";
import { createBrowserPlatform, initSqlite } from "./platform/browser";
import { setOpfsRootSegments } from "./platform/opfs-root";
import type { HandleFileSystem } from "./platform/handle-fs";
import { AgentClient } from "./agent/agent-client";
import { createLocalBackend } from "./server/local-backend";
import { hostUi } from "./ui-host";
import {
  loadEnv,
  loadRemote,
  loadTelegramChannel,
  loadModelsJson,
  loadCdp,
  saveCdp,
} from "./settings";
import {
  buildWorkspaceArchive,
  archiveToBlob,
  importWorkspace,
  validateWorkspaceArchive,
} from "./workspace-transfer";
import type { WorkspaceArchive } from "./workspace-transfer";
import {
  DEFAULT_PROFILE,
  bootProfiles,
  loadRegistry,
  profileHandle,
  profileSegmentsFor,
  recordSeedVersion,
  resolveActiveProfileName,
  setSeedBinding,
  touchProfile,
  type ProfileRegistry,
  type SeedBinding,
} from "./profiles";
import {
  fetchLatestSeed,
  probeLatestSeed,
  resolveSwapService,
  type LatestSeedProbe,
  type RemoteSeedMeta,
} from "./swap";
import { wireProfileUi, setSeedProgress, clearSeedProgress } from "./profile-ui";
import {
  bootstrapSeedFromParams,
  parseBootstrapSeed,
  type BootstrapSeed,
} from "./seed-bootstrap";
import { cloneWorkspace } from "./platform/git-opfs";
import { applyDatabaseDumps } from "./db-sync";
import { createAutoSync, DEFAULT_INTERVAL_MS } from "./auto-sync";
import type { MirrorStatus } from "./peer-status";
import { loadServerLink, resumeServer, type ServerConnection } from "./server-link";
import { listTreeSources } from "./tree-sources";
import { resolveTreeEntry } from "./tree-files";
import { patternLabel } from "./agent/pattern-path";
import { createHostLease } from "./host-lease";
import { startSync, activeSync, type SyncHandle } from "./sync";
import { wireSyncUi } from "./sync-ui";
import { parseSeedMeta, seedFreshness, SEED_CLOCK_TOLERANCE_MS, type SeedMeta } from "./seed-version";
import type { Platform } from "./platform/types";

const params = new URLSearchParams(location.search);
let configuredRemote = params.get("remote") ?? loadRemote();

/** The OPFS profile this tab hosts. */
let profileRegistry: ProfileRegistry | null = null;
let activeProfile: string = DEFAULT_PROFILE;
let activeProfileSegments: string[] = [];

/**
 * Hand the active profile's "hidden… except:" list to the chat UI. `null` (no
 * field) keeps the trunk-only default; an empty array also leaves only trunk.
 */
function publishProfileVisibleApps(): void {
  const record = profileRegistry?.profiles.find((profile) => profile.name === activeProfile);
  (window as unknown as { __bobProfileVisibleApps?: string[] | null }).__bobProfileVisibleApps =
    Array.isArray(record?.visibleApps) ? [...record.visibleApps] : null;
}
// The launcher (`npm run chrome`) opens the app with ?cdp=<browser ws url>;
// persist it so a plain reload keeps the browser tools connected. An explicit
// empty value (BOB_NO_CDP=1) clears a previously persisted socket instead.
const configuredCdp = params.get("cdp") ?? loadCdp();
if (params.has("cdp")) saveCdp(configuredCdp);

const statusEl = document.getElementById("status")!;
const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

/**
 * The static pre-UI splash in index.html. It covers the boot shown here — the
 * chat app only mounts at the end of main(), and its own splash then restores
 * the session. `hostUi` replaces #app's children, so no explicit teardown.
 */
const splashEl = document.getElementById("boot-splash");
const splashTextEl = document.getElementById("boot-text");
const splashPctEl = document.getElementById("boot-pct");
const splashBarEl = document.getElementById("boot-bar");
const splashBarFillEl = document.getElementById("boot-bar-fill");

/** Where the chat app's splash picks up (see store.init), so the bar never resets. */
const CHAT_BOOT_FLOOR = 90;

/** Report a boot stage: toolbar one-liner + the splash's text, percent and bar. */
function bootProgress(text: string, percent: number): void {
  setStatus(text);
  if (splashTextEl) splashTextEl.textContent = text;
  if (splashPctEl) splashPctEl.textContent = `${percent}%`;
  if (splashBarFillEl) splashBarFillEl.style.width = `${percent}%`;
  if (splashBarEl) splashBarEl.setAttribute("aria-valuenow", String(percent));
}

/** Leave the splash up, but make it read as a failure instead of a stuck boot. */
function bootFailure(text: string): void {
  splashEl?.classList.add("errored");
  if (splashTextEl) splashTextEl.textContent = text;
  if (splashPctEl) splashPctEl.textContent = "!";
  if (splashBarFillEl) splashBarFillEl.style.width = "100%";
  if (splashBarEl) splashBarEl.setAttribute("aria-valuenow", "100");
}

/** Storage-specific half of the status line (set once the backend is ready). */
let statusBase = "opfs";

/** Days after which the shipped OPFS snapshot is old enough to call out. */
const STALE_SEED_DAYS = 14;

/** `opfs · snapshot Oct 3` (+ a hint when the seed has gone stale). */
function seedStatus(): string {
  if (!seedStamp) return "opfs";
  const when = new Date(seedStamp);
  if (Number.isNaN(when.getTime())) return "opfs";
  const sameYear = when.getFullYear() === new Date().getFullYear();
  const date = when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  });
  const days = Math.floor((Date.now() - when.getTime()) / 86_400_000);
  return days > STALE_SEED_DAYS
    ? `opfs · snapshot ${date} · seed stale — regenerate with make-seed`
    : `opfs · snapshot ${date}`;
}

/** `desktop: /path · trunk` — pattern switches update this live. */
let activePattern = "";
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(pattern: string): void {
  activePattern = pattern;
  clearTimeout(statusTimer);
  setStatus(`${statusBase} · ${patternLabel(pattern)}`);
}

/** Report per-file seed-write progress in the toolbar bar and status line. */
function seedApplyProgress(done: number, total: number): void {
  setSeedProgress("seed-bar", done, total);
  setStatus(`applying ${done}/${total} files…`);
}

/** Show a one-off message, then go back to the storage · pattern line. */
function flashStatus(text: string, ms = 5000): void {
  setStatus(text);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    if (activePattern) setStatus(`${statusBase} · ${patternLabel(activePattern)}`);
  }, ms);
}

window.addEventListener("bob:pattern", (event) => {
  const pattern = (event as CustomEvent<{ pattern?: string }>).detail?.pattern;
  if (pattern) showStatus(pattern);
});

const appEl = document.getElementById("app")!;
const mirrorChip = document.getElementById("mirror-status") as HTMLSpanElement | null;

/** Toolbar chip: the desktop mirror is plumbing, not a storage choice. */
function renderMirrorStatus(status: MirrorStatus): void {
  if (!mirrorChip) return;
  if (status.phase === "unlinked") {
    mirrorChip.hidden = true;
    mirrorChip.textContent = "";
    mirrorChip.title = status.detail;
    return;
  }
  mirrorChip.hidden = false;
  mirrorChip.dataset.phase = status.phase;
  const when = status.lastSyncAt
    ? new Date(status.lastSyncAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "";
  mirrorChip.textContent =
    status.phase === "syncing"
      ? "desktop: syncing…"
      : status.phase === "offline"
        ? "desktop: offline"
        : status.phase === "error"
          ? "desktop: sync error"
          : when
            ? `desktop: synced ${when}`
            : "desktop: linked";
  mirrorChip.title = `${status.detail}${status.folder ? `\nmirror folder: ${status.folder}` : ""}`;
}

mirrorChip?.addEventListener("click", () => {
  (document.getElementById("profile-manage") as HTMLButtonElement | null)?.click();
});

let platform: Platform;
/** Set once the agent worker exists; workspace export asks it for the log snapshot. */
let archiveAgent: AgentClient | null = null;

/**
 * The single-host lease: exactly one tab runs turns per OPFS workspace.
 * Created during boot, before the backend, so every turn can be gated by it.
 */
let lease: ReturnType<typeof createHostLease> | null = null;

/** The connected desktop/server peer, when this profile has one. */
let serverConnection: ServerConnection | null = null;
let syncHandle: SyncHandle | null = null;
let serverConnecting = false;
let serverRetryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reconnect to the profile's paired desktop/server. Used at boot (before
 * indexing) and by a retry timer when the server was offline or the channel
 * dropped. Resolves true when the engine round completed.
 */
async function connectServerPeer(): Promise<boolean> {
  const info = loadServerLink(activeProfile);
  const folder = mirrorFolder();
  if (!info || !folder || !syncHandle || serverConnecting || serverConnection) return false;
  if (lease?.status() !== "primary") return false;
  serverConnecting = true;
  try {
    const connection = await resumeServer({
      info,
      localId: syncHandle.engine.id,
      onStatus: (text) => flashStatus(`desktop: ${text}`, 4000),
      onSas: (phrase) => console.log(`[peer] verification phrase ${phrase}`),
    });
    serverConnection = connection;
    syncHandle.attach(connection.peer);
    connection.peer.onClosed(() => {
      if (serverConnection !== connection) return;
      serverConnection = null;
      renderMirrorStatus({ phase: "offline", detail: "disconnected", folder, lastSyncAt: null });
      archiveAgent?.setOpsConfig({ enabled: false, allow: [] });
    });
    renderMirrorStatus({
      phase: "idle",
      detail: "connected",
      folder,
      lastSyncAt: new Date().toISOString(),
    });
    await syncHandle.engine.reconcileAndWait(connection.peer, 15_000);
    (window as unknown as { __bobServer?: unknown }).__bobServer = connection;
    return true;
  } catch (err) {
    renderMirrorStatus({
      phase: "error",
      detail: `pairing needed: ${errorText(err)}`,
      folder,
      lastSyncAt: null,
    });
    flashStatus(`desktop pairing needed: ${errorText(err)}`, 10_000);
    return false;
  } finally {
    serverConnecting = false;
  }
}

/** The active profile's desktop mirror folder, when one is bound. */
function mirrorFolder(): string | null {
  const record = profileRegistry?.profiles.find((profile) => profile.name === activeProfile);
  return record?.kind === "desktop" && record.folder ? record.folder : null;
}

/** The platform selected at boot; all callers share it (and its handles). */
function activePlatform(): Platform {
  return platform;
}

/** The active profile's OPFS root. */
async function activeProfileRoot(): Promise<FileSystemDirectoryHandle | undefined> {
  const fs = platform.fs as Partial<HandleFileSystem>;
  return typeof fs.rootHandle === "function" ? await fs.rootHandle() : undefined;
}

/** Archive the workspace BOB currently operates on (always this tab's OPFS). */
async function buildActiveArchive(): Promise<WorkspaceArchive> {
  return buildBrowserArchive();
}

/**
 * The browser archive plus a live run-log snapshot. The streaming VFS keeps its
 * files under `.gpb-runlog` (not a plain workspace file), so the archive carries
 * SQLite's logical page image at the legacy log path instead; an import stages
 * that file and the next boot re-imports it.
 */
async function buildBrowserArchive(): Promise<WorkspaceArchive> {
  const archive = await buildWorkspaceArchive(await activeProfileRoot());
  archive.files = archive.files.filter((file) => !file.path.startsWith(".gpb-runlog/"));
  const snapshot = await archiveAgent
    ?.log<{ base64?: string } | null>("exportRunLog")
    .catch((err) => {
      console.warn("run-log snapshot omitted from the archive:", err);
      return null;
    });
  if (snapshot?.base64) {
    // Replace the (possibly stale) legacy file with the live logical image.
    archive.files = archive.files.filter((file) => file.path !== "workspace/logs/grandma-kat.db");
    archive.files.push({ path: "workspace/logs/grandma-kat.db", base64: snapshot.base64 });
  }
  // No snapshot (unavailable log): keep the raw legacy file the walk found, so
  // the log can still be backed up and recovered by hand.
  return archive;
}

/**
 * Merge an archive into `target` (a profile name) and stamp the workspace so
 * the shipped seed cannot overlay it on the next boot.
 */
async function importIntoWorkspace(target: string, archive: WorkspaceArchive): Promise<number> {
  const root = await profileHandle(target);
  const written = await importWorkspace(archive, root);
  const workspace = await root.getDirectoryHandle("workspace", { create: true });
  const stamped = await workspace.getFileHandle(".seeded", { create: true });
  const writable = await stamped.createWritable();
  await writable.write(new Date().toISOString());
  await writable.close();
  return written;
}

// ── browser (OPFS) workspace preparation ────────────────────────────────
async function isFile(p: string): Promise<boolean> {
  return platform.fs.stat(p).then(() => true).catch(() => false);
}

/** When the OPFS workspace was seeded/imported (ISO), if known. */
let seedStamp: string | null = null;
/** Content hash of the seed archive this profile was last built from. */
let seedSha: string | null = null;

async function readSeedStamp(marker: string): Promise<string | null> {
  try {
    const raw = (await platform.fs.readFile(marker, "utf8")).trim();
    return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

const SEED_SHA_MARKER = "/workspace/.seed-sha";

async function readSeedSha(): Promise<string | null> {
  try {
    const raw = (await platform.fs.readFile(SEED_SHA_MARKER, "utf8")).trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Record the applied seed's content hash (null clears it, e.g. after a manual
 * import that is not a seed build). The hash lets a same-day re-pack be
 * detected even when `createdAt` is unchanged.
 */
async function writeSeedSha(sha256: string | null): Promise<void> {
  if (sha256) {
    await platform.fs.writeFile(SEED_SHA_MARKER, sha256.toLowerCase());
  } else {
    await platform.fs.rm(SEED_SHA_MARKER).catch(() => undefined);
  }
  seedSha = sha256 ? sha256.toLowerCase() : null;
}

/**
 * Record which seed build this workspace carries. The seeder writes the
 * seed's own `createdAt`; a manual import writes the import time (the profile
 * is at least as new as anything it imported).
 */
async function writeSeedStamp(stamp: string): Promise<void> {
  await platform.fs.writeFile(platform.path.join("/workspace", ".seeded"), stamp);
  seedStamp = stamp;
}

/**
 * Overlay a seed archive and record its build stamp. The archive ships an
 * empty run log; never let a reseed overwrite the workspace's real one.
 * When the caller knows the archive's content hash, it is recorded too so a
 * same-day re-pack still reads as a different build.
 */
async function applySeedArchive(
  archive: WorkspaceArchive,
  sha256?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const logDb = platform.path.join("/workspace", "logs", "grandma-kat.db");
  const hasLog = await isFile(logDb);
  const files = hasLog
    ? archive.files.filter((f) => !f.path.startsWith("workspace/logs/"))
    : archive.files;
  await importWorkspace({ ...archive, files }, await activeProfileRoot(), onProgress);
  const raw = typeof archive.createdAt === "string" ? archive.createdAt : "";
  const stamp = raw && !Number.isNaN(Date.parse(raw)) ? raw : new Date().toISOString();
  await writeSeedStamp(stamp);
  await writeSeedSha(sha256 ?? null);
  return stamp;
}

/**
 * A deployment can name a BobSwap shelf in `public/seed-bootstrap.json`. A
 * fresh profile tries that shelf's newest public archive before the bundled
 * snapshot; the query parameters exist for the smoke and one-off testing.
 */
async function loadBootstrapSeed(): Promise<BootstrapSeed | null> {
  const fromParams = bootstrapSeedFromParams(params);
  if (fromParams) return fromParams;
  try {
    const res = await fetch("/seed-bootstrap.json", { cache: "no-cache" });
    if (!res.ok) return null;
    return parseBootstrapSeed(await res.json());
  } catch {
    return null;
  }
}

/** Remember the shelf a fresh profile was pulled from, so it keeps following it. */
async function bindBootstrapSeed(
  bootstrap: BootstrapSeed,
  sha256: string,
  createdAt: string,
  version?: string,
): Promise<void> {
  try {
    await setSeedBinding(activeProfile, {
      baseUrl: bootstrap.baseUrl,
      account: bootstrap.account,
      seedName: bootstrap.seedName,
      lastVersion: {
        version: version ?? sha256.slice(0, 12),
        sha256,
        createdAt,
        checkedAt: new Date().toISOString(),
      },
    });
    profileRegistry = await loadRegistry();
  } catch (err) {
    console.warn(
      `[seed-bootstrap] could not bind ${bootstrap.account}/${bootstrap.seedName}: ${errorText(err)}`,
    );
  }
}

/**
 * Pull the configured shelf's newest public archive into a fresh profile.
 * Returns false when the shelf is private, offline or times out; the bundled
 * snapshot is the fallback and nothing is written before the download lands.
 */
async function pullBootstrapSeed(bootstrap: BootstrapSeed): Promise<boolean> {
  // A saved service can contribute a read key, but a fresh browser has none;
  // a keyless service object is enough for a public shelf on any origin.
  const service = resolveSwapService(bootstrap.baseUrl) ?? { baseUrl: bootstrap.baseUrl };
  const account = service.account || bootstrap.account;
  const label = `${account}/${bootstrap.seedName}`;
  bootProgress(`pulling seed ${label}…`, 30);
  try {
    const fetched = await Promise.race([
      fetchLatestSeed(service, account, bootstrap.seedName),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), 8_000),
      ),
    ]);
    if (!fetched) return false;
    await applySeedArchive(fetched.archive, fetched.sha256, (done, count) => {
      bootProgress(`seeding ${done}/${count} files…`, 30 + Math.round((15 * done) / count));
    });
    const version = fetched.version ?? fetched.sha256.slice(0, 12);
    await bindBootstrapSeed(
      { ...bootstrap, account },
      fetched.sha256,
      fetched.archive.createdAt,
      version,
    );
    console.log(`[seed-bootstrap] ${label}: pulled ${version}`);
    return true;
  } catch (err) {
    console.warn(`[seed-bootstrap] ${label}: ${errorText(err)} — using the bundled snapshot`);
    return false;
  }
}

async function seedWorkspace(root: string): Promise<void> {
  const marker = platform.path.join(root, ".seeded");
  const force = params.has("reseed");
  // A seeded workspace is usable only when its trunk tree is on disk.
  const hasTrunk = await resolveTreeEntry(platform.workspaceRoot, "trunk")
    .then((entry) => !!entry)
    .catch(() => false);
  if (!force && (await isFile(marker)) && hasTrunk) {
    seedStamp = await readSeedStamp(marker);
    seedSha = await readSeedSha();
    return;
  }

  // A fresh tab first follows the configured public shelf. `?reseed=1` means
  // "overlay the bundled snapshot", so it deliberately skips this path.
  const bootstrap = force ? null : await loadBootstrapSeed();
  if (bootstrap && (await pullBootstrapSeed(bootstrap))) return;

  try {
    const res = await fetch("/seed/workspace.json", { cache: "no-cache" });
    if (!res.ok) return;
    const text = await res.text();
    const archive = JSON.parse(text) as WorkspaceArchive;
    await applySeedArchive(archive, platform.crypto.sha256hex(text), (done, count) => {
      // Fill the splash's 30→45 seeding slice with the actual write loop.
      bootProgress(`seeding ${done}/${count} files…`, 30 + Math.round((15 * done) / count));
    });
  } catch {
    seedStamp = await readSeedStamp(marker);
    seedSha = await readSeedSha();
    /* seed is optional */
  }
}

async function prepareBrowserWorkspace(): Promise<void> {
  const root = "/workspace";

  // An imported workspace may carry a run-log snapshot (see the Import button).
  // The streaming VFS owns its own files, so drop the pool before anything
  // opens the log; the first open migrates the snapshot.
  const restoreMarker = platform.path.join(root, "logs/.runlog-restore");
  if (await isFile(restoreMarker)) {
    const profileRoot = await activeProfileRoot();
    await profileRoot?.removeEntry(".gpb-runlog", { recursive: true }).catch(() => undefined);
    await platform.fs.rm(restoreMarker).catch(() => undefined);
  }

  if (configuredRemote && !mirrorFolder()) {
    const gitDir = platform.path.join(root, ".git");
    const hasRepo = await isFile(gitDir);
    if (!hasRepo || params.has("reclone")) {
      bootProgress(`cloning ${configuredRemote}…`, 30);
      if (await isFile(root)) await platform.fs.rm(root);
      await cloneWorkspace(root, configuredRemote);
    }
    await applyDatabaseDumps(platform, { onlyMissing: true }).catch((err) => {
      console.warn("database dumps could not be applied:", err);
    });
    bootProgress("workspace ready", 45);
    return;
  }
  bootProgress("seeding the workspace…", 30);
  if (mirrorFolder()) {
    // A mirror-bound profile takes its first content from the desktop folder;
    // overlaying the bundled snapshot would race (and win over) that pull.
    seedStamp = await readSeedStamp(platform.path.join(root, ".seeded"));
    seedSha = await readSeedSha();
  } else {
    await seedWorkspace(root);
  }
  await applyDatabaseDumps(platform, { onlyMissing: true }).catch((err) => {
    console.warn("database dumps could not be applied:", err);
  });
  bootProgress("workspace ready", 45);
}

/** The auto-generated mock registry older browser profiles booted with. */
const LEGACY_MOCK_MODELS = {
  default: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
  strong: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
  cheap: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
};

/** True only for the old auto-written mock file (never a hand-edited one). */
function isLegacyMockModels(raw: string): boolean {
  try {
    const entries = Object.values(JSON.parse(raw) as Record<string, unknown>);
    return (
      entries.length > 0 &&
      entries.every((value) => {
        if (!value || typeof value !== "object") return false;
        const entry = value as { baseURL?: unknown; model?: unknown };
        return (
          entry.model === "mock-model" &&
          typeof entry.baseURL === "string" &&
          /\/\/(127\.0\.0\.1|localhost):8787(?:\/|$)/.test(entry.baseURL)
        );
      })
    );
  } catch {
    return false;
  }
}

/**
 * Make sure the browser workspace has a model registry.
 *
 * A freshly seeded profile already has the standalone template (seed packs
 * `web/public/models.standalone.json` as `models.json`). Older profiles only
 * have the auto-generated mock entries; upgrade those — and only those, never
 * a file the user edited — to the template. If the template is missing (an old
 * dist), keep the mock fallback so `npm run mock-llm` still works.
 */
async function ensureModels(target: Platform): Promise<void> {
  const file = target.path.join(target.workspaceRoot, "models.json");
  const existing = await target.fs.readFile(file, "utf8").catch(() => null);
  if (existing !== null && !isLegacyMockModels(existing)) return;
  let template = "";
  try {
    const res = await fetch("/models.standalone.json", { headers: { accept: "application/json" } });
    if (res.ok) template = (await res.text()).trim();
  } catch {
    /* stale dist or offline: fall back below */
  }
  if (!template) {
    if (existing !== null) return;
    template = JSON.stringify(LEGACY_MOCK_MODELS);
  }
  await target.fs.writeFile(file, template);
}

/**
 * True when this page is served by grandpa-bob's admin (not a standalone Vite
 * dev server). The admin answers `/api/models` with JSON; Vite's SPA fallback
 * answers with index.html, so the content type is the tell.
 */
async function servedByAdmin(): Promise<boolean> {
  try {
    const res = await fetch("/api/models", { headers: { accept: "application/json" } });
    if (!res.ok) return false;
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return false;
    const data = (await res.json()) as { json?: unknown };
    return typeof data.json === "string";
  } catch {
    return false;
  }
}

/** Load the sync fs index so tree patterns' `appTreeNames()` works on this thread. */
async function buildFsIndex(target: Platform): Promise<void> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await target.fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = target.path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(target.workspaceRoot);
  setFsIndex(files);
}

async function detectPattern(target: Platform): Promise<string> {
  try {
    // Prefer the trunk; otherwise the first tree in the workspace.
    const sources = await listTreeSources(target.workspaceRoot);
    if (sources.some((s) => s.name === "trunk")) return "trunk";
    if (sources[0]) return sources[0].name;
  } catch {
    /* fall through */
  }
  return "trunk";
}

// ── toolbar export/import (OPFS only) ────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Keep the seeder out of an imported workspace. The seeder re-imports
 * `seed/workspace.json` when `/workspace/.seeded` is missing — an archive from
 * a cloned/imported workspace has no marker, and would be overlaid on next boot.
 */
function wireWorkspaceTransfer(): void {
  const exportButton = document.getElementById("ws-export") as HTMLButtonElement | null;
  const importButton = document.getElementById("ws-import") as HTMLButtonElement | null;
  const importInput = document.getElementById("ws-import-file") as HTMLInputElement | null;
  if (!exportButton || !importButton || !importInput) return;

  // A secondary tab must not write the workspace while another tab holds it.
  if (lease && lease.status() !== "primary") {
    exportButton.disabled = true;
    importButton.disabled = true;
    return;
  }

  // Smoke hook: the browser smoke drives export/import without a download dialog
  // or a reload. Like `__bobBackend`, it is only a test surface.
  (window as unknown as { __bobWorkspaceTransfer?: unknown }).__bobWorkspaceTransfer = {
    buildWorkspaceArchive: async () => buildBrowserArchive(),
    archiveToBlob,
    validateWorkspaceArchive,
    importWorkspace: async (archive: WorkspaceArchive) =>
      importWorkspace(archive, await activeProfileRoot()),
    profileRoot: activeProfileRoot,
  };

  exportButton.addEventListener("click", () => {
    void (async () => {
      exportButton.disabled = true;
      importButton.disabled = true;
      const label = exportButton.textContent;
      exportButton.textContent = "exporting…";
      try {
        const archive = await buildBrowserArchive();
        const blob = archiveToBlob(archive);
        const name = `bob-workspace-${new Date().toISOString().slice(0, 10)}.json`;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        flashStatus(`exported ${archive.files.length} files · ${formatBytes(blob.size)}`);
      } catch (err) {
        flashStatus(`export failed: ${errorText(err)}`, 10_000);
      } finally {
        exportButton.textContent = label;
        exportButton.disabled = false;
        importButton.disabled = false;
      }
    })();
  });

  importButton.addEventListener("click", () => importInput.click());

  importInput.addEventListener("change", () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    void (async () => {
      let archive: WorkspaceArchive;
      try {
        archive = validateWorkspaceArchive(JSON.parse(await file.text()));
      } catch (err) {
        flashStatus(`import failed: ${errorText(err)}`, 10_000);
        return;
      }
      const proceed = confirm(
        `Import ${archive.files.length} files into the browser workspace?\n\n` +
          "Files with the same path are overwritten; files not in the archive are kept. " +
          "The page reloads afterwards.",
      );
      if (!proceed) return;
      exportButton.disabled = true;
      importButton.disabled = true;
      const label = importButton.textContent;
      importButton.textContent = "importing…";
      try {
        const written = await importWorkspace(archive, await activeProfileRoot());
        // A run-log snapshot in the archive replaces the streaming log on the
        // next boot: the VFS owns its files while the tab is running, so mark
        // the reset now and let prepareBrowserWorkspace drop the pool.
        if (archive.files.some((file) => file.path === "workspace/logs/grandma-kat.db")) {
          await platform.fs
            .writeFile(platform.path.join("/workspace", "logs/.runlog-restore"), new Date().toISOString())
            .catch(() => undefined);
        }
        // The imported workspace is the newest thing this profile carries:
        // stamp it now so an older shipped seed is not offered for it.
        await writeSeedStamp(new Date().toISOString());
        await writeSeedSha(null);
        setStatus(`imported ${written} files — reloading…`);
        setTimeout(() => location.reload(), 300);
      } catch (err) {
        importButton.textContent = label;
        exportButton.disabled = false;
        importButton.disabled = false;
        flashStatus(`import failed: ${errorText(err)}`, 10_000);
      }
    })();
  });
}

// ── seed update offer ────────────────────────────────────────────────────

/** The seed build the user declined, so one build does not nag every boot. */
const SEED_DISMISSED_KEY = "bob.seedUpdate.dismissed";

interface SeedUpdateOffer {
  meta: RemoteSeedMeta;
  label: string;
  dismissKey: string;
  apply: () => Promise<void>;
}

/**
 * Offer a workspace update. Two sources exist:
 *
 * - the shipped seed (`/seed/meta.json`, only used when the profile has no
 *   seed binding), and
 * - a BobSwap seed bound to the profile (`/latest/meta`), which is how a
 *   desktop publish reaches the phone.
 *
 * Both compare their `createdAt` with the profile's `.seeded` stamp; a binding
 * also offers an update when the remote sha differs from the last pulled one.
 * Nothing is ever applied silently.
 */
async function checkSeedUpdate(): Promise<void> {
  const record = profileRegistry?.profiles.find((profile) => profile.name === activeProfile);
  if (record?.seed) {
    await checkBoundSeedUpdate(record.seed);
    return;
  }
  // The shipped seed must not overlay a workspace that was cloned from git,
  // nor a mirror-bound profile whose content came from its desktop folder.
  if (configuredRemote || mirrorFolder()) return;

  let meta: SeedMeta | null = null;
  try {
    const res = await fetch("/seed/meta.json", { cache: "no-cache" });
    if (!res.ok) return;
    meta = parseSeedMeta(await res.json());
  } catch {
    return; /* seed is optional */
  }
  if (!meta || seedFreshness(seedStamp, meta, SEED_CLOCK_TOLERANCE_MS, seedSha) !== "newer") return;
  let dismissed: string | null = null;
  try {
    dismissed = localStorage.getItem(SEED_DISMISSED_KEY);
  } catch {
    /* private mode: always offer */
  }
  if (dismissed === (meta.sha256 ?? meta.createdAt)) return;
  wireSeedUpdate({
    meta,
    label: "Workspace update available",
    dismissKey: SEED_DISMISSED_KEY,
    apply: () => applySeedUpdate(meta),
  });
}

/** Check a profile's bound BobSwap seed for a newer build. */
async function checkBoundSeedUpdate(binding: SeedBinding): Promise<void> {
  const service = resolveSwapService(binding.baseUrl);
  if (!service) {
    console.warn(
      `[seed-check] ${binding.account}/${binding.seedName}: no saved service for ${binding.baseUrl} — add it in Sync… → BobSwap…`,
    );
    return;
  }
  const account = service.account || binding.account;
  const knownSha = binding.lastVersion?.sha256 ?? seedSha ?? undefined;
  let probe: LatestSeedProbe | null = null;
  try {
    probe = await probeLatestSeed(service, account, binding.seedName, knownSha);
  } catch (err) {
    // Keep working offline, but never hide the reason: a rejected key, a
    // private newest version, a rate limit or a malformed payload used to
    // look identical to "current".
    console.warn(`[seed-check] ${account}/${binding.seedName}: check failed: ${errorText(err)}`);
    return;
  }
  if (!probe) {
    console.log(
      `[seed-check] ${account}/${binding.seedName}: unchanged (304, ${knownSha?.slice(0, 12)}…)`,
    );
    return;
  }
  const meta = probe.meta;
  const freshness = seedFreshness(seedStamp, meta, SEED_CLOCK_TOLERANCE_MS, knownSha ?? null);
  console.log(
    `[seed-check] ${account}/${binding.seedName}: local ${seedStamp ?? "unseeded"} / ` +
      `${knownSha ? `${knownSha.slice(0, 12)}…` : "no sha"}, remote ${meta.createdAt} / ` +
      `${meta.sha256 ? `${meta.sha256.slice(0, 12)}…` : "no sha"}${probe.keyless ? " (public)" : ""} → ${freshness}`,
  );
  if (freshness !== "newer") return;

  const dismissKey = `${SEED_DISMISSED_KEY}:${binding.baseUrl}|${binding.account}/${binding.seedName}`;
  const stamp = probe.version ?? meta.seed_id_and_version ?? meta.sha256 ?? meta.createdAt;
  try {
    if (localStorage.getItem(dismissKey) === stamp) return;
  } catch {
    /* private mode: always offer */
  }
  wireSeedUpdate({
    meta,
    label: `Seed update: ${binding.seedName}`,
    dismissKey,
    apply: () => applyBoundSeedUpdate(binding, probe.version ?? meta.seed_id_and_version),
  });
}

/** How often an open tab re-checks the shelf. A publish cannot push to it. */
const SEED_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Keep checking while the tab stays open. The CLI and another device publish
 * to the shelf, not to this tab, so on-boot checks alone leave a long-lived
 * tab permanently stale. `?seedpoll=<ms>` shortens the interval for tests.
 */
function startSeedWatcher(): void {
  const requested = Number(params.get("seedpoll") ?? "");
  const intervalMs = Math.max(
    1000,
    Number.isFinite(requested) && requested > 0 ? requested : SEED_CHECK_INTERVAL_MS,
  );
  let checking = false;
  const check = (): void => {
    if (checking || document.visibilityState === "hidden") return;
    checking = true;
    void checkSeedUpdate().finally(() => {
      checking = false;
    });
  };
  window.setInterval(check, intervalMs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}

/** Detaches the handlers of the offer currently shown in the toolbar. */
let seedOfferCleanup: (() => void) | null = null;

/** Reveal the toolbar offer and wire its apply/dismiss actions. */
function wireSeedUpdate(offer: SeedUpdateOffer): void {
  const apply = document.getElementById("ws-reseed") as HTMLButtonElement | null;
  const dismiss = document.getElementById("ws-reseed-dismiss") as HTMLButtonElement | null;
  if (!apply) return;
  // A periodic re-check re-offers the same buttons; never stack handlers.
  seedOfferCleanup?.();
  const built = new Date(offer.meta.createdAt).toLocaleString();
  const seeded = seedStamp ? new Date(seedStamp).toLocaleString() : "unknown";
  apply.title = `${offer.label}\nBuilt ${built}\nWorkspace seeded ${seeded}`;
  apply.textContent = offer.label;
  apply.hidden = false;
  if (dismiss) dismiss.hidden = false;

  let applying = false;
  const onClick = (): void => {
    if (applying) return;
    applying = true;
    offer.apply().catch((err) => {
      // A failed overlay (e.g. a wedged OPFS write) must name itself instead of
      // becoming an unhandled rejection: the workspace on disk is unchanged.
      applying = false;
      apply.hidden = false;
      if (dismiss) dismiss.hidden = false;
      flashStatus(`workspace update failed: ${errorText(err)}`, 12_000);
    });
  };
  const onDismiss = (): void => {
    try {
      localStorage.setItem(offer.dismissKey, offer.meta.seed_id_and_version ?? offer.meta.sha256 ?? offer.meta.createdAt);
    } catch {
      /* private mode: offer again next boot */
    }
    apply.hidden = true;
    if (dismiss) dismiss.hidden = true;
    flashStatus("workspace update declined");
  };
  apply.addEventListener("click", onClick);
  dismiss?.addEventListener("click", onDismiss);
  seedOfferCleanup = () => {
    apply.removeEventListener("click", onClick);
    dismiss?.removeEventListener("click", onDismiss);
    seedOfferCleanup = null;
  };
}

/**
 * Confirm an action with the app's own dialog. Native `confirm()` is a no-op
 * in some embedded browsers (and can be suppressed after repeated prompts),
 * which made the toolbar update button look dead: no dialog, no update.
 */
async function confirmAction(title: string, message: string, confirmLabel: string): Promise<boolean> {
  const dialog = document.getElementById("confirm-dialog") as HTMLDialogElement | null;
  const titleEl = document.getElementById("confirm-title");
  const messageEl = document.getElementById("confirm-message");
  const ok = document.getElementById("confirm-ok") as HTMLButtonElement | null;
  if (!dialog || !titleEl || !messageEl || !ok) {
    throw new Error("confirmation dialog is unavailable");
  }
  titleEl.textContent = title;
  messageEl.textContent = message;
  ok.textContent = confirmLabel;
  dialog.returnValue = "";
  return await new Promise<boolean>((resolve, reject) => {
    const onClose = (): void => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "ok");
    };
    dialog.addEventListener("close", onClose);
    try {
      dialog.showModal();
    } catch (err) {
      dialog.removeEventListener("close", onClose);
      reject(err);
      return;
    }
    ok.focus();
  });
}

async function applySeedUpdate(meta: SeedMeta): Promise<void> {
  const proceed = await confirmAction(
    "Workspace update",
    `Update the browser workspace to the seed built ${new Date(meta.createdAt).toLocaleString()}?\n\n` +
      "Files are overlaid; the run log and chat history are preserved. " +
      "Saved walk positions reset once. The page reloads afterwards.",
    "Update workspace",
  );
  if (!proceed) return;
  try {
    setStatus("updating workspace…");
    const res = await fetch("/seed/workspace.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`seed not available (${res.status})`);
    const text = await res.text();
    const archive = JSON.parse(text) as WorkspaceArchive;
    await applySeedArchive(archive, platform.crypto.sha256hex(text), seedApplyProgress);
    flashStatus("workspace updated — reloading…", 5000);
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    flashStatus(`workspace update failed: ${errorText(err)}`, 10_000);
  } finally {
    clearSeedProgress("seed-bar");
  }
}

/** Pull the newest version of a bound seed into the active profile. */
async function applyBoundSeedUpdate(binding: SeedBinding, version?: string): Promise<void> {
  const service = resolveSwapService(binding.baseUrl);
  if (!service) throw new Error("the seed service is not configured on this browser");
  const account = service.account || binding.account;
  const proceed = await confirmAction(
    "Seed update",
    `Update "${activeProfile}" from the seed ${account}/${binding.seedName}?\n\n` +
      "Files are overlaid; the run log and chat history are preserved. " +
      "The page reloads afterwards.",
    "Update profile",
  );
  if (!proceed) return;
  setStatus("fetching seed…");
  try {
    const fetched = await fetchLatestSeed(service, account, binding.seedName);
    if (!fetched) throw new Error("the newest seed version is unchanged");
    setStatus(`applying ${fetched.archive.files.length} files…`);
    await applySeedArchive(fetched.archive, fetched.sha256, seedApplyProgress);
    await recordSeedVersion(activeProfile, {
      version: version ?? fetched.version ?? fetched.sha256.slice(0, 12),
      sha256: fetched.sha256,
      createdAt: fetched.archive.createdAt,
      checkedAt: new Date().toISOString(),
    });
    flashStatus("seed applied — reloading…", 5000);
    setTimeout(() => location.reload(), 1500);
  } finally {
    clearSeedProgress("seed-bar");
  }
}

// ── single-host lease (one tab runs turns per workspace) ─────────────────

/**
 * A fixed banner while this tab is secondary, with a cooperative takeover
 * button. `pagehide` releases voluntarily (unless the page is being kept
 * alive by the back/forward cache) so the heartbeat fallback frees instantly.
 */
function wireLeaseUi(hostLease: NonNullable<typeof lease>): void {
  let banner: HTMLElement | null = null;
  const removeBanner = (): void => {
    banner?.remove();
    banner = null;
  };
  const showBanner = (): void => {
    if (banner) return;
    banner = document.createElement("div");
    banner.id = "bob-lease-banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;gap:12px;" +
      "align-items:center;justify-content:center;padding:8px 16px;" +
      "background:#fdf3d7;color:#5c4400;font:13px/1.4 system-ui,sans-serif;" +
      "border-bottom:1px solid #e8d48a;";
    const text = document.createElement("span");
    text.textContent = "This workspace is open in another tab — read-only here.";
    const button = document.createElement("button");
    button.textContent = "take over";
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "taking over…";
      void hostLease.takeOver().then((ok) => {
        if (!ok) {
          button.disabled = false;
          button.textContent = "take over";
        }
      });
    });
    banner.append(text, button);
    document.body.appendChild(banner);
  };
  hostLease.subscribe((status) => {
    if (status === "primary") removeBanner();
    else if (status === "secondary") showBanner();
  });
  (window as unknown as { __leaseState?: () => unknown }).__leaseState = () => hostLease.status();
  window.addEventListener("pagehide", (event) => {
    if (!(event as PageTransitionEvent).persisted) hostLease.release();
  });
}

/** The turn gate passed to the backend: a secondary tab never runs the tree. */
async function beforeTurn(): Promise<string | null> {
  if (!lease || lease.status() === "primary") return null;
  return "this workspace is open in another tab — take over there (or use “take over” above) to run turns here";
}

// ── boot ─────────────────────────────────────────────────────────────────

/**
 * Which boot stage is running. Gecko's OPFS can fail with a native
 * `UnknownError: Unknown failure` DOMException whose stack carries no JS
 * frames, so the stage marker is the only way to tell which call failed.
 */
let bootStage = "start";

/** Set when the browser declined to keep this origin's OPFS off its eviction list. */
let storageEvictable = false;

/**
 * Ask the browser to make this origin's OPFS persistent. Without the grant the
 * workspace is best-effort storage the browser may evict under disk pressure —
 * for a single-browser install that is the only copy. A refusal never blocks
 * boot; the status line calls it out ("⚠ storage not persistent") instead.
 */
async function requestPersistentStorage(): Promise<void> {
  if (!navigator.storage?.persist) return;
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return;
    storageEvictable = !(await navigator.storage.persist());
  } catch {
    // Persistence is an optimisation (private windows, older Safari, …).
  }
}

async function main(): Promise<void> {
  // Kick the persistence request off first: this is a decision the browser
  // makes without a prompt in most cases, and waiting for it costs nothing.
  bootStage = "persistentStorage";
  const persistence = requestPersistentStorage();

  // Every profile's workspace lives in this origin's OPFS; a `desktop` record
  // only binds a bridge folder to it as a synced mirror.
  bootStage = "bootProfiles";
  const boot = await bootProfiles();
  profileRegistry = boot.registry;
  activeProfile = resolveActiveProfileName(profileRegistry);
  activeProfileSegments = profileSegmentsFor(activeProfile);

  // Bind every layer (fs, sqlite worker, agent worker) to the active profile.
  setOpfsRootSegments(activeProfileSegments);
  bootProgress("starting the database…", 20);
  bootStage = "initSqlite";
  await initSqlite(activeProfileSegments);
  bootStage = "touchProfile";
  profileRegistry = await touchProfile(activeProfile);
  publishProfileVisibleApps();

  platform = createBrowserPlatform("/workspace");
  setActiveFs(platform.fs);

  // Single-host lease first: the mirror writes below, and a secondary tab must
  // not race the primary over the shared folder. Created before the backend so
  // /api/chat can gate on it too.
  bootStage = "hostLease";
  lease = createHostLease(`opfs:${activeProfile}`);
  wireLeaseUi(lease);
  await lease.whenSettled();

  // One engine for every peer (BroadcastChannel, cross-device, desktop/server).
  // It exists before workspace preparation so a mirror-bound profile pulls its
  // folder before pattern detection and indexing.
  bootStage = "startSync";
  if (lease.status() === "primary") {
    const syncIdKey = `bob:sync-id:opfs:${activeProfile}`;
    let syncId = "";
    try {
      syncId = localStorage.getItem(syncIdKey) ?? "";
      if (!syncId) {
        syncId = crypto.randomUUID();
        localStorage.setItem(syncIdKey, syncId);
      }
    } catch {
      syncId = crypto.randomUUID();
    }
    syncHandle = await startSync(platform, {
      id: syncId,
      channelName: `bob-sync:opfs:${activeProfile}`,
    });
    (window as unknown as { __bobSync?: unknown }).__bobSync = syncHandle;
    syncHandle.onState((state) => {
      const bound = mirrorFolder();
      if (!bound) return;
      renderMirrorStatus({
        phase: state.status === "error" ? "error" : state.status === "syncing" ? "syncing" : "idle",
        detail: state.detail || "connected",
        folder: bound,
        lastSyncAt: state.lastSyncAt,
      });
    });
  }

  const folder = mirrorFolder();
  if (folder && lease.status() === "primary") {
    bootProgress("connecting the desktop…", 24);
    bootStage = "serverResume";
    const connected = await connectServerPeer();
    if (!connected && !loadServerLink(activeProfile)) {
      renderMirrorStatus({ phase: "offline", detail: "pairing needed", folder, lastSyncAt: null });
    }
  } else if (folder) {
    renderMirrorStatus({
      phase: "offline",
      detail: "another tab hosts this workspace",
      folder,
      lastSyncAt: null,
    });
  } else {
    renderMirrorStatus({ phase: "unlinked", detail: "no desktop server paired", folder: "", lastSyncAt: null });
  }
  wireSyncUi(() => activeSync());

  bootProgress("preparing the workspace…", 25);
  bootStage = "prepareBrowserWorkspace";
  await prepareBrowserWorkspace();
  bootProgress("indexing the workspace…", 55);
  bootStage = "buildFsIndex";
  await buildFsIndex(platform);
  bootProgress("checking the models…", 70);
  bootStage = "ensureModels";
  await ensureModels(platform);
  statusBase = `${seedStatus()} · ${activeProfile}`;
  if (boot.migrated) {
    flashStatus(
      boot.resumed
        ? "finished moving the workspace into the default profile"
        : "moved this browser's workspace into the default profile",
      8000,
    );
  }

  // Periodic two-way git sync (pull then push) for the OPFS workspace.
  if (configuredRemote) {
    const intervalMs =
      Number(localStorage.getItem("autoSyncIntervalMs") ?? "") || DEFAULT_INTERVAL_MS;
    createAutoSync({
      platform,
      remote: () => configuredRemote,
      intervalMs,
      log: (m, r) => console.log(`[auto-sync] ${m}${r?.error ? `: ${r.error}` : ""}`),
    }).start();
  }

  bootProgress("starting the agent…", 80);
  bootStage = "detectPattern";
  const pattern = await detectPattern(platform);
  const agent = new AgentClient(activeProfileSegments);
  archiveAgent = agent;

  // Desktop/server ops: only allowlisted executables leave the worker; the
  // rest keep using the local virtual shell.
  const linked = loadServerLink(activeProfile);
  agent.setOpsHandler(async (command, args) => {
    if (!serverConnection) throw new Error("the desktop/server is not connected");
    const result = await serverConnection.run(command, args);
    if (result.error) throw new Error(result.error);
    return result.output ?? "";
  });
  agent.setOpsConfig({
    enabled: !!serverConnection && (serverConnection.info.exec.length > 0 || !!linked?.exec.length),
    allow: serverConnection?.info.exec ?? linked?.exec ?? [],
  });
  if (serverConnection) {
    (window as unknown as { __bobServer?: unknown }).__bobServer = serverConnection;
  }
  // A paired server may have been offline at boot; keep trying while this tab
  // hosts the workspace. The manual pair dialog is still the recovery path.
  serverRetryTimer = setInterval(() => {
    void connectServerPeer();
  }, 20_000);
  window.addEventListener("pagehide", () => {
    if (serverRetryTimer) clearInterval(serverRetryTimer);
    serverRetryTimer = null;
  });

  // When the admin serves this page, use ITS models.json (and /api/llm proxy)
  // so the browser, the chat UI and Telegram all share one model config.
  bootStage = "servedByAdmin";
  const serverModels = await servedByAdmin();
  if (!serverModels) statusBase += " · standalone";
  const backend = createLocalBackend({
    agent,
    platform,
    env: loadEnv(),
    remote: configuredRemote,
    initialPattern: pattern,
    modelsJson: loadModelsJson(),
    serverModels,
    cdp: configuredCdp,
    beforeTurn,
    telegramUrl: loadTelegramChannel(),
    telegramProfile: () => `opfs:${activeProfile}`,
  });

  // Hand the splash over to the chat app at the same progress, so the bar
  // keeps moving instead of resetting when it mounts and restores the session.
  (window as unknown as { __bobBootFloor?: number }).__bobBootFloor = CHAT_BOOT_FLOOR;
  bootProgress("loading the chat…", CHAT_BOOT_FLOOR);
  hostUi(backend, appEl, { page: "chat", port: 8080 });
  wireWorkspaceTransfer();
  wireProfileUi({
    activeProfile: () => activeProfile,
    registry: () => profileRegistry ?? { version: 1, profiles: [{ name: activeProfile, createdAt: "" }] },
    flash: flashStatus,
    reload: () => location.reload(),
    refreshRegistry: async () => {
      profileRegistry = await loadRegistry();
      publishProfileVisibleApps();
      return profileRegistry ?? { version: 1, profiles: [{ name: activeProfile, createdAt: "" }] };
    },
    applySeedUpdate: (binding, _meta, version) => applyBoundSeedUpdate(binding, version),
    buildActiveArchive,
    importInto: importIntoWorkspace,
    syncMirror: async () => {
      if (!syncHandle) throw new Error("this tab does not host the workspace");
      await syncHandle.engine.reconcile();
    },
    mirrorStatus: () => {
      const bound = mirrorFolder();
      if (!bound) return null;
      return serverConnection
        ? { phase: "idle", detail: "connected", folder: bound, lastSyncAt: new Date().toISOString() }
        : { phase: "offline", detail: "pairing needed", folder: bound, lastSyncAt: null };
    },
  });
  void checkSeedUpdate();
  startSeedWatcher();
  // Persistence may prompt (Firefox) or be denied outright; the status line
  // must not wait on it forever — check the settled result, cap the wait.
  await Promise.race([persistence, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (storageEvictable) statusBase += " · ⚠ storage not persistent";
  showStatus(pattern);
}

main().catch((err) => {
  // Surface the full error (name + stack + failing stage) in the console; the
  // toolbar keeps a one-liner for glanceability. `err.name` matters: browser
  // storage failures come through as DOMExceptions
  // (UnknownError/SecurityError/…), and Gecko's OPFS reports bare
  // "Unknown failure" with no usable stack.
  console.error(`boot failed [stage: ${bootStage}]`, err);
  const label = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  setStatus(`error: ${label} (${bootStage})`);
  bootFailure(`boot failed: ${label} (stage: ${bootStage})`);
});
