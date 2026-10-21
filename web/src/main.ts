/**
 * Browser target entry point.
 *
 * Renders the *exact* Node admin pages (src/ui/pages.ts) inside an iframe and
 * serves their /api/* calls from an in-browser backend (AgentClient + Platform)
 * via a fetch/EventSource shim. A thin toolbar above the iframe selects the
 * storage backend; everything else — including git sync — is the shared UI.
 *
 * Storage modes:
 *   browser  — OPFS sandbox (offline, seeded from web/public/seed)
 *   desktop  — the loopback storage bridge (any browser, incl. Firefox)
 */
import "./shims/process";
import { setActiveFs, setFsIndex } from "./shims/node-fs-promises";
import { createBrowserPlatform, initSqlite } from "./platform/browser";
import { createDesktopPlatform } from "./platform/desktop";
import { AgentClient } from "./agent/agent-client";
import { createLocalBackend } from "./server/local-backend";
import { hostUi } from "./ui-host";
import {
  loadEnv,
  loadRemote,
  loadStorage,
  loadStorageServer,
  loadModelsJson,
  loadCdp,
  saveCdp,
  normalizeStorageServer,
  saveStorage,
  saveStorageServer,
  type StorageMode,
} from "./settings";
import { buildWorkspaceArchive, archiveToBlob, importWorkspace, validateWorkspaceArchive } from "./workspace-transfer";
import type { WorkspaceArchive } from "./workspace-transfer";
import { cloneWorkspace } from "./platform/git-opfs";
import { applyDatabaseDumps } from "../../src/db-sync";
import { createAutoSync, DEFAULT_INTERVAL_MS } from "../../src/auto-sync";
import { listTreeSources } from "../../src/tree-sources";
import { resolveTreeEntry, scanTreeVersions } from "../../src/tree-versions";
import { patternLabel } from "./agent/pattern-path";
import type { Platform } from "../../src/platform/types";

const params = new URLSearchParams(location.search);
const requestedStorage = params.get("storage");
const storedStorage = loadStorage();
const storageMode: StorageMode =
  requestedStorage === "desktop" || requestedStorage === "browser" ? requestedStorage : storedStorage;
const storageServer = normalizeStorageServer(params.get("server") ?? loadStorageServer());
let configuredRemote = params.get("remote") ?? loadRemote();
// The launcher (`npm run chrome`) opens the app with ?cdp=<browser ws url>;
// persist it so a plain reload keeps the browser tools connected. An explicit
// empty value (BOB_NO_CDP=1) clears a previously persisted socket instead.
const configuredCdp = params.get("cdp") ?? loadCdp();
if (params.has("cdp")) saveCdp(configuredCdp);

const statusEl = document.getElementById("status")!;
const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

/** Storage-specific half of the status line (set once the backend is ready). */
let statusBase: string = storageMode;

/** Days after which the shipped OPFS snapshot is old enough to call out. */
const STALE_SEED_DAYS = 14;

/** `browser · snapshot Oct 3` (+ a hint when the seed has gone stale). */
function seedStatus(): string {
  if (!seedStamp) return "browser";
  const when = new Date(seedStamp);
  if (Number.isNaN(when.getTime())) return "browser";
  const sameYear = when.getFullYear() === new Date().getFullYear();
  const date = when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  });
  const days = Math.floor((Date.now() - when.getTime()) / 86_400_000);
  return days > STALE_SEED_DAYS
    ? `browser · snapshot ${date} · seed stale — regenerate with make-seed`
    : `browser · snapshot ${date}`;
}

/** `desktop: /path · trunk` — pattern switches update this live. */
let activePattern = "";
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(pattern: string): void {
  activePattern = pattern;
  clearTimeout(statusTimer);
  setStatus(`${statusBase} · ${patternLabel(pattern)}`);
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
const storageSelect = document.getElementById("storage-mode") as HTMLSelectElement | null;
const storageServerInput = document.getElementById("storage-server") as HTMLInputElement | null;
const wsTools = document.getElementById("ws-tools");

if (storageSelect) storageSelect.value = storageMode;
if (storageServerInput) storageServerInput.value = storageServer;

/** Show only the controls that matter for the selected storage backend. */
function configureToolbar(): void {
  if (storageServerInput) storageServerInput.style.display = storageMode === "desktop" ? "" : "none";
  // Export/Import act on OPFS; in desktop mode the workspace is the real folder.
  if (wsTools) wsTools.hidden = storageMode !== "browser";
}
configureToolbar();

const applyStorage = (): void => {
  if (storageSelect) saveStorage(storageSelect.value as StorageMode);
  if (storageServerInput) saveStorageServer(storageServerInput.value.trim());
  location.reload();
};
storageSelect?.addEventListener("change", applyStorage);
storageServerInput?.addEventListener("change", applyStorage);

let platform: Platform;

/** The platform selected at boot; all callers share it (and its handles). */
function activePlatform(): Platform {
  return platform;
}

// ── browser (OPFS) workspace preparation ────────────────────────────────
async function isFile(p: string): Promise<boolean> {
  return platform.fs.stat(p).then(() => true).catch(() => false);
}

/** When the OPFS workspace was imported from the shipped seed (ISO), if known. */
let seedStamp: string | null = null;

async function readSeedStamp(marker: string): Promise<string | null> {
  try {
    const raw = (await platform.fs.readFile(marker, "utf8")).trim();
    return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

async function seedWorkspace(root: string): Promise<void> {
  const marker = platform.path.join(root, ".seeded");
  const force = params.has("reseed");
  // The seed's trunk may be a prod snapshot (`trunk.prod.mjs`), not the bare
  // `trunk.mjs` the old seeds shipped; use the version catalog, not a filename.
  const hasTrunk = await resolveTreeEntry(platform.workspaceRoot, "trunk", null)
    .then((entry) => !!entry)
    .catch(() => false);
  if (!force && (await isFile(marker)) && hasTrunk) {
    seedStamp = await readSeedStamp(marker);
    return;
  }
  try {
    const res = await fetch("/seed/workspace.json");
    if (!res.ok) return;
    const archive = (await res.json()) as Parameters<typeof importWorkspace>[0];
    // The archive carries an EMPTY run log (schema only). Never let a reseed
    // overwrite the workspace's real log: it now holds the chat sessions.
    const logDb = platform.path.join(root, "logs", "grandma-kat.db");
    const hasLog = await isFile(logDb);
    const files = hasLog
      ? archive.files.filter((f) => !f.path.startsWith("workspace/logs/"))
      : archive.files;
    await importWorkspace({ ...archive, files });
    const stamp = new Date().toISOString();
    await platform.fs.writeFile(marker, stamp);
    seedStamp = stamp;
  } catch {
    seedStamp = await readSeedStamp(marker);
    /* seed is optional */
  }
}

async function prepareBrowserWorkspace(): Promise<void> {
  const root = "/workspace";
  if (configuredRemote) {
    const gitDir = platform.path.join(root, ".git");
    const hasRepo = await isFile(gitDir);
    if (!hasRepo || params.has("reclone")) {
      setStatus(`cloning ${configuredRemote}…`);
      if (await isFile(root)) await platform.fs.rm(root);
      await cloneWorkspace(root, configuredRemote);
    }
    await applyDatabaseDumps(platform, { onlyMissing: true }).catch((err) => {
      console.warn("database dumps could not be applied:", err);
    });
    setStatus("workspace ready");
    return;
  }
  setStatus("seeding workspace…");
  await seedWorkspace(root);
  await applyDatabaseDumps(platform, { onlyMissing: true }).catch((err) => {
    console.warn("database dumps could not be applied:", err);
  });
  setStatus("workspace ready");
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
    // Use the version catalog, not just editable drafts: a tree that exists
    // only as a prod snapshot (the live workspace's `trunk.prod.mjs`) is
    // runnable and must win over alphabetically-first drafts.
    const catalog = await scanTreeVersions(target.workspaceRoot);
    const ordered = [...catalog].sort((a, b) => a.logical.localeCompare(b.logical));
    const preferred = ordered.find((c) => c.logical === "trunk") ?? ordered[0];
    if (preferred) {
      const entry = await resolveTreeEntry(target.workspaceRoot, preferred.logical, null);
      if (entry) return preferred.logical;
    }
    const sources = await listTreeSources(target.workspaceRoot);
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
async function ensureSeedMarker(): Promise<void> {
  const marker = platform.path.join(platform.workspaceRoot, ".seeded");
  const exists = await platform.fs.stat(marker).then(() => true).catch(() => false);
  if (!exists) await platform.fs.writeFile(marker, new Date().toISOString());
}

function wireWorkspaceTransfer(): void {
  const exportButton = document.getElementById("ws-export") as HTMLButtonElement | null;
  const importButton = document.getElementById("ws-import") as HTMLButtonElement | null;
  const importInput = document.getElementById("ws-import-file") as HTMLInputElement | null;
  if (!exportButton || !importButton || !importInput) return;

  // Smoke hook: the browser smoke drives export/import without a download dialog
  // or a reload. Like `__bobBackend`, it is only a test surface.
  (window as unknown as { __bobWorkspaceTransfer?: unknown }).__bobWorkspaceTransfer = {
    buildWorkspaceArchive,
    archiveToBlob,
    validateWorkspaceArchive,
    importWorkspace,
  };

  exportButton.addEventListener("click", () => {
    void (async () => {
      exportButton.disabled = true;
      importButton.disabled = true;
      const label = exportButton.textContent;
      exportButton.textContent = "exporting…";
      try {
        const archive = await buildWorkspaceArchive();
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
        const written = await importWorkspace(archive);
        await ensureSeedMarker();
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

// ── boot ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (storageMode === "desktop") {
    await initSqlite();
    platform = createDesktopPlatform("/", storageServer);
    setActiveFs(platform.fs);
    await buildFsIndex(platform);
    statusBase = "desktop";
    try {
      const health = await fetch(`${storageServer}/health`).then((r) => r.json());
      statusBase = `desktop: ${health.root}`;
    } catch {
      statusBase = `desktop bridge unreachable at ${storageServer}`;
    }
  } else {
    await initSqlite();
    platform = createBrowserPlatform("/workspace");
    setActiveFs(platform.fs);
    await prepareBrowserWorkspace();
    await buildFsIndex(platform);
    await ensureModels(platform);
    statusBase = seedStatus();
  }

  // Periodic two-way git sync (pull then push) for the OPFS mirror only.
  if (storageMode === "browser" && configuredRemote) {
    const intervalMs =
      Number(localStorage.getItem("autoSyncIntervalMs") ?? "") || DEFAULT_INTERVAL_MS;
    createAutoSync({
      platform,
      remote: () => configuredRemote,
      intervalMs,
      log: (m, r) => console.log(`[auto-sync] ${m}${r?.error ? `: ${r.error}` : ""}`),
    }).start();
  }

  const pattern = await detectPattern(platform);
  const agent = new AgentClient();
  // When the admin serves this page, use ITS models.json (and /api/llm proxy)
  // so the browser, the chat UI and Telegram all share one model config.
  const serverModels = await servedByAdmin();
  if (!serverModels) statusBase += " · standalone";
  const backend = createLocalBackend({
    agent,
    platform,
    storage: storageMode,
    server: storageServer,
    env: loadEnv(),
    remote: configuredRemote,
    initialPattern: pattern,
    modelsJson: loadModelsJson(),
    serverModels,
    cdp: configuredCdp,
  });

  hostUi(backend, appEl, { page: "chat", port: 8080 });
  if (storageMode === "browser") wireWorkspaceTransfer();
  showStatus(pattern);
}

main().catch((err) => {
  setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
});
