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
  normalizeStorageServer,
  saveStorage,
  saveStorageServer,
  type StorageMode,
} from "./settings";
import { importWorkspace } from "./workspace-transfer";
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
function showStatus(pattern: string): void {
  setStatus(`${statusBase} · ${patternLabel(pattern)}`);
}

window.addEventListener("bob:pattern", (event) => {
  const pattern = (event as CustomEvent<{ pattern?: string }>).detail?.pattern;
  if (pattern) showStatus(pattern);
});

const appEl = document.getElementById("app")!;
const storageSelect = document.getElementById("storage-mode") as HTMLSelectElement | null;
const storageServerInput = document.getElementById("storage-server") as HTMLInputElement | null;

if (storageSelect) storageSelect.value = storageMode;
if (storageServerInput) storageServerInput.value = storageServer;

/** Show only the controls that matter for the selected storage backend. */
function configureToolbar(): void {
  if (storageServerInput) storageServerInput.style.display = storageMode === "desktop" ? "" : "none";
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

/** Make sure models.json exists (a mock entry) so the agent can run in OPFS. */
async function ensureModels(target: Platform): Promise<void> {
  const file = target.path.join(target.workspaceRoot, "models.json");
  if (await isFile(file)) return;
  await target.fs.writeFile(
    file,
    JSON.stringify({
      default: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
      strong: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
      cheap: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
    }),
  );
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
  });

  hostUi(backend, appEl, { page: "chat", port: 8080 });
  showStatus(pattern);
}

main().catch((err) => {
  setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
});
